/**
 * Word document domain types and the `azure.AzureDocumentService@1.0.0` contract.
 *
 * Three rules shape this file, and they are the whole point of AZ-09:
 *
 *  1. **No server-side Word body editing.** Microsoft exposes no Graph endpoint
 *     that edits the *body* of a Word document - there is no equivalent of Google
 *     Docs `batchUpdate`. Every type here describes an operation that Graph can
 *     actually perform: copy a template, read bytes, replace a whole file, convert
 *     a file to PDF. Nothing here models paragraph-level editing, because no
 *     operation exists to model.
 *  2. **The PDF conversion ceiling is a hard limit, not a hint.** Graph's
 *     `/content?format=pdf` conversion refuses files above 2 MB, and a partial
 *     response is indistinguishable from a complete one once it is a stream. The
 *     limit therefore lives in this module as a constant
 *     ({@link PDF_CONVERSION_MAX_BYTES}) and is checked *before* any request is
 *     issued - see `AzureDocumentService#convertToPdf`.
 *  3. **Template substitution is text substitution.** `createFromTemplate`
 *     replaces literal token text inside the copied `.docx`; it does not add
 *     paragraphs, tables, images or fields. The result carries
 *     `mode: 'text-substitution'` so a caller cannot mistake it for structural
 *     editing.
 */
import type { Readable } from 'stream';
import type { IDriveIdentity } from './drive.types';

/**
 * The MIME type of a Word document in the OOXML format (`.docx`).
 *
 * The legacy binary format (`.doc`, `application/msword`) is deliberately *not*
 * treated as a Word document by this service: it is not a zip, so it can be
 * neither text-extracted nor token-substituted without a binary Word parser.
 */
export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The legacy binary Word MIME type - recognised only so we can refuse it clearly. */
export const DOC_MIME_TYPE = 'application/msword';

/** The `.docx` file extension, lower-cased, including the dot. */
export const DOCX_EXTENSION = '.docx';

/**
 * Microsoft Graph's documented ceiling for content conversion, in bytes.
 *
 * `GET /items/{id}/content?format=pdf` converts at most **2 MB** per file, and
 * only for the format pairs Microsoft documents (`docx`/`doc` → `pdf`,
 * `xlsx` → `pdf`, `pptx` → `pdf`, and a handful of others). Above the ceiling
 * Graph answers with an error at best; the failure mode this constant exists to
 * prevent is a *truncated* body that looks like a successful conversion.
 */
export const PDF_CONVERSION_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The largest `.docx` this service will unzip in memory for text extraction.
 *
 * Extraction is a whole-file operation (a zip must be parsed end to end), so an
 * unbounded read is an unbounded allocation. 32 MiB is far above any realistic
 * text document and well below the point where buffering hurts a server.
 */
export const DOCX_TEXT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The libraries and their roles, stated once so callers can report them.
 *
 * `TEXT_EXTRACTION_LIBRARY` names the exact mechanism: a purpose-built
 * WordprocessingML reader (`word/document.xml`) over Node's built-in `zlib`
 * (raw DEFLATE for the zip entries). No third-party parser is involved, so there
 * is no hidden transitive dependency and no network access.
 */
export const TEXT_EXTRACTION_LIBRARY = "Node.js zlib + built-in WordprocessingML (word/document.xml) reader";

/** Addressing options shared by the document methods. */
export interface IDocumentRequestOptions {
  /** Target a specific drive (`/drives/{id}`) instead of the user's default drive. */
  driveId?: string;
}

/**
 * The metadata Graph holds for a document.
 *
 * `size` is the field the PDF ceiling is enforced against, which is why
 * `convertToPdf` reads it first: the decision to reject must be made *without*
 * issuing a request.
 */
export interface IDocumentMetadata {
  itemId: string;
  name?: string;
  size?: number;
  mimeType?: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  createdBy?: IDriveIdentity;
  lastModifiedBy?: IDriveIdentity;
  /** The containing folder - required to replace a document's bytes by name. */
  parentId?: string;
}

/** The extracted text of a Word document, plus the limits of that extraction. */
export interface IDocumentText {
  itemId: string;
  name?: string;
  /** The plain text of `word/document.xml`, paragraph per line. */
  text: string;
  /** The extractor actually used, e.g. {@link TEXT_EXTRACTION_LIBRARY}. */
  library: string;
  /**
   * What this extraction is known *not* to preserve. Callers surface it next to
   * the text so a missing heading is not mistaken for a missing section.
   */
  fidelity: string[];
  /** `text.length`, so a caller can tell an empty document from a failed read. */
  characters: number;
}

/** A converted document, streamed. There is intentionally no URL property. */
export interface IDocumentConversionStream {
  itemId: string;
  format: 'pdf';
  stream: Readable;
  contentType?: string;
  contentLength?: number;
}

/**
 * The outcome of `createFromTemplate`.
 *
 * `mode` is a literal so the contract states, in the type system, that this is
 * text substitution: the document is a byte-for-byte copy of the template with
 * literal token strings replaced. No structure is created or removed.
 */
export interface IDocumentTemplateResult {
  itemId: string;
  name?: string;
  webUrl?: string;
  size?: number;
  templateItemId: string;
  mode: 'text-substitution';
  /** The tokens that were found in the document and replaced. */
  applied: string[];
  /** The tokens that were supplied but never appeared (often split across runs). */
  missing: string[];
}

/** The outcome of `replaceDocument` - the whole file was replaced. */
export interface IDocumentReplacementResult {
  itemId: string;
  name?: string;
  webUrl?: string;
  size?: number;
}

/**
 * The public contract of `azure.AzureDocumentService@1.0.0`.
 *
 * Every method takes `userId` first and fails with an `ApiError` that carries a
 * machine-readable `code`; none of them returns an empty placeholder in place of
 * a failure. There is deliberately **no** method that edits a document body -
 * see the class documentation for the audit finding that forbids inventing one.
 */
export interface IAzureDocumentService {
  /**
   * Copy `templateItemId` to a new `.docx` and replace literal `{{token}}` text.
   *
   * This is text substitution inside the copied document, not structural
   * editing: formatting, images, tables and fields are untouched because the
   * bytes are copied, not regenerated.
   */
  createFromTemplate(
    userId: string,
    templateItemId: string,
    name: string,
    replacements: Record<string, string>,
    options?: IDocumentRequestOptions,
  ): Promise<IDocumentTemplateResult>;

  /**
   * Download a `.docx` and extract its plain text.
   *
   * Throws `InvalidDocumentFormat` for anything that is not a `.docx` rather
   * than handing binary bytes back as a string.
   */
  getDocumentText(
    userId: string,
    itemId: string,
    options?: IDocumentRequestOptions,
  ): Promise<IDocumentText>;

  /**
   * Convert a Word document to PDF.
   *
   * Reads the size from {@link IDocumentMetadata} first and refuses files above
   * {@link PDF_CONVERSION_MAX_BYTES} **without issuing a request**, because a
   * truncated conversion is indistinguishable from a complete one.
   */
  convertToPdf(
    userId: string,
    itemId: string,
    options?: IDocumentRequestOptions,
  ): Promise<IDocumentConversionStream>;

  /** Replace a document's entire contents with a supplied `.docx`. */
  replaceDocument(
    userId: string,
    itemId: string,
    content: Buffer | Uint8Array,
    options?: IDocumentRequestOptions,
  ): Promise<IDocumentReplacementResult>;

  /** Size, owner, timestamps and `webUrl` for a document. */
  getDocumentMetadata(
    userId: string,
    itemId: string,
    options?: IDocumentRequestOptions,
  ): Promise<IDocumentMetadata>;
}
