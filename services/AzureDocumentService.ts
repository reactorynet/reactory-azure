import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import logger from '@reactory/server-core/logging';
import { Readable } from 'stream';
import { deflateRawSync, inflateRawSync } from 'zlib';
import type ApiError from '@reactory/server-core/exceptions';
import type { AzureTokenSource } from '../types/azure.types';
import {
  DOCX_EXTENSION,
  DOCX_MIME_TYPE,
  DOCX_TEXT_MAX_BYTES,
  PDF_CONVERSION_MAX_BYTES,
  TEXT_EXTRACTION_LIBRARY,
  type IAzureDocumentService,
  type IDocumentConversionStream,
  type IDocumentMetadata,
  type IDocumentReplacementResult,
  type IDocumentRequestOptions,
  type IDocumentTemplateResult,
  type IDocumentText,
} from '../types/document.types';
import type {
  DriveHttpClient,
  IDriveHttpRequest,
  IDriveHttpResponse,
  IDriveItem,
} from '../types/drive.types';
import { GRAPH_BASE_URL } from './graph/AzureGraphClientProvider';
import { GraphErrorCode, apiError, readHeader, toGraphApiError } from '../utils/graph-error';

/**
 * Error codes this service raises itself.
 *
 * Graph's own codes arrive unchanged through `toGraphApiError`. These cover the
 * failures that never reach Graph - most importantly
 * `FileTooLargeForConversion`, which must be decided from metadata *before* a
 * request is issued, because a truncated conversion cannot be detected from the
 * stream afterwards.
 */
export const DOCUMENT_ERROR_CODES = {
  /** The item is not an OOXML `.docx` (a PDF, a legacy `.doc`, a folder, ...). */
  INVALID_DOCUMENT_FORMAT: 'InvalidDocumentFormat',
  /** Above Graph's 2 MB conversion ceiling - rejected without any request. */
  FILE_TOO_LARGE_FOR_CONVERSION: 'FileTooLargeForConversion',
  /** Graph reported no usable `size`, so the conversion ceiling cannot be checked. */
  DOCUMENT_SIZE_UNAVAILABLE: 'DocumentSizeUnavailable',
  /** Too large to unzip in memory for text extraction. */
  DOCUMENT_TOO_LARGE_FOR_TEXT: 'DocumentTooLargeForTextExtraction',
  /** Graph returned an empty or non-PDF body for a conversion. */
  DOCUMENT_CONVERSION_FAILED: 'DocumentConversionFailed',
  /** The requested file name cannot be used for a new document. */
  INVALID_DOCUMENT_NAME: 'InvalidDocumentName',
  /** A template replacement token is empty or not a string value. */
  INVALID_TEMPLATE_REPLACEMENT: 'InvalidTemplateReplacement',
  /** Graph accepted the template copy but never reported a new item id. */
  DOCUMENT_COPY_INCOMPLETE: 'DocumentCopyIncomplete',
  /** The item's container is unknown, so a same-name replacement cannot be addressed. */
  DOCUMENT_PARENT_UNAVAILABLE: 'DocumentParentUnavailable',
  /** A download for extraction returned zero bytes. */
  EMPTY_DOCUMENT_CONTENT: 'EmptyDocumentContent',
  /** The bytes are not a readable OOXML zip archive. */
  INVALID_DOCX_ARCHIVE: 'InvalidDocxArchive',
  /** A redirect carried no `Location`. */
  INVALID_DOCUMENT_REDIRECT: 'InvalidDocumentRedirect',
} as const;

/** Graph's v1.0 root. The SDK prepends this itself; the raw transport must be told. */
const GRAPH_V1 = `${GRAPH_BASE_URL}/v1.0`;

/** Cap on an error body read from the raw transport. */
const RAW_BODY_LIMIT = 1024 * 1024;

/** Statuses that can carry a `Location` to a pre-authenticated URL. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The only part of a `.docx` this service reads and rewrites. */
const DOCUMENT_PART = 'word/document.xml';

/** What `getDocumentMetadata` asks Graph for. */
const DOCUMENT_SELECT = [
  'id',
  'name',
  'size',
  'webUrl',
  'createdDateTime',
  'lastModifiedDateTime',
  'createdBy',
  'lastModifiedBy',
  'parentReference',
  'file',
];

/** The fidelity statement returned with extracted text. */
const TEXT_FIDELITY_LIMITS = [
  'Reads only word/document.xml: headers and footers (word/header*.xml, word/footer*.xml) are not extracted.',
  'Footnotes and endnotes (word/footnotes.xml, word/endnotes.xml) are not extracted.',
  'Content controls, comments, tracked-change deletions and text boxes are not reproduced verbatim; text inside a text box may be missing or out of reading order.',
  'Formatting, tables, images and fields are lost: this is plain text, not a rendering of the document.',
];

/** The slice of `AzureGraphClientProvider` this service calls. */
interface IDocumentGraphProvider {
  request<T>(userId: string, path: string, options?: Record<string, unknown>): Promise<T>;
}

/** The slice of `AzureDriveService` this service calls. */
interface IDocumentDriveService {
  downloadItem(
    userId: string,
    itemId: string,
    options?: { driveId?: string; fileName?: string },
  ): Promise<{
    stream: Readable;
    contentType?: string;
    contentLength?: number;
    contentDisposition?: string;
    fileName?: string;
  }>;
  copyItem(
    userId: string,
    itemId: string,
    parentId: string,
    options?: { driveId?: string; name?: string; wait?: boolean; pollIntervalMs?: number },
  ): Promise<{ status: string; itemId?: string; item?: IDriveItem }>;
  uploadItem(
    userId: string,
    parentId: string | null,
    fileName: string,
    content: Buffer | string,
    options?: {
      driveId?: string;
      contentType?: string;
      conflictBehavior?: 'rename' | 'replace' | 'fail';
    },
  ): Promise<IDriveItem>;
}

/** The slice of `AzureAuthService` used by the binary hop. */
interface IDocumentAuthService {
  getToken(userId: string): Promise<{ token: string; source?: AzureTokenSource }>;
}

/**
 * The production transport: `fetch` with an explicit redirect policy.
 *
 * Graph answers `/content?format=pdf` with a 302 to a pre-authenticated storage
 * URL, so the first hop must stop (`redirect: 'manual'`) and the second must be
 * made with **no** `Authorization` header. Following the redirect blindly would
 * hand the user's Graph bearer token to the storage host.
 */
