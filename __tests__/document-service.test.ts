/**
 * `document-service.test.ts` - AZ-09: Word documents, and the refusal to invent
 * a body-editing API.
 *
 * The five properties this suite exists to defend:
 *
 *  1. **The 2 MB conversion ceiling is enforced before the request.** A document
 *     above `PDF_CONVERSION_MAX_BYTES` throws `FileTooLargeForConversion` with
 *     `{ size, limit }` and issues *zero* HTTP requests - because a truncated PDF
 *     is indistinguishable from a complete one once it is a stream.
 *  2. **A conversion that is allowed really asks for `?format=pdf`** and returns a
 *     stream, following Graph's 302 to the storage host without forwarding the
 *     bearer token.
 *  3. **Text extraction refuses binary.** A non-`.docx` item throws
 *     `InvalidDocumentFormat` before any download, instead of returning mojibake.
 *  4. **Template substitution is text substitution.** Tokens are replaced in a
 *     byte-for-byte copy of the template (including tokens Word split across
 *     runs), and the result says so.
 *  5. **There is no `batchUpdate`.** Microsoft exposes no server-side Word
 *     body-editing API (audit §7 G1); the source must not pretend otherwise.
 *
 * No live Graph call is made: the provider and the drive service are mocks, and
 * the document byte transport is injected per test.
 */
jest.mock('@microsoft/microsoft-graph-client', () => ({
  ResponseType: { RAW: 'raw', TEXT: 'text', JSON: 'json' },
}));

// eslint-disable-next-line import/first
import fs from 'fs';
// eslint-disable-next-line import/first
import path from 'path';
// eslint-disable-next-line import/first
import { deflateRawSync } from 'zlib';
// eslint-disable-next-line import/first
import { Readable } from 'stream';
// eslint-disable-next-line import/first
import ApiError from '@reactory/server-core/exceptions';
// eslint-disable-next-line import/first
import {
  AzureDocumentService,
  AzureDocumentServiceDefinition,
  DOCUMENT_ERROR_CODES,
  applyTokensToDocumentXml,
  extractTextFromDocumentXml,
  looksLikeDocx,
  readDocxEntries,
  setDocumentHttpClient,
  writeDocxEntries,
} from '../services/AzureDocumentService';
// eslint-disable-next-line import/first
import DocumentsResolver from '../graphql/resolvers/DocumentsResolver';
// eslint-disable-next-line import/first
import {
  DOCX_MIME_TYPE,
  PDF_CONVERSION_MAX_BYTES,
  TEXT_EXTRACTION_LIBRARY,
} from '../types/document.types';
// eslint-disable-next-line import/first
import type { IDriveHttpRequest, IDriveHttpResponse } from '../types/drive.types';

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const ITEM_ID = 'ITEM';
const TEMPLATE_ID = 'TEMPLATE';
const PARENT_ID = 'PARENT';
const DOCX = 'Template.docx';
const PDF_URL_PREFIX = 'https://graph.microsoft.com/v1.0/me/drive/items';

const MODULE_ROOT = path.resolve(__dirname, '..');
const SERVICE_SOURCE = fs.readFileSync(
  path.join(MODULE_ROOT, 'services', 'AzureDocumentService.ts'),
  'utf8',
);
const RESOLVER_SOURCE = fs.readFileSync(
  path.join(MODULE_ROOT, 'graphql', 'resolvers', 'DocumentsResolver.ts'),
  'utf8',
);
const SDL_SOURCE = fs.readFileSync(
  path.join(MODULE_ROOT, 'graphql', 'types', 'Documents.graphql'),
  'utf8',
);

// ---------------------------------------------------------------------------
// A minimal, independent zip writer for fixtures
//
// Deliberately NOT the service's `writeDocxEntries`: fixtures are built by this
// suite so the reader is exercised against an archive it did not produce.
// ---------------------------------------------------------------------------

function crc32(buffer: Buffer): number {
  const table = new Uint32Array(256);

  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }

  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

interface IFixtureEntry {
  name: string;
  data: string | Buffer;
  deflate?: boolean;
}

function buildZip(entries: IFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.deflate ? 8 : 0;
    const payload = entry.deflate ? deflateRawSync(data) : data;
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralDirectory, eocd]);
}

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Dear {{client_name}},</w:t></w:r></w:p>
    <w:p><w:r><w:t>Total: </w:t></w:r><w:r><w:t>{{amount}}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Split token: {{cli</w:t></w:r><w:r><w:t>ent_name}}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Left</w:t><w:tab/><w:t>Right</w:t></w:r></w:p>
    <w:p><w:r><w:t>Entities: &amp; &lt; &gt; &quot;quoted&quot;</w:t></w:r></w:p>
  </w:body>