const defaultDocumentHttpClient: DriveHttpClient = async (request: IDriveHttpRequest) => {
  const fetchImpl: any = (globalThis as any).fetch;

  if (typeof fetchImpl !== 'function') {
    throw apiError(
      GraphErrorCode.GRAPH_REQUEST_FAILED,
      'No fetch implementation is available for document byte transfers',
    );
  }

  const init: Record<string, unknown> = {
    method: request.method,
    headers: request.headers || {},
    redirect: request.redirect === 'manual' ? 'manual' : 'follow',
  };

  if (request.body !== undefined) init.body = request.body;

  const response: any = await fetchImpl(request.url, init);

  const headers: Record<string, string> = {};
  if (response?.headers && typeof response.headers.forEach === 'function') {
    response.headers.forEach((value: string, key: string) => {
      headers[String(key).toLowerCase()] = String(value);
    });
  }

  return {
    status: Number(response?.status) || 0,
    headers,
    body: response?.body ?? undefined,
  };
};

/**
 * The active transport. Replaced in tests, which is why the seam exists: this
 * repository has no Azure tenant, so no live Graph call may be made.
 *
 * It is separate from `AzureDriveService`'s transport on purpose: a conversion is
 * a different request (`?format=pdf`) with a different failure contract (a
 * truncated or empty body is a failure, not a result), and a test must be able to
 * prove that an over-limit conversion issues **zero** requests.
 */
let activeDocumentHttpClient: DriveHttpClient = defaultDocumentHttpClient;

/** Install a transport for document byte transfers; `null` restores `fetch`. */
export function setDocumentHttpClient(client?: DriveHttpClient | null): void {
  activeDocumentHttpClient = client || defaultDocumentHttpClient;
}

/** The active document byte-transfer transport. */
export function getDocumentHttpClient(): DriveHttpClient {
  return activeDocumentHttpClient;
}

/** `Readable.from` behind a typed alias (this repo pins a `@types/node` without it). */
const readableFrom: (source: any) => Readable = (Readable as any).from.bind(Readable);

// ---------------------------------------------------------------------------
// OOXML (.docx) container support
//
// A `.docx` is a zip archive. Text extraction and token substitution need two
// things and no more: read one part out of the archive, put it back unchanged
// apart from the substituted runs. Node's `zlib` does the DEFLATE; the rest is
// the (small) subset of the zip format Office writes.
// ---------------------------------------------------------------------------

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;

/** A `.docx` entry, as read from the central directory. */
export interface IDocxEntry {
  name: string;
  data: Buffer;
}

/** CRC-32 (the polynomial zip uses), computed lazily once. */
let crcTable: Uint32Array | null = null;

function crc32(buffer: Buffer): number {
  if (!crcTable) {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[i] = value >>> 0;
    }
    crcTable = table;
  }

  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/** Locate the end-of-central-directory record (it is the last 22+ bytes). */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const floor = Math.max(0, buffer.length - 0xffff - 22);

  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset;
  }

  return -1;
}

/**
 * True when the bytes look like an OOXML Word document.
 *
 * Checks the zip magic and the presence of the main document part's name. It is
 * deliberately cheap - a full parse follows - and it is the guard that stops a
 * PDF or a JPEG being uploaded as a replacement `.docx`.
 */
export function looksLikeDocx(buffer: Buffer): boolean {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false; // "PK"

  return buffer.indexOf(Buffer.from(DOCUMENT_PART, 'utf8')) >= 0;
}

/** Read every entry of a `.docx` archive, honouring stored and deflated entries. */
export function readDocxEntries(buffer: Buffer): IDocxEntry[] {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw apiError(
      DOCUMENT_ERROR_CODES.INVALID_DOCX_ARCHIVE,
      'The supplied document is not a zip archive; a .docx is required',
      { size: Buffer.isBuffer(buffer) ? buffer.length : 0 },
    );
  }

  const eocd = findEndOfCentralDirectory(buffer);

  if (eocd < 0) {
    throw apiError(
      DOCUMENT_ERROR_CODES.INVALID_DOCX_ARCHIVE,
      'The supplied document has no zip end-of-central-directory record; a .docx is required',
      { size: buffer.length },
    );
  }

  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  let cursor = buffer.readUInt32LE(eocd + 16);

  if (count === 0xffff || centralSize === 0xffffffff || cursor === 0xffffffff) {
    throw apiError(
      DOCUMENT_ERROR_CODES.INVALID_DOCX_ARCHIVE,
      'Zip64 documents are not supported for text extraction or token substitution',
      { size: buffer.length },
    );
  }

  const entries: IDocxEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw apiError(
        DOCUMENT_ERROR_CODES.INVALID_DOCX_ARCHIVE,
        `Corrupt zip central directory at entry ${index}`,
        { size: buffer.length },
      );
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (flags & 0x1) {
      throw apiError(
        DOCUMENT_ERROR_CODES.INVALID_DOCX_ARCHIVE,
        'Encrypted zip entries are not supported',
        { entry: name },
      );
    }

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
      throw apiError(
        DOCUMENT_ERROR_CODES.INVALID_DOCX_ARCHIVE,
        `Corrupt zip local header for entry "${name}"`,
        { entry: name },
      );
    }

    // The *local* header carries its own name/extra lengths; the central
    // directory's values may differ because Office adds alignment padding.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = inflateRawSync(raw);
    } else {
      throw apiError(
        DOCUMENT_ERROR_CODES.INVALID_DOCX_ARCHIVE,
        `Unsupported zip compression method ${method} for entry "${name}"`,
        { entry: name, method },
      );
    }

    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Rebuild a zip archive from entries.
 *
 * Every entry keeps its position; text parts are DEFLATE-compressed and parts
 * that do not shrink are stored, so nothing is ever inflated by rewriting. This
 * is what lets `createFromTemplate` edit `word/document.xml` while leaving every
 * other part of the template - styles, images, numbering, relationships - byte
 * identical.
 */
export function writeDocxEntries(entries: IDocxEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data);
    const stored = deflated.length >= entry.data.length;
    const payload = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags: sizes are known, no data descriptor
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date: 1980-01-01
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0x21, 14); // mod date
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset

    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralDirectory, eocd]);
}

// ---------------------------------------------------------------------------
// WordprocessingML text
// ---------------------------------------------------------------------------

/** Decode the five XML entities and numeric character references. */
export function decodeXmlEntities(value: string): string {
  const codePoint = (raw: string, radix: number): string => {
    const parsed = parseInt(raw, radix);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0x10ffff) return '';

    try {
      return String.fromCodePoint(parsed);
    } catch {
      return '';
    }
  };

  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => codePoint(hex, 16))
    .replace(/&#(\d+);/g, (_match, dec: string) => codePoint(dec, 10))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Escape text for insertion into an XML text node. `&` must go first. */
export function escapeXmlText(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Extract the plain text of `word/document.xml`.
 *
 * Word splits a sentence into `<w:r>` runs and stores the characters in
 * `<w:t>`; paragraphs are `</w:p>`, tabs `<w:tab/>`, line breaks `<w:br/>` and
 * table cells `</w:tc>`. Those five markers are the whole of the structure this
 * reader needs. Everything else is markup and is discarded.
 */
export function extractTextFromDocumentXml(xml: string): string {
  const withBreaks = String(xml ?? '')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<w:cr\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, '\t');

  const text = decodeXmlEntities(withBreaks.replace(/<[^>]*>/g, ''));

  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** One `<w:t>` run inside a paragraph, with the offsets of its inner text. */
interface ITextRun {
  openTag: string;
  raw: string;
  innerStart: number;
  innerEnd: number;
}

/** Replace every occurrence of every token in `text`. */
function substituteTokens(
  text: string,
  replacements: Record<string, string>,
  applied: Set<string>,
): string {
  let output = text;

  for (const token of Object.keys(replacements)) {
    if (!token || !output.includes(token)) continue;

    applied.add(token);
    output = output.split(token).join(replacements[token]);
  }

  return output;
}

/** Ensure a `<w:t>` keeps significant leading/trailing spaces. */
function preserveSpace(openTag: string, text: string): string {
  if (!/^[\s]|[\s]$/.test(text) || /xml:space=/.test(openTag)) return openTag;

  return openTag.replace(/^<w:t\b/, '<w:t xml:space="preserve"');
}

/**
 * Replace literal tokens in one `<w:p>` paragraph.
 *
 * Word routinely splits a token across runs ("{{na" + "me}}") as soon as
 * spell-check, a language change or a formatting boundary intervenes, so a
 * per-run replacement alone would silently miss those tokens. Two passes:
 *
 *  1. Replace inside each run. When that reproduces exactly what a
 *     paragraph-level replacement would produce, the run formatting is preserved
 *     untouched - the common case.
 *  2. Otherwise collapse the paragraph's text into its first run and empty the
 *     rest. That guarantees the token is replaced; the cost is that mixed
 *     formatting *within that one paragraph* follows the first run.
 */
function substituteInParagraph(
  paragraph: string,
  replacements: Record<string, string>,
  applied: Set<string>,
): string {
  const runs: ITextRun[] = [];
  const matcher = /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(paragraph)) !== null) {
    const openTagEnd = match[0].indexOf('>') + 1;
    const innerStart = match.index + openTagEnd;

    runs.push({
      openTag: match[0].slice(0, openTagEnd),
      raw: match[2],
      innerStart,
      innerEnd: innerStart + match[2].length,
    });
  }

  if (!runs.length) return paragraph;

  const texts = runs.map((run) => decodeXmlEntities(run.raw));
  const concatenated = texts.join('');

  if (!Object.keys(replacements).some((token) => token && concatenated.includes(token))) {
    return paragraph;
  }

  const perRun = texts.map((text) => substituteTokens(text, replacements, applied));
  const wholeParagraph = substituteTokens(concatenated, replacements, applied);
  const collapse = perRun.join('') !== wholeParagraph;

  let output = '';
  let cursor = 0;

  runs.forEach((run, index) => {
    const text = collapse ? (index === 0 ? wholeParagraph : '') : perRun[index];
    const prefix = paragraph.slice(cursor, run.innerStart);
    // `prefix` ends with the run's own `<w:t …>` tag, copied verbatim; only the
    // tag attached to text that keeps significant whitespace is adjusted.
    const beforeTag = prefix.slice(0, prefix.length - run.openTag.length);

    output += beforeTag;
    output += preserveSpace(run.openTag, text);
    output += escapeXmlText(text);
    cursor = run.innerEnd;
  });

  return output + paragraph.slice(cursor);
}

/**
 * Substitute literal tokens in a WordprocessingML document part.
 *
 * Returns the rewritten XML plus the tokens actually found. A token that never
 * appears is *not* silently ignored: it is reported back to the caller as
 * `missing`, because the usual cause - a token split across runs, or a token
 * that lives in a header rather than the body - is something a caller can act on.
 */