</w:document>`;

function buildDocx(documentXml: string = DOCUMENT_XML, options: { deflate?: boolean } = {}): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: '<Types/>', deflate: options.deflate },
    { name: 'word/document.xml', data: documentXml, deflate: options.deflate },
    { name: 'word/styles.xml', data: '<w:styles/>', deflate: options.deflate },
  ]);
}

/** A Graph error body, as Graph sends it. */
function graphErrorBody(code: string, message = 'The requested item was not found'): Buffer {
  return Buffer.from(JSON.stringify({ error: { code, message } }));
}

/** Read a Node stream into a string. */
async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
  }

  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface IChainMock {
  api: jest.Mock;
  headers: jest.Mock;
  version: jest.Mock;
  query: jest.Mock;
  responseType: jest.Mock;
  get: jest.Mock;
  post: jest.Mock;
  patch: jest.Mock;
  put: jest.Mock;
  delete: jest.Mock;
}

function createChain(): IChainMock {
  const chain: any = {};

  chain.api = jest.fn(() => chain);
  chain.headers = jest.fn(() => chain);
  chain.version = jest.fn(() => chain);
  chain.query = jest.fn(() => chain);
  chain.responseType = jest.fn(() => chain);
  chain.get = jest.fn();
  chain.post = jest.fn();
  chain.patch = jest.fn();
  chain.put = jest.fn();
  chain.delete = jest.fn();

  return chain as IChainMock;
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    name: DOCX,
    size: 4096,
    webUrl: 'https://contoso.sharepoint.com/Documents/Template.docx',
    createdDateTime: '2026-01-02T03:04:05Z',
    lastModifiedDateTime: '2026-02-03T04:05:06Z',
    createdBy: { user: { id: 'creator-1', displayName: 'Ada Lovelace', email: 'ada@example.test' } },
    lastModifiedBy: { user: { id: 'editor-1', displayName: 'Grace Hopper', email: 'grace@example.test' } },
    parentReference: { id: PARENT_ID },
    file: { mimeType: DOCX_MIME_TYPE },
    ...overrides,
  };
}

function createHarness(options: { bind?: boolean } = {}) {
  const chain = createChain();
  const provider = {
    request: jest.fn(),
    requestAll: jest.fn(),
    getClient: jest.fn(() => chain),
  };
  const authService = {
    getToken: jest.fn().mockResolvedValue({ token: 'graph-token', source: 'vault' }),
  };
  const driveService = {
    downloadItem: jest.fn(),
    copyItem: jest.fn(),
    uploadItem: jest.fn(),
  };

  const context: any = {
    user: { _id: USER_ID },
    getService: jest.fn((id: string) => {
      if (id === 'azure.AzureDriveService@1.0.0') return driveService;
      if (id === 'azure.AzureGraphClientProvider@1.0.0') return provider;
      if (id === 'azure.AzureAuthService@1.0.0') return authService;
      return undefined;
    }),
  };

  const service = new AzureDocumentService({} as any, context);

  if (options.bind !== false) {
    service.setDriveService(driveService);
    service.setGraphProvider(provider);
    service.setAuthService(authService);
  }

  return { service, provider, chain, authService, driveService, context };
}

/** A transport that hands back a scripted response per hop and records the hops. */
function scriptedTransport(script: Array<IDriveHttpResponse | Error>) {
  const calls: IDriveHttpRequest[] = [];

  setDocumentHttpClient(async (hop) => {
    calls.push(hop);
    const next = script[Math.min(calls.length - 1, script.length - 1)];

    if (next instanceof Error) throw next;
    return next;
  });

  return calls;
}

afterEach(() => {
  setDocumentHttpClient(null);
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The OOXML container and text primitives
// ---------------------------------------------------------------------------

describe('docx container support', () => {
  it('reads stored and deflated entries out of an externally-built archive', () => {
    const stored = readDocxEntries(buildDocx(DOCUMENT_XML, { deflate: false }));
    const deflated = readDocxEntries(buildDocx(DOCUMENT_XML, { deflate: true }));

    for (const entries of [stored, deflated]) {
      const names = entries.map((entry) => entry.name);
      expect(names).toEqual(['[Content_Types].xml', 'word/document.xml', 'word/styles.xml']);

      const documentPart = entries.find((entry) => entry.name === 'word/document.xml');
      expect(documentPart?.data.toString('utf8')).toBe(DOCUMENT_XML);
    }
  });

  it('recognises a docx by zip magic and the main document part', () => {
    expect(looksLikeDocx(buildDocx())).toBe(true);
    expect(looksLikeDocx(buildZip([{ name: 'word/styles.xml', data: '<w:styles/>' }]))).toBe(false);
    expect(looksLikeDocx(Buffer.from('%PDF-1.7'))).toBe(false);
    expect(looksLikeDocx(Buffer.alloc(0))).toBe(false);
  });

  it('round-trips an archive through the service writer, changing only the edited part', () => {
    const original = readDocxEntries(buildDocx());
    const rewrittenPart = original[1].data.toString('utf8').replace('{{amount}}', '42');
    original[1] = { name: 'word/document.xml', data: Buffer.from(rewrittenPart, 'utf8') };

    const rewritten = readDocxEntries(writeDocxEntries(original));

    expect(rewritten.map((entry) => entry.name)).toEqual(original.map((entry) => entry.name));
    expect(rewritten[0].data.toString('utf8')).toBe('<Types/>');
    expect(rewritten[2].data.toString('utf8')).toBe('<w:styles/>');
    expect(rewritten[1].data.toString('utf8')).toContain('42');
    expect(rewritten[1].data.toString('utf8')).not.toContain('{{amount}}');
  });

  it('refuses a buffer that is not a zip at all', () => {
    expect(() => readDocxEntries(Buffer.from('not a zip'))).toThrow(ApiError);
  });

  it('extracts paragraph text, tabs and entities', () => {
    const text = extractTextFromDocumentXml(DOCUMENT_XML);

    expect(text.split('\n')[0]).toBe('Dear {{client_name}},');
    expect(text).toContain('Total: {{amount}}');
    expect(text).toContain('Left\tRight');
    expect(text).toContain('Entities: & < > "quoted"');
    // Markup is gone, not merely hidden.
    expect(text).not.toContain('<w:t>');
  });

  it('returns an empty string for a document with no text runs', () => {
    expect(extractTextFromDocumentXml('<w:document><w:body/></w:document>')).toBe('');
    expect(extractTextFromDocumentXml('')).toBe('');
  });
});

describe('token substitution', () => {
  it('replaces a token inside one run and preserves the run structure', () => {
    const result = applyTokensToDocumentXml(DOCUMENT_XML, {
      '{{client_name}}': 'Acme (Pty) Ltd',
      '{{amount}}': '1 250.00',
    });

    expect(result.applied.sort()).toEqual(['{{amount}}', '{{client_name}}']);
    expect(result.missing).toEqual([]);

    const text = extractTextFromDocumentXml(result.xml);
    expect(text).toContain('Dear Acme (Pty) Ltd,');
    expect(text).toContain('Total: 1 250.00');
    // The two-run paragraph keeps both runs: formatting survives a simple case.
    // (A collapse would have produced one run holding "Total: 1 250.00".)
    expect(result.xml).toMatch(/<w:t[^>]*>Total: <\/w:t>/);
    expect(result.xml).toMatch(/<w:t[^>]*>1 250\.00<\/w:t>/);
  });

  it('replaces a token Word split across runs', () => {
    const result = applyTokensToDocumentXml(DOCUMENT_XML, { '{{client_name}}': 'Acme' });

    expect(result.applied).toEqual(['{{client_name}}']);
    expect(extractTextFromDocumentXml(result.xml)).toContain('Split token: Acme');
  });

  it('reports tokens it never found instead of silently dropping them', () => {
    const result = applyTokensToDocumentXml(DOCUMENT_XML, { '{{nope}}': 'x' });

    expect(result.applied).toEqual([]);
    expect(result.missing).toEqual(['{{nope}}']);
    expect(result.xml).toBe(DOCUMENT_XML);
  });

  it('escapes substituted values so a replacement cannot inject markup', () => {
    const result = applyTokensToDocumentXml(DOCUMENT_XML, {
      '{{client_name}}': 'A & B <script>',
    });

    expect(result.xml).toContain('A &amp; B &lt;script&gt;');
    expect(result.xml).not.toContain('<script>');
    expect(extractTextFromDocumentXml(result.xml)).toContain('Dear A & B <script>,');
  });

  it('leaves a document with no runs untouched', () => {
    const xml = '<w:document><w:body><w:p/></w:body></w:document>';

    expect(applyTokensToDocumentXml(xml, { '{{a}}': 'b' })).toEqual({
      xml,
      applied: [],
      missing: ['{{a}}'],
    });
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('getDocumentMetadata', () => {
  it('projects the Graph item onto size, editor, created time and webUrl', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue(metadata());

    const result = await service.getDocumentMetadata(USER_ID, ITEM_ID);

    expect(result).toMatchObject({
      itemId: ITEM_ID,
      name: DOCX,
      size: 4096,
      mimeType: DOCX_MIME_TYPE,
      webUrl: 'https://contoso.sharepoint.com/Documents/Template.docx',
      createdDateTime: '2026-01-02T03:04:05Z',
      parentId: PARENT_ID,
    });
    // Graph sends identities as identitySets; they are unwrapped, not passed on.
    expect(result.lastModifiedBy).toEqual({
      id: 'editor-1',
      displayName: 'Grace Hopper',
      email: 'grace@example.test',
    });
    expect(result.createdBy).toMatchObject({ id: 'creator-1' });

    const [userId, requestPath, requestOptions] = provider.request.mock.calls[0];
    expect(userId).toBe(USER_ID);
    expect(requestPath).toBe(`/me/drive/items/${ITEM_ID}`);
    expect(requestOptions.select).toEqual(expect.arrayContaining(['size', 'lastModifiedBy', 'createdDateTime', 'webUrl']));
  });

  it('addresses a specific drive when one is supplied and encodes the item id', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue(metadata({ id: 'a/b#c' }));

    await service.getDocumentMetadata(USER_ID, 'a/b#c', { driveId: 'D1' });

    expect(provider.request.mock.calls[0][1]).toBe('/drives/D1/items/a%2Fb%23c');
  });

  it('fails typed when Graph returns no item', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({});

    await expect(service.getDocumentMetadata(USER_ID, ITEM_ID)).rejects.toMatchObject({
      code: 'GraphRequestFailed',
    });
  });

  it('translates a provider failure into an ApiError with the Graph code', async () => {
    const { service, provider } = createHarness();
    provider.request.mockRejectedValue({ statusCode: 404, code: 'itemNotFound', message: 'gone' });

    const failure: any = await service.getDocumentMetadata(USER_ID, ITEM_ID).catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.code).toBe('itemNotFound');
    expect(failure.status).toBe(404);
  });

  it('requires a userId', async () => {
    const service = new AzureDocumentService({} as any, {} as any);

    await expect(service.getDocumentMetadata('', ITEM_ID)).rejects.toMatchObject({
      code: 'NotConnected',
    });
  });
});

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

describe('getDocumentText', () => {
  it('extracts .docx text and states the library and its fidelity limits', async () => {
    const { service, provider, driveService } = createHarness();
    provider.request.mockResolvedValue(metadata());
    const docx = buildDocx();
    driveService.downloadItem.mockResolvedValue({
      stream: Readable.from([docx]),
      contentType: DOCX_MIME_TYPE,
      contentLength: docx.length,
    });

    const result = await service.getDocumentText(USER_ID, ITEM_ID);

    expect(result.itemId).toBe(ITEM_ID);
    expect(result.library).toBe(TEXT_EXTRACTION_LIBRARY);
    expect(result.text).toContain('Dear {{client_name}},');
    expect(result.characters).toBe(result.text.length);
    expect(result.fidelity.join(' ')).toMatch(/headers/i);
    expect(result.fidelity.join(' ')).toMatch(/footnote/i);
    expect(result.fidelity.join(' ')).toMatch(/text box/i);
    expect(driveService.downloadItem).toHaveBeenCalledWith(USER_ID, ITEM_ID, { driveId: undefined });
  });

  it('throws InvalidDocumentFormat for a PDF and never downloads it', async () => {
    const { service, provider, driveService } = createHarness();
    provider.request.mockResolvedValue(
      metadata({ name: 'Report.pdf', file: { mimeType: 'application/pdf' } }),
    );

    let caught: any;

    try {
      await service.getDocumentText(USER_ID, ITEM_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe('InvalidDocumentFormat');
    expect(caught.message).toContain('.docx');
    expect(caught.message).toContain('binary content is never returned as a string');
    expect(caught.expected).toEqual([expect.stringContaining('.docx'), DOCX_MIME_TYPE]);
    // The whole point: binary was never fetched or decoded as text.
    expect(driveService.downloadItem).not.toHaveBeenCalled();
  });

  it('refuses the legacy binary .doc format as well', async () => {
    const { service, provider, driveService } = createHarness();
    provider.request.mockResolvedValue(
      metadata({ name: 'Old.doc', file: { mimeType: 'application/msword' } }),
    );

    await expect(service.getDocumentText(USER_ID, ITEM_ID)).rejects.toMatchObject({
      code: 'InvalidDocumentFormat',
    });
    expect(driveService.downloadItem).not.toHaveBeenCalled();
  });

  it('refuses a folder, which has no file facet at all', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue({ id: ITEM_ID, name: 'Reports', folder: { childCount: 2 }, size: 0 });

    await expect(service.getDocumentText(USER_ID, ITEM_ID)).rejects.toMatchObject({
      code: 'InvalidDocumentFormat',
    });
  });

  it('fails when the archive has no word/document.xml part', async () => {
    const { service, provider, driveService } = createHarness();
    provider.request.mockResolvedValue(metadata());
    const docx = buildZip([{ name: 'word/styles.xml', data: '<w:styles/>' }]);
    driveService.downloadItem.mockResolvedValue({
      stream: Readable.from([docx]),
      contentLength: docx.length,
    });

    await expect(service.getDocumentText(USER_ID, ITEM_ID)).rejects.toMatchObject({
      code: 'InvalidDocxArchive',
    });
  });

  it('treats an empty download as a failure, not an empty document', async () => {
    const { service, provider, driveService } = createHarness();
    provider.request.mockResolvedValue(metadata());
    driveService.downloadItem.mockResolvedValue({
      stream: Readable.from([]),
      contentLength: 0,
    });

    await expect(service.getDocumentText(USER_ID, ITEM_ID)).rejects.toMatchObject({
      code: 'EmptyDocumentContent',
    });
  });

  it('refuses an archive above the in-memory processing bound', async () => {
    const { service, provider, driveService } = createHarness();
    provider.request.mockResolvedValue(metadata());
    driveService.downloadItem.mockResolvedValue({
      stream: Readable.from([]),
      contentLength: 64 * 1024 * 1024,
    });

    await expect(service.getDocumentText(USER_ID, ITEM_ID)).rejects.toMatchObject({
      code: 'DocumentTooLargeForTextExtraction',
    });
  });
});

// ---------------------------------------------------------------------------
// PDF conversion: the hard limit
// ---------------------------------------------------------------------------

describe('convertToPdf', () => {
  it('requests ?format=pdf for a document under 2 MB and returns a stream', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue(metadata({ size: 1024 }));

    const hops = scriptedTransport([
      {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': '8' },
        body: Readable.from([Buffer.from('%PDF-1.7')]),
      },
    ]);

    const conversion = await service.convertToPdf(USER_ID, ITEM_ID);

    expect(hops).toHaveLength(1);
    expect(hops[0].url).toBe(`${PDF_URL_PREFIX}/${ITEM_ID}/content?format=pdf`);
    expect(hops[0].method).toBe('GET');
    expect(hops[0].headers?.Authorization).toBe('Bearer graph-token');
    // Stop at the 302: the storage host must not receive the bearer token.
    expect(hops[0].redirect).toBe('manual');

    expect(conversion.format).toBe('pdf');
    expect(conversion.contentType).toBe('application/pdf');
    expect(conversion.contentLength).toBe(8);
    await expect(collect(conversion.stream)).resolves.toBe('%PDF-1.7');
  });

  it('rejects a document above 2 MB with FileTooLargeForConversion and issues NO request', async () => {
    const { service, provider } = createHarness();
    const size = PDF_CONVERSION_MAX_BYTES + 1;
    provider.request.mockResolvedValue(metadata({ size }));

    const hops = scriptedTransport([
      { status: 200, headers: {}, body: Readable.from([Buffer.from('%PDF')]) },
    ]);

    let caught: any;

    try {
      await service.convertToPdf(USER_ID, ITEM_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.code).toBe('FileTooLargeForConversion');
    expect(caught.size).toBe(size);
    expect(caught.limit).toBe(PDF_CONVERSION_MAX_BYTES);
    expect(caught.message).toContain('2097152');
    expect(caught.message).toContain('2 MB');
    // The acceptance criterion: no request at all.
    expect(hops).toHaveLength(0);
    expect(caught.stream).toBeUndefined();
  });

  it('allows a document exactly at the 2 MB boundary', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue(metadata({ size: PDF_CONVERSION_MAX_BYTES }));

    const hops = scriptedTransport([
      { status: 200, headers: { 'content-type': 'application/pdf' }, body: Readable.from([Buffer.from('%PDF')]) },
    ]);

    await expect(service.convertToPdf(USER_ID, ITEM_ID)).resolves.toMatchObject({ format: 'pdf' });
    expect(hops).toHaveLength(1);
  });

  it('refuses an item whose size Graph did not report, without a request', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue(metadata({ size: undefined }));

    const hops = scriptedTransport([{ status: 200, headers: {}, body: Buffer.from('x') }]);

    await expect(service.convertToPdf(USER_ID, ITEM_ID)).rejects.toMatchObject({
      code: 'DocumentSizeUnavailable',
    });
    expect(hops).toHaveLength(0);
  });

  it('follows the 302 to the storage host with no Authorization header', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue(metadata({ size: 1024 }));
    const preauthenticated = 'https://storage.example/preauth/report.pdf?sig=secret';

    const hops = scriptedTransport([
      { status: 302, headers: { location: preauthenticated }, body: undefined },
      {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': '4' },
        body: Readable.from([Buffer.from('%PDF')]),
      },
    ]);

    const conversion = await service.convertToPdf(USER_ID, ITEM_ID, { driveId: 'D1' });

    expect(hops[0].url).toBe(`https://graph.microsoft.com/v1.0/drives/D1/items/${ITEM_ID}/content?format=pdf`);
    expect(hops[1].url).toBe(preauthenticated);
    expect(hops[1].headers?.Authorization).toBeUndefined();
    expect(JSON.stringify(hops[1].headers || {})).not.toContain('graph-token');
    await expect(collect(conversion.stream)).resolves.toBe('%PDF');
  });

  it('surfaces a Graph 404 as an ApiError and never as a stream', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue(metadata({ size: 1024 }));

    scriptedTransport([
      { status: 404, headers: { 'content-type': 'application/json' }, body: graphErrorBody('itemNotFound') },
    ]);

    const failure: any = await service.convertToPdf(USER_ID, ITEM_ID).catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.code).toBe('itemNotFound');
    expect(failure.status).toBe(404);
    expect(failure.stream).toBeUndefined();
  });

  it('refuses an empty conversion rather than returning an empty stream', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue(metadata({ size: 1024 }));

    scriptedTransport([
      { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '0' }, body: undefined },
    ]);

    await expect(service.convertToPdf(USER_ID, ITEM_ID)).rejects.toMatchObject({
      code: 'DocumentConversionFailed',
    });
  });

  it('refuses a response that claims more than the ceiling', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue(metadata({ size: 1024 }));
    const body = new Readable({ read() {} });

    scriptedTransport([
      {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': String(PDF_CONVERSION_MAX_BYTES + 1) },
        body,
      },
    ]);

    await expect(service.convertToPdf(USER_ID, ITEM_ID)).rejects.toMatchObject({
      code: 'FileTooLargeForConversion',
      limit: PDF_CONVERSION_MAX_BYTES,
    });
    // The unconsumed body must be released, never streamed to the caller.
    expect((body as any).destroyed).toBe(true);
  });

  it('refuses an unexpected non-2xx status instead of streaming it', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue(metadata({ size: 1024 }));

    scriptedTransport([{ status: 304, headers: {}, body: undefined }]);

    await expect(service.convertToPdf(USER_ID, ITEM_ID)).rejects.toMatchObject({
      code: 'GraphRequestFailed',
      status: 304,
    });
  });

  it('requires an auth service rather than converting unauthenticated', async () => {
    const provider = { request: jest.fn().mockResolvedValue(metadata({ size: 10 })), requestAll: jest.fn(), getClient: jest.fn() };
    const service = new AzureDocumentService({} as any, {
      user: { _id: USER_ID },
      getService: (id: string) => (id === 'azure.AzureGraphClientProvider@1.0.0' ? provider : undefined),
    } as any);
    service.setGraphProvider(provider);

    const hops = scriptedTransport([{ status: 200, headers: {}, body: Buffer.from('x') }]);

    await expect(service.convertToPdf(USER_ID, ITEM_ID)).rejects.toMatchObject({ code: 'NotConnected' });
    expect(hops).toHaveLength(0);
  });

  it('refuses to "convert" a PDF to a PDF', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue(metadata({ name: 'Report.pdf', file: { mimeType: 'application/pdf' } }));

    const hops = scriptedTransport([{ status: 200, headers: {}, body: Buffer.from('%PDF') }]);

    await expect(service.convertToPdf(USER_ID, ITEM_ID)).rejects.toMatchObject({
      code: 'InvalidDocumentFormat',
    });
    expect(hops).toHaveLength(0);
  });

  it('translates a transport-level throw', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue(metadata({ size: 10 }));

    scriptedTransport([new Error('socket hang up')]);

    const failure: any = await service.convertToPdf(USER_ID, ITEM_ID).catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.code).toBe('GraphRequestFailed');
    expect(failure.operation).toBe('document.transport.GET');
  });
});