export function applyTokensToDocumentXml(
  xml: string,
  replacements: Record<string, string>,
): { xml: string; applied: string[]; missing: string[] } {
  const applied = new Set<string>();

  const rewritten = String(xml ?? '').replace(
    /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g,
    (paragraph) => substituteInParagraph(paragraph, replacements, applied),
  );

  const supplied = Object.keys(replacements).filter((token) => Boolean(token));

  return {
    xml: rewritten,
    applied: supplied.filter((token) => applied.has(token)),
    missing: supplied.filter((token) => !applied.has(token)),
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * `azure.AzureDocumentService@1.0.0` - what Azure can honestly do with Word
 * documents, and an explicit refusal of what it cannot.
 *
 * ## Audit §7 G1: there is no server-side Word body-editing API
 *
 * > "There is **no server-side Word body-editing API**. The Office JS API
 * > requires an Office Add-in running *inside* the document. There is no Graph
 * > equivalent of Google Docs `batchUpdate`."
 * > - audit §7, gap G1
 *
 * This is a statement about the platform, not about effort. Microsoft Graph can
 * upload, copy, convert and download a `.docx`; it cannot address a paragraph, a
 * table cell or a run. The only APIs that can edit a document body run inside
 * Word itself, in an add-in, against a document the user has open. Inventing a
 * `batchUpdate`-shaped method here would produce something that either rewrites
 * the entire file as opaque bytes (which is `replaceDocument`) or pretends to
 * have edited a document it never touched. So this class deliberately does not
 * have one, and no method is named `batchUpdate`.
 *
 * ## What this service delivers instead
 *
 *  - {@link createFromTemplate} - copy the template, substitute literal token
 *    text in `word/document.xml`, keep every other part byte identical.
 *  - {@link getDocumentText} - download the `.docx` and extract plain text.
 *  - {@link convertToPdf} - Graph's `?format=pdf` conversion, capped at 2 MB and
 *    refused *before* the request when the file is larger.
 *  - {@link replaceDocument} - upload a whole replacement `.docx`.
 *  - {@link getDocumentMetadata} - size, last editor, created time, `webUrl`.
 *
 * ## Text extraction: the library and its fidelity limits
 *
 * Extraction is {@link TEXT_EXTRACTION_LIBRARY}: a reader for the
 * WordprocessingML part (`word/document.xml`), with the zip container handled by
 * Node's built-in `zlib` (`inflateRaw`). No third-party parser and no network
 * access are involved, so the same bytes always produce the same text.
 *
 * The limits are real and are returned with every result:
 * **headers and footers, footnotes and endnotes, comments, tracked-change
 * deletions and text boxes may be lost**, and all formatting, tables, images and
 * fields are reduced to plain text. A caller that needs the complete document
 * must convert it (PDF) or read it in Word.
 *
 * ## If higher fidelity is genuinely required
 *
 * Three extraction alternatives exist, each with a cost:
 *
 *  1. **Server-side `.docx` parser** (e.g. `mammoth`, which this server already
 *     depends on, or a dedicated OOXML walker). Cost: it still cannot edit the
 *     body, only read it better - and it adds a parser dependency plus the
 *     fidelity *its* mapping chooses.
 *  2. **Office Add-in** (the Office JS API). Cost: it only runs inside a document
 *     the user has open in Word (web or desktop), needs add-in deployment,
 *     manifest and tenant consent, and cannot be driven headless by the server.
 *     This is the only path that gives true structural editing.
 *  3. **Beta `documentProcessingJob`** (Graph preview). Cost: preview API with no
 *     stability guarantee, tenant-gated, asynchronous with polling, and a
 *     different response shape from the v1.0 surface this module targets.
 *
 * None of them removes the reason this class has no body-editing method: Graph
 * has no such endpoint.
 */
@service({
  id: 'azure.AzureDocumentService@1.0.0',
  name: 'AzureDocumentService',
  nameSpace: 'azure',
  version: '1.0.0',
  description:
    'Word documents over Microsoft Graph - template copy with text substitution, .docx text extraction, 2 MB-capped PDF conversion and whole-file replacement',
  serviceType: 'data',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'azure.AzureDriveService@1.0.0', alias: 'driveService' },
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphProvider' },
    { id: 'azure.AzureAuthService@1.0.0', alias: 'authService' },
  ],
})
class AzureDocumentService implements IAzureDocumentService, Reactory.Service.IReactoryService {
  name: string = 'AzureDocumentService';
  nameSpace: string = 'azure';
  version: string = '1.0.0';
  context: Reactory.Server.IReactoryContext;

  private _driveService: any;
  private _graphProvider: any;
  private _authService: any;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext,
  ) {
    this.context = context;
  }

  /** Bound by the Reactory service container from the `driveService` dependency alias. */
  setDriveService(serviceInstance: any): void {
    this._driveService = serviceInstance;
  }

  /** Bound by the Reactory service container from the `graphProvider` dependency alias. */
  setGraphProvider(serviceInstance: any): void {
    this._graphProvider = serviceInstance;
  }

  /** Bound by the Reactory service container from the `authService` dependency alias. */
  setAuthService(serviceInstance: any): void {
    this._authService = serviceInstance;
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  /**
   * `GET /me/drive/items/{itemId}` projected onto the document fields.
   *
   * `size` is not incidental: it is the value {@link convertToPdf} enforces the
   * 2 MB conversion ceiling against, and it is read here - before any conversion
   * request - precisely so an over-limit document issues no request at all.
   */
  async getDocumentMetadata(
    userId: string,
    itemId: string,
    options: IDocumentRequestOptions = {},
  ): Promise<IDocumentMetadata> {
    const uid = this.resolveUserId(userId);
    const item = await this.requestJson<any>(uid, this.itemPath(itemId, options), {
      operation: 'document.getDocumentMetadata',
      select: DOCUMENT_SELECT,
    });

    if (!item || !item.id) {
      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        'Microsoft Graph returned no drive item for document.getDocumentMetadata',
        { operation: 'document.getDocumentMetadata', itemId },
      );
    }

    return {
      itemId: String(item.id),
      name: item.name,
      size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : undefined,
      mimeType: item.file?.mimeType,
      webUrl: item.webUrl,
      createdDateTime: item.createdDateTime,
      lastModifiedDateTime: item.lastModifiedDateTime,
      createdBy: item.createdBy?.user,
      lastModifiedBy: item.lastModifiedBy?.user,
      parentId: item.parentReference?.id,
    };
  }

  // -------------------------------------------------------------------------
  // Text extraction
  // -------------------------------------------------------------------------

  /**
   * Download a `.docx` and return its plain text.
   *
   * The format check happens **before** the download: a PDF, a legacy `.doc` or
   * a folder is rejected with `InvalidDocumentFormat` rather than being streamed
   * into memory and returned as mojibake. Extraction then reads the
   * WordprocessingML part out of the zip - see the class documentation for the
   * library and its fidelity limits, which are also returned with the text.
   */
  async getDocumentText(
    userId: string,
    itemId: string,
    options: IDocumentRequestOptions = {},
  ): Promise<IDocumentText> {
    const uid = this.resolveUserId(userId);
    const metadata = await this.getDocumentMetadata(uid, itemId, options);

    this.assertDocx(metadata, 'document.getDocumentText');

    const bytes = await this.readDocumentBytes(uid, itemId, options, DOCX_TEXT_MAX_BYTES);
    const entries = readDocxEntries(bytes);
    const part = entries.find((entry) => entry.name === DOCUMENT_PART);

    if (!part) {
      throw apiError(
        DOCUMENT_ERROR_CODES.INVALID_DOCX_ARCHIVE,
        `The document contains no ${DOCUMENT_PART} part; it is not a Word document`,
        { itemId, name: metadata.name },
      );
    }

    const text = extractTextFromDocumentXml(part.data.toString('utf8'));

    return {
      itemId,
      name: metadata.name,
      text,
      library: TEXT_EXTRACTION_LIBRARY,
      fidelity: [...TEXT_FIDELITY_LIMITS],
      characters: text.length,
    };
  }

  // -------------------------------------------------------------------------
  // PDF conversion
  // -------------------------------------------------------------------------

  /**
   * Convert a Word document to PDF via `GET …/content?format=pdf`.
   *
   * Two hard rules, both from Graph's documentation:
   *
   *  1. **The conversion endpoint is capped at 2 MB per file.** The size is read
   *     from {@link getDocumentMetadata} first; above
   *     {@link PDF_CONVERSION_MAX_BYTES} this throws
   *     `ApiError('FileTooLargeForConversion', { size, limit })` and issues **no
   *     request**. Graph's failure mode above the cap is not a clean error - a
   *     truncated body is indistinguishable from a complete PDF once it is a
   *     stream, so the decision has to be made before the request.
   *  2. **Only documented format pairs are supported.** Graph converts
   *     `docx`/`doc` → `pdf` (and `xlsx`/`pptx` → `pdf`); there is no generic
   *     "render anything" conversion. This method is the Word → PDF path.
   *
   * The response is never returned if it is empty or claims to exceed the cap:
   * an empty stream is a failure, not a result.
   */
  async convertToPdf(
    userId: string,
    itemId: string,
    options: IDocumentRequestOptions = {},
  ): Promise<IDocumentConversionStream> {
    const uid = this.resolveUserId(userId);

    // Pre-flight: metadata only. No conversion request may be issued for a
    // document we already know Graph will refuse.
    const metadata = await this.getDocumentMetadata(uid, itemId, options);
    const size = metadata.size;

    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      throw apiError(
        DOCUMENT_ERROR_CODES.DOCUMENT_SIZE_UNAVAILABLE,
        'Microsoft Graph did not report a file size, so the 2 MB PDF conversion ceiling cannot be '
          + 'verified. Nothing was requested: an unverifiable conversion could return a truncated PDF.',
        { itemId, name: metadata.name },
      );
    }

    if (size > PDF_CONVERSION_MAX_BYTES) {
      throw apiError(
        DOCUMENT_ERROR_CODES.FILE_TOO_LARGE_FOR_CONVERSION,
        `"${metadata.name || itemId}" is ${size} bytes. Microsoft Graph converts at most `
          + `${PDF_CONVERSION_MAX_BYTES} bytes (2 MB) per file to PDF, so no conversion request was made.`,
        { itemId, name: metadata.name, size, limit: PDF_CONVERSION_MAX_BYTES },
      );
    }

    this.assertDocx(metadata, 'document.convertToPdf', { allowLegacyDoc: true });

    const path = `${this.itemPath(itemId, options)}/content?format=pdf`;
    const conversion = await this.fetchBinary(uid, path, 'document.convertToPdf');

    if (conversion.contentLength === 0) {
      await this.discard(conversion.stream);

      throw apiError(
        DOCUMENT_ERROR_CODES.DOCUMENT_CONVERSION_FAILED,
        'Microsoft Graph returned an empty PDF conversion; refusing to return an empty stream',
        { itemId, name: metadata.name, operation: 'document.convertToPdf' },
      );
    }

    if (
      typeof conversion.contentLength === 'number'
      && conversion.contentLength > PDF_CONVERSION_MAX_BYTES
    ) {
      await this.discard(conversion.stream);

      throw apiError(
        DOCUMENT_ERROR_CODES.FILE_TOO_LARGE_FOR_CONVERSION,
        `The PDF conversion reported ${conversion.contentLength} bytes, above the `
          + `${PDF_CONVERSION_MAX_BYTES}-byte (2 MB) conversion ceiling.`,
        {
          itemId,
          name: metadata.name,
          size: conversion.contentLength,
          limit: PDF_CONVERSION_MAX_BYTES,
        },
      );
    }

    return {
      itemId,
      format: 'pdf',
      stream: conversion.stream,
      contentType: conversion.contentType,
      contentLength: conversion.contentLength,
    };
  }

  // -------------------------------------------------------------------------
  // Template copy + text substitution
  // -------------------------------------------------------------------------

  /**
   * Copy a `.docx` template and substitute literal token text.
   *
   * **This is text substitution, not structural editing.** The new document is a
   * byte-for-byte copy of the template with literal token strings replaced inside
   * `word/document.xml`; every other part (styles, numbering, images,
   * relationships) is written back untouched, and no paragraph, table, image or
   * field is created or removed. That is exactly the capability Microsoft Graph
   * offers, and the result says so in its `mode: 'text-substitution'`.
   *
   * A token Word has split across runs (`{{na` + `me}}`) is still replaced: the
   * paragraph's text is collapsed into its first run when a per-run replacement
   * cannot reproduce the paragraph-level result. The cost is that mixed
   * formatting *within that paragraph* follows the first run. Tokens in headers,
   * footers or footnotes are not touched - those parts are not rewritten - and
   * are reported in `missing`.
   */
  async createFromTemplate(
    userId: string,
    templateItemId: string,
    name: string,
    replacements: Record<string, string>,
    options: IDocumentRequestOptions = {},
  ): Promise<IDocumentTemplateResult> {
    const uid = this.resolveUserId(userId);
    const safeReplacements = this.validateReplacements(replacements);
    const documentName = this.normalizeDocumentName(name, 'document.createFromTemplate');

    const template = await this.getDocumentMetadata(uid, templateItemId, options);
    this.assertDocx(template, 'document.createFromTemplate');

    if (!template.parentId) {
      throw apiError(
        DOCUMENT_ERROR_CODES.DOCUMENT_PARENT_UNAVAILABLE,
        'Microsoft Graph did not report the template\'s parent folder, so a copy cannot be addressed',
        { itemId: templateItemId, name: template.name },
      );
    }

    const drive = this.driveService;
    const copy = await drive.copyItem(uid, templateItemId, template.parentId, {
      driveId: options.driveId,
      name: documentName,
      wait: true,
    });

    if (!copy || copy.status !== 'completed' || !copy.itemId) {
      throw apiError(
        DOCUMENT_ERROR_CODES.DOCUMENT_COPY_INCOMPLETE,
        'Microsoft Graph accepted the template copy but has not reported a new item id; '
          + 'the copy is still in progress and no substitution was applied',
        { templateItemId, name: documentName, status: copy?.status },
      );
    }

    const copyId = String(copy.itemId);
    // Graph resolves a name collision on copy by renaming ("Invoice 1.docx").
    // Addressing the substitution upload with the *copied* name is what makes it
    // a replacement of this copy rather than a second, unrelated file.
    const copiedName = copy.item?.name || documentName;
    const bytes = await this.readDocumentBytes(uid, copyId, options, DOCX_TEXT_MAX_BYTES);
    const entries = readDocxEntries(bytes);
    const partIndex = entries.findIndex((entry) => entry.name === DOCUMENT_PART);

    if (partIndex < 0) {
      throw apiError(
        DOCUMENT_ERROR_CODES.INVALID_DOCX_ARCHIVE,
        `The template contains no ${DOCUMENT_PART} part; it is not a Word document`,
        { templateItemId, name: template.name },
      );
    }

    const originalXml = entries[partIndex].data.toString('utf8');
    const substituted = applyTokensToDocumentXml(originalXml, safeReplacements);

    entries[partIndex] = { name: DOCUMENT_PART, data: Buffer.from(substituted.xml, 'utf8') };

    const updated = writeDocxEntries(entries);
    const uploaded = await drive.uploadItem(uid, template.parentId, copiedName, updated, {
      driveId: options.driveId,
      contentType: DOCX_MIME_TYPE,
      conflictBehavior: 'replace',
    });

    logger.debug(
      `AzureDocumentService: created "${copiedName}" from template ${templateItemId} `
        + `(${substituted.applied.length} token(s) replaced, ${substituted.missing.length} missing)`,
    );

    return {
      itemId: String(uploaded?.id || copyId),
      name: uploaded?.name || copiedName,
      webUrl: uploaded?.webUrl,
      size: typeof uploaded?.size === 'number' ? uploaded.size : updated.length,
      templateItemId,
      mode: 'text-substitution',
      applied: substituted.applied,
      missing: substituted.missing,
    };
  }

  // -------------------------------------------------------------------------
  // Whole-file replacement
  // -------------------------------------------------------------------------

  /**
   * Replace a document's entire contents with a supplied `.docx`.
   *
   * This is the honest form of "update a Word document": Graph has no body
   * editing, so the caller supplies the complete file and the bytes are replaced.
   * The content is validated as OOXML (zip magic + a `word/document.xml` part)
   * before upload, so a PDF or a JPEG cannot be written over a `.docx`.
   */
  async replaceDocument(
    userId: string,
    itemId: string,
    content: Buffer | Uint8Array,
    options: IDocumentRequestOptions = {},
  ): Promise<IDocumentReplacementResult> {
    const uid = this.resolveUserId(userId);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content ?? []);

    if (!bytes.length) {
      throw apiError(
        DOCUMENT_ERROR_CODES.EMPTY_DOCUMENT_CONTENT,
        'A replacement .docx is required; the supplied content is empty',
        { itemId },
      );
    }

    if (!looksLikeDocx(bytes)) {
      throw apiError(
        DOCUMENT_ERROR_CODES.INVALID_DOCUMENT_FORMAT,
        'The replacement content is not an OOXML .docx archive (no zip signature or no '
          + `word/document.xml part). Expected ${DOCX_MIME_TYPE}.`,
        { itemId, size: bytes.length, expected: [DOCX_EXTENSION, DOCX_MIME_TYPE] },
      );
    }

    const metadata = await this.getDocumentMetadata(uid, itemId, options);
    this.assertDocx(metadata, 'document.replaceDocument');

    if (!metadata.parentId || !metadata.name) {
      throw apiError(
        DOCUMENT_ERROR_CODES.DOCUMENT_PARENT_UNAVAILABLE,
        'Microsoft Graph did not report the document\'s parent folder and name, so a replacement '
          + 'cannot be addressed',
        { itemId, name: metadata.name },
      );
    }

    const uploaded = await this.driveService.uploadItem(
      uid,
      metadata.parentId,
      metadata.name,
      bytes,
      {
        driveId: options.driveId,
        contentType: DOCX_MIME_TYPE,
        conflictBehavior: 'replace',
      },
    );

    return {
      itemId: String(uploaded?.id || itemId),
      name: uploaded?.name || metadata.name,
      webUrl: uploaded?.webUrl || metadata.webUrl,
      size: typeof uploaded?.size === 'number' ? uploaded.size : bytes.length,
    };
  }

  // -------------------------------------------------------------------------
  // Validation and Graph plumbing
  // -------------------------------------------------------------------------

  /** The drive service, bound by the container or resolved from the request context. */
  private get driveService(): IDocumentDriveService {
    const drive = (this._driveService
      || this.context?.getService?.('azure.AzureDriveService@1.0.0')) as IDocumentDriveService | undefined;

    if (!drive) {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        'The Azure Drive Service is not available; document byte transfer cannot be performed',
        { operation: 'document.getDriveService' },
      );
    }

    return drive;
  }

  /** The provider, bound by the container or resolved from the request context. */
  private get provider(): IDocumentGraphProvider {
    const provider = (this._graphProvider
      || this.context?.getService?.('azure.AzureGraphClientProvider@1.0.0')) as IDocumentGraphProvider | undefined;

    if (!provider) {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        'The Azure Graph Client Provider is not available',
        { operation: 'document.getProvider' },
      );
    }

    return provider;
  }

  /** The auth service, used only for the binary hop. */
  private get authService(): IDocumentAuthService | undefined {
    return (this._authService
      || this.context?.getService?.('azure.AzureAuthService@1.0.0')) as IDocumentAuthService | undefined;
  }

  /** A `userId` is mandatory; fall back to the request context when omitted. */
  private resolveUserId(userId?: string): string {
    const uid = String(userId || (this.context as any)?.user?._id || '');

    if (!uid) {
      throw apiError(GraphErrorCode.NOT_CONNECTED, 'A userId is required for a document operation', {
        operation: 'document.resolveUserId',
      });
    }

    return uid;
  }

  /** `/me/drive` or `/drives/{driveId}`. */
  private driveBase(options?: IDocumentRequestOptions): string {
    return options?.driveId
      ? `/drives/${encodeURIComponent(String(options.driveId))}`
      : '/me/drive';
  }

  /** `…/items/{itemId}` - the id is a single path segment, so it is fully encoded. */
  private itemPath(itemId: string, options?: IDocumentRequestOptions): string {
    if (!itemId) {
      throw apiError(GraphErrorCode.GRAPH_REQUEST_FAILED, 'A drive itemId is required', {
        operation: 'document.itemPath',
      });
    }

    return `${this.driveBase(options)}/items/${encodeURIComponent(String(itemId))}`;
  }

  /** One GET through the provider (retry and error translation live there). */
  private async requestJson<T>(
    userId: string,
    path: string,
    options: Record<string, unknown> = {},
  ): Promise<T> {
    const operation = String(options.operation || 'document.request');

    try {
      return await this.provider.request<T>(userId, path, options) as T;
    } catch (error) {
      throw this.translate(error, operation);
    }
  }

  /** Validate the token map: non-empty keys, string values. */
  private validateReplacements(replacements: Record<string, string>): Record<string, string> {
    const source = replacements && typeof replacements === 'object' ? replacements : {};

    for (const [token, value] of Object.entries(source)) {
      if (!token || !token.trim()) {
        throw apiError(
          DOCUMENT_ERROR_CODES.INVALID_TEMPLATE_REPLACEMENT,
          'Every template replacement needs a non-empty token',
          { operation: 'document.createFromTemplate' },
        );
      }

      if (typeof value !== 'string') {
        throw apiError(
          DOCUMENT_ERROR_CODES.INVALID_TEMPLATE_REPLACEMENT,
          `The replacement for "${token}" must be a string`,
          { operation: 'document.createFromTemplate', token },
        );
      }
    }

    return { ...source };
  }

  /**
   * Normalise the name of a document this service creates.
   *
   * A name with no extension becomes `.docx` (the only format this service can
   * write); any other extension is refused rather than silently renamed.
   */
  private normalizeDocumentName(name: string, operation: string): string {
    const value = String(name ?? '').trim();

    if (!value) {
      throw apiError(DOCUMENT_ERROR_CODES.INVALID_DOCUMENT_NAME, 'A document name is required', {
        operation,
      });
    }

    if (/[\u0000-\u001f]/.test(value) || /[\\/]/.test(value) || value === '.' || value === '..') {
      throw apiError(
        DOCUMENT_ERROR_CODES.INVALID_DOCUMENT_NAME,
        'A document name must not contain control characters or a path separator',
        { operation, name: value },
      );
    }

    const extension = /(\.[A-Za-z0-9]+)$/.exec(value);

    if (!extension) return `${value}${DOCX_EXTENSION}`;

    if (extension[1].toLowerCase() !== DOCX_EXTENSION) {
      throw apiError(
        DOCUMENT_ERROR_CODES.INVALID_DOCUMENT_NAME,
        `"${value}" is not a .docx name; this service only creates ${DOCX_EXTENSION} documents`,
        { operation, name: value, expected: DOCX_EXTENSION },
      );
    }

    return value;
  }

  /**
   * Refuse anything that is not an OOXML Word document.
   *
   * `allowLegacyDoc` exists for the conversion path, where Graph itself documents
   * `.doc` → `.pdf`; text extraction and substitution cannot handle the binary
   * format and never allow it.
   */
  private assertDocx(
    metadata: IDocumentMetadata,
    operation: string,
    options: { allowLegacyDoc?: boolean } = {},
  ): void {
    const extension = (/(\.[A-Za-z0-9]+)$/.exec(String(metadata.name ?? '').trim())?.[1] || '')
      .toLowerCase();
    const mimeType = String(metadata.mimeType ?? '').toLowerCase();

    if (extension === DOCX_EXTENSION || mimeType === DOCX_MIME_TYPE) return;

    if (options.allowLegacyDoc && (extension === '.doc' || mimeType === 'application/msword')) return;

    throw apiError(
      DOCUMENT_ERROR_CODES.INVALID_DOCUMENT_FORMAT,
      `"${metadata.name || metadata.itemId}" is not a Word .docx document `
        + `(extension "${extension || 'none'}", mimeType "${mimeType || 'unknown'}"). `
        + 'Only OOXML .docx files can be read as text or used as a template; binary content is '
        + 'never returned as a string.',
      {
        operation,
        itemId: metadata.itemId,
        name: metadata.name,
        mimeType: metadata.mimeType,
        expected: [DOCX_EXTENSION, DOCX_MIME_TYPE],
      },
    );
  }

  /**
   * Buffer a document's bytes, bounded.
   *
   * A zip has to be parsed end to end, so extraction is inherently a whole-file
   * operation - but "whole file" must still be bounded. The stream is destroyed
   * the moment the bound is crossed so a hostile or accidental large file cannot
   * exhaust memory.
   */
  private async readDocumentBytes(
    userId: string,
    itemId: string,
    options: IDocumentRequestOptions,
    maxBytes: number,
  ): Promise<Buffer> {
    const download = await this.driveService.downloadItem(userId, itemId, {
      driveId: options?.driveId,
    });

    if (download?.contentLength !== undefined && download.contentLength > maxBytes) {
      await this.discard(download.stream);

      throw apiError(
        DOCUMENT_ERROR_CODES.DOCUMENT_TOO_LARGE_FOR_TEXT,
        `"${itemId}" is ${download.contentLength} bytes, above the ${maxBytes}-byte limit for `
          + 'in-memory .docx processing',
        { itemId, size: download.contentLength, limit: maxBytes },
      );
    }

    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of download.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
      chunks.push(buffer);
      size += buffer.length;

      if (size > maxBytes) {
        (download.stream as any)?.destroy?.();

        throw apiError(
          DOCUMENT_ERROR_CODES.DOCUMENT_TOO_LARGE_FOR_TEXT,
          `"${itemId}" exceeds the ${maxBytes}-byte limit for in-memory .docx processing`,
          { itemId, limit: maxBytes },
        );
      }
    }

    if (!size) {
      throw apiError(
        DOCUMENT_ERROR_CODES.EMPTY_DOCUMENT_CONTENT,
        `Microsoft Graph returned an empty body for "${itemId}"`,
        { itemId },
      );
    }

    return Buffer.concat(chunks);
  }

  /**
   * The two-hop binary fetch (same discipline as `AzureDriveService`):
   * authenticated request that stops at the 302, then the pre-authenticated URL
   * **without** the bearer token.
   */
  private async fetchBinary(
    userId: string,
    path: string,
    operation: string,
  ): Promise<{ stream: Readable; contentType?: string; contentLength?: number }> {
    const { token, source } = await this.getAccessToken(userId);

    let response = await this.send({
      url: `${GRAPH_V1}${path}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf, */*' },
      redirect: 'manual',
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = readHeader(response.headers, 'location');
      await this.discard(response.body);

      if (!location) {
        throw apiError(
          DOCUMENT_ERROR_CODES.INVALID_DOCUMENT_REDIRECT,
          `Microsoft Graph returned ${response.status} without a Location header`,
          { operation, status: response.status },
        );
      }

      // The storage URL is pre-authenticated: no Authorization, no cookies.
      response = await this.send({
        url: location,
        method: 'GET',
        headers: { Accept: 'application/pdf, */*' },
        redirect: 'follow',
      });
    }

    if (response.status >= 400) {
      throw await this.httpFailure(response, operation, source);
    }

    if (response.status < 200 || response.status >= 300) {
      await this.discard(response.body);

      throw apiError(
        GraphErrorCode.GRAPH_REQUEST_FAILED,
        `Unexpected status ${response.status} while transferring document content`,
        { operation, status: response.status },
      );
    }

    return {
      stream: this.toNodeStream(response.body),
      contentType: readHeader(response.headers, 'content-type'),
      contentLength: this.parseLength(readHeader(response.headers, 'content-length')),
    };
  }

  /** Issue one raw HTTP request through the active transport. */
  private async send(request: IDriveHttpRequest): Promise<IDriveHttpResponse> {
    try {
      return await activeDocumentHttpClient(request);
    } catch (error) {
      throw this.translate(error, `document.transport.${request.method}`);
    }
  }

  /** Resolve the bearer token used by the first binary hop. */
  private async getAccessToken(userId: string): Promise<{ token: string; source?: AzureTokenSource }> {
    const authService = this.authService;

    if (!authService || typeof authService.getToken !== 'function') {
      throw apiError(
        GraphErrorCode.NOT_CONNECTED,
        'The Azure Auth Service is not available; a document download cannot be authenticated',
        { operation: 'document.getToken' },
      );
    }

    try {
      const result = await authService.getToken(userId);

      if (!result?.token) {
        throw apiError(
          GraphErrorCode.NOT_CONNECTED,
          'No Microsoft Graph token is available for this user',
          { operation: 'document.getToken' },
        );
      }

      return { token: result.token, source: result.source };
    } catch (error) {
      throw this.translate(error, 'document.getToken');
    }
  }

  /** Translate any failure into an `ApiError`, preserving the Graph `code`. */
  private translate(error: any, operation: string, tokenSource?: AzureTokenSource): ApiError {
    if (error && error.__isReactoryApiError === true) return error as ApiError;

    const translated = toGraphApiError(error, { operation, tokenSource });
    (translated as any).__isReactoryApiError = true;
    return translated;
  }

  /** Turn a failed raw response into an `ApiError` carrying Graph's `code`. */
  private async httpFailure(
    response: IDriveHttpResponse,
    operation: string,
    tokenSource?: AzureTokenSource,
  ): Promise<ApiError> {
    const body = await this.readBodyAsText(response?.body).catch(() => '');
    let message = '';

    try {
      const parsed = body ? JSON.parse(body) : undefined;
      message = parsed?.error?.message || parsed?.message || '';
    } catch {
      message = '';
    }

    return toGraphApiError(
      {
        statusCode: response?.status,
        message: message || `Microsoft Graph ${operation} failed with status ${response?.status}`,
        body,
      },
      { operation, tokenSource },
    );
  }

  /** Coerce a transport body into a Node readable without buffering it. */
  private toNodeStream(body: unknown): Readable {
    if (body === undefined || body === null) return readableFrom([]);

    const candidate: any = body;

    if (typeof candidate.pipe === 'function' && typeof candidate.on === 'function') {
      return candidate as Readable;
    }

    if (typeof candidate.getReader === 'function') {
      const fromWeb = (Readable as any).fromWeb;

      if (typeof fromWeb === 'function') {
        return fromWeb.call(Readable, candidate);
      }

      return readableFrom((async function* pump() {
        const reader = candidate.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield Buffer.from(value);
        }
      })());
    }

    if (typeof candidate[Symbol.asyncIterator] === 'function') return readableFrom(candidate);
    if (Buffer.isBuffer(candidate)) return readableFrom([candidate]);
    if (typeof candidate === 'string') return readableFrom([Buffer.from(candidate)]);

    return readableFrom([Buffer.from(String(candidate))]);
  }

  /** Read a (small) transport body as text, bounded. */
  private async readBodyAsText(body: unknown): Promise<string> {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body.slice(0, RAW_BODY_LIMIT);
    if (Buffer.isBuffer(body)) return body.toString('utf8', 0, Math.min(body.length, RAW_BODY_LIMIT));

    const candidate: any = body;
    if (typeof candidate.text === 'function') {
      const text = await candidate.text();
      return String(text ?? '').slice(0, RAW_BODY_LIMIT);
    }

    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of this.toNodeStream(candidate)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
      chunks.push(buffer);
      size += buffer.length;
      if (size >= RAW_BODY_LIMIT) break;
    }

    return Buffer.concat(chunks).toString('utf8', 0, Math.min(size, RAW_BODY_LIMIT));
  }

  /** Release a body we do not intend to read (or must not stream). */
  private async discard(body: unknown): Promise<void> {
    const candidate: any = body;
    if (!candidate || typeof candidate !== 'object') return;

    try {
      if (typeof candidate.destroy === 'function') {
        candidate.destroy();
        return;
      }

      if (typeof candidate.cancel === 'function') {
        await candidate.cancel();
        return;
      }

      if (typeof candidate.resume === 'function') candidate.resume();
    } catch {
      /* a body that cannot be drained is not a reason to fail the request */
    }
  }

  /** `Content-Length` as a number, when it is one. */
  private parseLength(value: string | undefined): number | undefined {
    if (!value) return undefined;

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
}

export const AzureDocumentServiceDefinition: Reactory.Service.IReactoryServiceDefinition<AzureDocumentService> = {
  service: (props: any, context: any) => new AzureDocumentService(props, context),
  id: 'azure.AzureDocumentService@1.0.0',
  name: 'AzureDocumentService',
  nameSpace: 'azure',
  version: '1.0.0',
  description:
    'Word documents over Microsoft Graph - template copy with text substitution, .docx text extraction, 2 MB-capped PDF conversion and whole-file replacement',
  serviceType: 'data',
  dependencies: [
    { id: 'azure.AzureDriveService@1.0.0', alias: 'driveService' },
    { id: 'azure.AzureGraphClientProvider@1.0.0', alias: 'graphProvider' },
    { id: 'azure.AzureAuthService@1.0.0', alias: 'authService' },
  ],
};

export { AzureDocumentService };

export default AzureDocumentService;