// ---------------------------------------------------------------------------
// createFromTemplate
// ---------------------------------------------------------------------------

describe('createFromTemplate', () => {
  function arrange(overrides: { template?: Record<string, unknown> } = {}) {
    const harness = createHarness();
    harness.provider.request.mockResolvedValue(metadata({ ...overrides.template }));
    harness.driveService.copyItem.mockResolvedValue({ status: 'completed', itemId: 'COPY-1' });
    const docx = buildDocx();
    harness.driveService.downloadItem.mockResolvedValue({
      stream: Readable.from([docx]),
      contentType: DOCX_MIME_TYPE,
      contentLength: docx.length,
    });
    harness.driveService.uploadItem.mockResolvedValue({
      id: 'COPY-1',
      name: 'Invoice.docx',
      webUrl: 'https://contoso.sharepoint.com/Documents/Invoice.docx',
      size: 2048,
    });

    return harness;
  }

  it('copies the template, substitutes tokens and uploads a valid .docx', async () => {
    const { service, driveService } = arrange();

    const result = await service.createFromTemplate(USER_ID, TEMPLATE_ID, 'Invoice.docx', {
      '{{client_name}}': 'Acme',
      '{{amount}}': '99.00',
    });

    expect(driveService.copyItem).toHaveBeenCalledWith(USER_ID, TEMPLATE_ID, PARENT_ID, {
      driveId: undefined,
      name: 'Invoice.docx',
      wait: true,
    });

    const [userId, parentId, name, uploaded] = driveService.uploadItem.mock.calls[0];
    expect(userId).toBe(USER_ID);
    expect(parentId).toBe(PARENT_ID);
    expect(name).toBe('Invoice.docx');
    expect(Buffer.isBuffer(uploaded)).toBe(true);
    expect(Buffer.isBuffer(uploaded) && uploaded.subarray(0, 2).toString()).toBe('PK');

    // What was uploaded is a readable archive whose document part was substituted.
    const entries = readDocxEntries(uploaded);
    const part = entries.find((entry) => entry.name === 'word/document.xml');
    const text = extractTextFromDocumentXml(part!.data.toString('utf8'));
    expect(text).toContain('Dear Acme,');
    expect(text).toContain('Total: 99.00');
    expect(text).toContain('Split token: Acme');
    // Untouched parts stayed untouched.
    expect(entries.find((entry) => entry.name === 'word/styles.xml')!.data.toString('utf8'))
      .toBe('<w:styles/>');

    expect(result).toMatchObject({
      itemId: 'COPY-1',
      name: 'Invoice.docx',
      templateItemId: TEMPLATE_ID,
      mode: 'text-substitution',
      applied: expect.arrayContaining(['{{client_name}}', '{{amount}}']),
      missing: [],
    });
  });

  it('reports tokens that were not present, so a caller can fix the template', async () => {
    const { service } = arrange();

    const result = await service.createFromTemplate(USER_ID, TEMPLATE_ID, 'Invoice.docx', {
      '{{client_name}}': 'Acme',
      '{{absent}}': 'x',
    });

    expect(result.applied).toEqual(['{{client_name}}']);
    expect(result.missing).toEqual(['{{absent}}']);
  });

  it('appends .docx when the requested name has no extension', async () => {
    const { service, driveService } = arrange();

    await service.createFromTemplate(USER_ID, TEMPLATE_ID, 'Invoice', {});

    expect(driveService.copyItem.mock.calls[0][3]).toMatchObject({ name: 'Invoice.docx' });
  });

  it('addresses the copy by the name Graph actually gave it, so the upload replaces that copy', async () => {
    const { service, driveService } = arrange();
    driveService.copyItem.mockResolvedValue({
      status: 'completed',
      itemId: 'COPY-1',
      item: { id: 'COPY-1', name: 'Invoice 1.docx' },
    });

    await service.createFromTemplate(USER_ID, TEMPLATE_ID, 'Invoice.docx', {});

    // Graph renames on a copy collision; uploading to the *requested* name would
    // leave the renamed copy orphaned and the substitution invisible.
    expect(driveService.uploadItem.mock.calls[0][2]).toBe('Invoice 1.docx');
  });

  it('refuses a name with a different extension', async () => {
    const { service, driveService } = arrange();

    await expect(
      service.createFromTemplate(USER_ID, TEMPLATE_ID, 'Invoice.pdf', {}),
    ).rejects.toMatchObject({ code: 'InvalidDocumentName' });
    expect(driveService.copyItem).not.toHaveBeenCalled();
  });

  it('refuses a name carrying a path separator', async () => {
    const { service } = arrange();

    await expect(
      service.createFromTemplate(USER_ID, TEMPLATE_ID, 'a/b.docx', {}),
    ).rejects.toMatchObject({ code: 'InvalidDocumentName' });
  });

  it('refuses an empty replacement token', async () => {
    const { service, driveService } = arrange();

    await expect(
      service.createFromTemplate(USER_ID, TEMPLATE_ID, 'Invoice.docx', { '': 'x' }),
    ).rejects.toMatchObject({ code: 'InvalidTemplateReplacement' });
    expect(driveService.copyItem).not.toHaveBeenCalled();
  });

  it('refuses a template that is not a .docx, before copying it', async () => {
    const { service, driveService } = arrange({
      template: { name: 'Template.pdf', file: { mimeType: 'application/pdf' } },
    });

    await expect(
      service.createFromTemplate(USER_ID, TEMPLATE_ID, 'Invoice.docx', {}),
    ).rejects.toMatchObject({ code: 'InvalidDocumentFormat' });
    expect(driveService.copyItem).not.toHaveBeenCalled();
  });

  it('fails when the asynchronous copy has not produced an item id', async () => {
    const { service, driveService } = arrange();
    driveService.copyItem.mockResolvedValue({ status: 'inProgress' });

    await expect(
      service.createFromTemplate(USER_ID, TEMPLATE_ID, 'Invoice.docx', {}),
    ).rejects.toMatchObject({ code: 'DocumentCopyIncomplete' });
    expect(driveService.uploadItem).not.toHaveBeenCalled();
  });

  it('fails when the template has no parent folder to copy into', async () => {
    const { service, driveService } = arrange({ template: { parentReference: undefined } });

    await expect(
      service.createFromTemplate(USER_ID, TEMPLATE_ID, 'Invoice.docx', {}),
    ).rejects.toMatchObject({ code: 'DocumentParentUnavailable' });
    expect(driveService.copyItem).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// replaceDocument
// ---------------------------------------------------------------------------

describe('replaceDocument', () => {
  it('uploads a replacement .docx over the existing item', async () => {
    const { service, provider, driveService } = createHarness();
    provider.request.mockResolvedValue(metadata());
    driveService.uploadItem.mockResolvedValue({
      id: ITEM_ID,
      name: DOCX,
      webUrl: 'https://contoso.sharepoint.com/Documents/Template.docx',
      size: 512,
    });

    const replacement = buildDocx(DOCUMENT_XML.replace('{{client_name}}', 'Replaced'));
    const result = await service.replaceDocument(USER_ID, ITEM_ID, replacement);

    expect(driveService.uploadItem).toHaveBeenCalledWith(
      USER_ID,
      PARENT_ID,
      DOCX,
      replacement,
      { driveId: undefined, contentType: DOCX_MIME_TYPE, conflictBehavior: 'replace' },
    );
    expect(result).toMatchObject({ itemId: ITEM_ID, name: DOCX, size: 512 });
  });

  it('accepts a Uint8Array as well as a Buffer', async () => {
    const { service, provider, driveService } = createHarness();
    provider.request.mockResolvedValue(metadata());
    driveService.uploadItem.mockResolvedValue({ id: ITEM_ID, name: DOCX });

    await service.replaceDocument(USER_ID, ITEM_ID, new Uint8Array(buildDocx()));

    expect(Buffer.isBuffer(driveService.uploadItem.mock.calls[0][3])).toBe(true);
  });

  it('refuses content that is not an OOXML document, without reading metadata', async () => {
    const { service, provider, driveService } = createHarness();

    await expect(
      service.replaceDocument(USER_ID, ITEM_ID, Buffer.from('%PDF-1.7 not a docx')),
    ).rejects.toMatchObject({ code: 'InvalidDocumentFormat' });

    expect(provider.request).not.toHaveBeenCalled();
    expect(driveService.uploadItem).not.toHaveBeenCalled();
  });

  it('refuses empty content', async () => {
    const { service } = createHarness();

    await expect(
      service.replaceDocument(USER_ID, ITEM_ID, Buffer.alloc(0)),
    ).rejects.toMatchObject({ code: 'EmptyDocumentContent' });
  });

  it('refuses to replace a target that is not a .docx', async () => {
    const { service, provider, driveService } = createHarness();
    provider.request.mockResolvedValue(metadata({ name: 'Report.pdf', file: { mimeType: 'application/pdf' } }));

    await expect(
      service.replaceDocument(USER_ID, ITEM_ID, buildDocx()),
    ).rejects.toMatchObject({ code: 'InvalidDocumentFormat' });
    expect(driveService.uploadItem).not.toHaveBeenCalled();
  });

  it('fails when the target has no addressable parent or name', async () => {
    const { service, provider } = createHarness();
    provider.request.mockResolvedValue(metadata({ parentReference: undefined }));

    await expect(
      service.replaceDocument(USER_ID, ITEM_ID, buildDocx()),
    ).rejects.toMatchObject({ code: 'DocumentParentUnavailable' });
  });
});

// ---------------------------------------------------------------------------
// The honesty contract
// ---------------------------------------------------------------------------

describe('the platform limitation is documented, not hidden', () => {
  it('states the exact phrase "no server-side Word body-editing API" in the class JSDoc', () => {
    expect(SERVICE_SOURCE).toContain('no server-side Word body-editing API');
  });

  it('quotes audit §7 G1 and names all three extraction alternatives with their costs', () => {
    expect(SERVICE_SOURCE).toMatch(/audit §7/i);

    // Alternative 1: a server-side .docx parser.
    expect(SERVICE_SOURCE).toMatch(/server-side `?\.docx`? parser/i);
    expect(SERVICE_SOURCE).toMatch(/mammoth/);

    // Alternative 2: an Office Add-in running inside the document.
    expect(SERVICE_SOURCE).toMatch(/Office Add-in/);

    // Alternative 3: the beta documentProcessingJob.
    expect(SERVICE_SOURCE).toContain('documentProcessingJob');

    // Each is described with a cost, not just a name.
    expect(SERVICE_SOURCE).toMatch(/Cost:/);
  });

  it('has no method named batchUpdate anywhere in the service or the resolver', () => {
    for (const source of [SERVICE_SOURCE, RESOLVER_SOURCE]) {
      expect(source).not.toMatch(/\bbatchUpdate\s*\(/);
      expect(source).not.toMatch(/\basync\s+batchUpdate\b/);
      expect(source).not.toMatch(/\bbatchUpdate\s*:/);
    }

    expect((AzureDocumentService.prototype as any).batchUpdate).toBeUndefined();
    expect(Object.getOwnPropertyNames(AzureDocumentService.prototype)).not.toContain('batchUpdate');
  });

  it('declares no body-editing field in the GraphQL surface', () => {
    // Prose in the comments names batchUpdate on purpose (to explain its absence);
    // what must not exist is a *field definition* shaped like one.
    expect(SDL_SOURCE).not.toMatch(/^\s+batchUpdate\s*[(:]/m);
    expect(SDL_SOURCE).not.toMatch(/^\s+editDocumentBody\s*[(:]/m);
  });

  it('exposes the five required fields in the SDL', () => {
    for (const field of [
      'azureDocumentText',
      'azureDocumentMetadata',
      'azureDocumentPdf',
      'azureCreateDocumentFromTemplate',
      'azureReplaceDocument',
    ]) {
      expect(SDL_SOURCE).toContain(field);
    }
    expect(SDL_SOURCE).not.toContain('_azureDocumentsPlaceholder');
  });

  it('removes the AZ-01 placeholder resolver', () => {
    expect(RESOLVER_SOURCE).not.toContain('_azureDocumentsPlaceholder');
  });

  it('states that text extraction has fidelity limits', () => {
    expect(SERVICE_SOURCE).toMatch(/headers/i);
    expect(SERVICE_SOURCE).toMatch(/footnote/i);
    expect(SERVICE_SOURCE).toMatch(/text box/i);
  });

  it('constructs through the exported definition with the AZ-09 FQN', () => {
    const context: any = { user: { _id: USER_ID }, getService: (): undefined => undefined };
    const instance: any = AzureDocumentServiceDefinition.service({} as any, context);

    expect(AzureDocumentServiceDefinition.id).toBe('azure.AzureDocumentService@1.0.0');
    expect(instance.name).toBe('AzureDocumentService');
    expect(instance.nameSpace).toBe('azure');
    expect(AzureDocumentServiceDefinition.dependencies?.map((dependency: any) => dependency.alias))
      .toEqual(['driveService', 'graphProvider', 'authService']);
  });

  it('declares the error codes callers branch on', () => {
    expect(DOCUMENT_ERROR_CODES.FILE_TOO_LARGE_FOR_CONVERSION).toBe('FileTooLargeForConversion');
    expect(DOCUMENT_ERROR_CODES.INVALID_DOCUMENT_FORMAT).toBe('InvalidDocumentFormat');
    expect(DOCUMENT_ERROR_CODES.DOCUMENT_CONVERSION_FAILED).toBe('DocumentConversionFailed');
  });
});

// ---------------------------------------------------------------------------
// documentsResolver
// ---------------------------------------------------------------------------

describe('DocumentsResolver', () => {
  function buildResolver(service: any) {
    const context = {
      user: { _id: USER_ID },
      // `@roles(['USER'], 'args.context')` calls `context.hasRole(role)`.
      hasRole: jest.fn(() => true),
      getService: jest.fn((id: string) =>
        (id === 'azure.AzureDocumentService@1.0.0' ? service : undefined)),
    };

    return { resolver: new DocumentsResolver() as any, context };
  }

  function documentService(overrides: Record<string, any> = {}) {
    return {
      getDocumentMetadata: jest.fn().mockResolvedValue(metadata()),
      getDocumentText: jest.fn().mockResolvedValue({
        itemId: ITEM_ID,
        text: 'hello',
        library: TEXT_EXTRACTION_LIBRARY,
        fidelity: [],
        characters: 5,
      }),
      convertToPdf: jest.fn().mockResolvedValue({
        itemId: ITEM_ID,
        format: 'pdf',
        stream: Readable.from([Buffer.from('%PDF-1.7')]),
        contentType: 'application/pdf',
      }),
      createFromTemplate: jest.fn().mockResolvedValue({
        itemId: 'COPY-1',
        name: 'Invoice.docx',
        templateItemId: TEMPLATE_ID,
        mode: 'text-substitution',
        applied: ['{{client_name}}'],
        missing: [],
      }),
      replaceDocument: jest.fn().mockResolvedValue({ itemId: ITEM_ID, name: DOCX }),
      ...overrides,
    };
  }

  it('delegates the three queries with the caller id', async () => {
    const service = documentService();
    const { resolver, context } = buildResolver(service);

    await resolver.getDocumentMetadata({}, { itemId: ITEM_ID, driveId: 'D1' }, context);
    await resolver.getDocumentText({}, { itemId: ITEM_ID }, context);

    expect(service.getDocumentMetadata).toHaveBeenCalledWith(USER_ID, ITEM_ID, { driveId: 'D1' });
    expect(service.getDocumentText).toHaveBeenCalledWith(USER_ID, ITEM_ID, { driveId: undefined });
  });

  it('buffers a PDF conversion into base64 for GraphQL transport', async () => {
    const service = documentService();
    const { resolver, context } = buildResolver(service);

    const result = await resolver.convertToPdf({}, { itemId: ITEM_ID }, context);

    expect(service.convertToPdf).toHaveBeenCalledWith(USER_ID, ITEM_ID, { driveId: undefined });
    expect(result).toMatchObject({
      itemId: ITEM_ID,
      format: 'PDF',
      contentType: 'application/pdf',
      contentLength: 8,
    });
    expect(Buffer.from(result.contentBase64, 'base64').toString('utf8')).toBe('%PDF-1.7');
  });

  it('fails when a conversion produced no bytes', async () => {
    const service = documentService({
      convertToPdf: jest.fn().mockResolvedValue({
        itemId: ITEM_ID,
        format: 'pdf',
        stream: Readable.from([]),
        contentType: 'application/pdf',
      }),
    });
    const { resolver, context } = buildResolver(service);

    await expect(resolver.convertToPdf({}, { itemId: ITEM_ID }, context)).rejects.toMatchObject({
      code: 'DocumentConversionFailed',
    });
  });

  it('refuses a conversion stream that grows past the ceiling', async () => {
    const service = documentService({
      convertToPdf: jest.fn().mockResolvedValue({
        itemId: ITEM_ID,
        format: 'pdf',
        stream: Readable.from([Buffer.alloc(PDF_CONVERSION_MAX_BYTES + 1)]),
        contentType: 'application/pdf',
      }),
    });
    const { resolver, context } = buildResolver(service);

    await expect(resolver.convertToPdf({}, { itemId: ITEM_ID }, context)).rejects.toMatchObject({
      code: 'FileTooLargeForConversion',
      limit: PDF_CONVERSION_MAX_BYTES,
    });
  });

  it('maps template replacements and states that this is text substitution', async () => {
    const service = documentService();
    const { resolver, context } = buildResolver(service);

    const result = await resolver.createFromTemplate(
      {},
      {
        templateItemId: TEMPLATE_ID,
        name: 'Invoice.docx',
        replacements: [{ token: '{{client_name}}', value: 'Acme' }],
        driveId: 'D1',
      },
      context,
    );

    expect(service.createFromTemplate).toHaveBeenCalledWith(
      USER_ID,
      TEMPLATE_ID,
      'Invoice.docx',
      { '{{client_name}}': 'Acme' },
      { driveId: 'D1' },
    );
    expect(result.mode).toBe('text-substitution');
    expect(result.note).toContain('no server-side Word body-editing API');
  });

  it('refuses a replacement without a token', async () => {
    const service = documentService();
    const { resolver, context } = buildResolver(service);

    await expect(
      resolver.createFromTemplate(
        {},
        { templateItemId: TEMPLATE_ID, name: 'a.docx', replacements: [{ value: 'x' } as any] },
        context,
      ),
    ).rejects.toMatchObject({ code: 'InvalidTemplateReplacement' });
  });

  it('decodes base64 content before replacing a document', async () => {
    const service = documentService();
    const { resolver, context } = buildResolver(service);
    const content = buildDocx();

    await resolver.replaceDocument(
      {},
      { itemId: ITEM_ID, contentBase64: content.toString('base64'), driveId: 'D1' },
      context,
    );

    const [, , passed] = service.replaceDocument.mock.calls[0];
    expect(Buffer.isBuffer(passed)).toBe(true);
    expect(passed.equals(content)).toBe(true);
  });

  it('derives extension, Word detection and the conversion limit', () => {
    const { resolver } = buildResolver(documentService());

    expect(resolver.resolveExtension({ name: 'A.DOCX' })).toBe('.docx');
    expect(resolver.resolveExtension({ name: 'A' })).toBeNull();
    expect(resolver.resolveExtension({})).toBeNull();

    expect(resolver.resolveIsWordDocument({ name: 'A.docx' })).toBe(true);
    expect(resolver.resolveIsWordDocument({ name: 'A', mimeType: DOCX_MIME_TYPE })).toBe(true);
    expect(resolver.resolveIsWordDocument({ name: 'A.pdf' })).toBe(false);

    expect(resolver.resolveConvertibleToPdf({ name: 'A.docx', size: 1024 })).toBe(true);
    expect(resolver.resolveConvertibleToPdf({ name: 'A.docx', size: PDF_CONVERSION_MAX_BYTES })).toBe(true);
    expect(resolver.resolveConvertibleToPdf({ name: 'A.docx', size: PDF_CONVERSION_MAX_BYTES + 1 })).toBe(false);
    expect(resolver.resolveConvertibleToPdf({ name: 'A.docx' })).toBe(false);
    expect(resolver.resolveConvertibleToPdf({ name: 'A.pdf', size: 10 })).toBe(false);

    expect(resolver.resolvePdfConversionLimit()).toBe(PDF_CONVERSION_MAX_BYTES);
  });

  it('fails typed when the document service is not registered', async () => {
    const { resolver } = buildResolver(undefined);

    await expect(
      resolver.getDocumentMetadata({}, { itemId: ITEM_ID }, {
        user: { _id: USER_ID },
        hasRole: () => true,
        getService: (): undefined => undefined,
      }),
    ).rejects.toThrow('Azure Document Service not available');
  });
});
