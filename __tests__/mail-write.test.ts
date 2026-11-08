import ApiError from '@reactory/server-core/exceptions';

import {
  AzureMailService,
  MAIL_ERROR_CODES,
  setMailHttpClient,
} from '../services/AzureMailService';
import { apiError } from '../utils/graph-error';
import {
  MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES,
  MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE,
  type IMailAttachmentInput,
  type IMailHttpRequest,
  type IMailMessageInput,
} from '../types/mail.types';

/**
 * Behavioural suite for the AZ-05 write surface.
 *
 * The Graph provider is faked (this module has no tenant, so no live Graph call
 * may be made) and the resumable-upload transport is replaced through
 * `setMailHttpClient`. The suite is deliberately about the *contract*:
 *
 *   - a failed send REJECTS with a typed `ApiError` and never resolves anything -
 *     the direct repair of audit D6, where `sendEmail` caught its own failure and
 *     returned Express's `response` module export (a truthy object);
 *   - reply/forward address Graph's sub-paths and carry no locally-built quoting;
 *   - an attachment at or above the 3 MB ceiling goes through
 *     `createUploadSession` in fragments, and a send that cannot upload it
 *     rejects instead of sending a message with a missing file.
 *
 * The exact wire body is asserted separately in
 * `mail-write.request-shape.test.ts`, against the real provider.
 */

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const MESSAGE_ID = 'AAMkAGI2';

interface IFakes {
  service: AzureMailService;
  provider: any;
  chain: any;
}

/** A fluent SDK chain plus a provider that hands it back. */
function createFakes(): IFakes {
  const chain: any = {};
  chain.api = jest.fn(() => chain);
  chain.post = jest.fn();
  chain.patch = jest.fn();
  chain.delete = jest.fn();
  chain.get = jest.fn();

  const provider: any = {
    request: jest.fn(),
    requestAll: jest.fn(),
    getClient: jest.fn(() => chain),
  };

  const redis: any = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const context: any = { getService: jest.fn(() => undefined) };

  const service = new AzureMailService({} as any, context);
  service.setGraphClientProvider(provider);
  service.setRedisService(redis);

  return { service, provider, chain };
}

function baseMessage(overrides: Partial<IMailMessageInput> = {}): IMailMessageInput {
  return {
    subject: 'Quarterly report',
    body: { contentType: 'HTML', content: '<p>Please review</p>' },
    toRecipients: [{ name: 'Bob', address: 'bob@example.test' }],
    ...overrides,
  };
}

/** A base64 attachment of exactly `sizeBytes` bytes. */
function attachment(sizeBytes: number, name = 'report.pdf'): IMailAttachmentInput {
  return {
    name,
    contentType: 'application/pdf',
    contentBytes: Buffer.alloc(sizeBytes, 0x41).toString('base64'),
  };
}

/** The Graph message id every successful create answers with. */
const CREATED = { id: MESSAGE_ID, subject: 'Quarterly report' };

afterEach(() => {
  // Always restore the production transport; a leaked fake would be a silent
  // "no live Graph call" violation in a later test.
  setMailHttpClient(null);
});

describe('AzureMailService — sendMessage failure contract (audit D6)', () => {
  it('rejects with the Graph ApiError and never resolves anything', async () => {
    const { service, chain } = createFakes();

    chain.post.mockRejectedValue({
      statusCode: 400,
      code: 'ErrorInvalidRecipients',
      message: 'The message has no recipients',
    });

    let didResolve = false;
    let resolved: unknown;
    let failure: any;

    try {
      resolved = await service.sendMessage(USER_ID, baseMessage());
      didResolve = true;
    } catch (error) {
      failure = error;
    }

    // The defect this ticket repairs: a failed send used to resolve a truthy
    // module export. It must now reject, and nothing may be resolved at all.
    expect(didResolve).toBe(false);
    expect(resolved).toBeUndefined();
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe('ErrorInvalidRecipients');
    expect(failure.message).toBe('The message has no recipients');
  });

  it('rejects rather than resolving when the provider cannot build a client', async () => {
    const { service, provider } = createFakes();

    provider.getClient.mockImplementation(() => {
      throw apiError('NotConnected', 'No Microsoft Graph token is available for this user');
    });

    await expect(service.sendMessage(USER_ID, baseMessage())).rejects.toMatchObject({
      code: 'NotConnected',
    });
  });

  it('rejects an address-less recipient before any Graph request is made', async () => {
    const { service, provider } = createFakes();

    await expect(
      service.sendMessage(USER_ID, baseMessage({ toRecipients: [{ address: '' }] })),
    ).rejects.toMatchObject({ code: MAIL_ERROR_CODES.INVALID_RECIPIENT });

    expect(provider.getClient).not.toHaveBeenCalled();
  });

  it('rejects a message with no recipients', async () => {
    const { service, provider } = createFakes();

    await expect(
      service.sendMessage(USER_ID, baseMessage({ toRecipients: [] })),
    ).rejects.toMatchObject({ code: MAIL_ERROR_CODES.INVALID_RECIPIENT });

    expect(provider.getClient).not.toHaveBeenCalled();
  });

  it('rejects an unsupported body contentType instead of defaulting it', async () => {
    const { service, provider } = createFakes();

    await expect(
      service.sendMessage(USER_ID, baseMessage({ body: { contentType: 'markdown', content: '# hi' } })),
    ).rejects.toMatchObject({ code: MAIL_ERROR_CODES.INVALID_MESSAGE });

    expect(provider.getClient).not.toHaveBeenCalled();
  });
});

describe('AzureMailService — reply and forward', () => {
  it('posts /me/messages/{id}/reply with only the comment and no quoting', async () => {
    const { service, chain } = createFakes();
    chain.post.mockResolvedValue(undefined);

    await expect(service.replyToMessage(USER_ID, MESSAGE_ID, { comment: 'Thanks!' }))
      .resolves.toBe(true);

    expect(chain.api).toHaveBeenCalledWith(`/me/messages/${MESSAGE_ID}/reply`);

    const body = chain.post.mock.calls[0][0];
    expect(Object.keys(body)).toEqual(['comment']);
    expect(body).toEqual({ comment: 'Thanks!' });

    // No hand-rolled quoting: no quoted line, no From:/Sent:/Subject: header
    // block. (The `toEqual` above already pins the body; this states the intent.
    // The anchor is `\n>` because a JSON string starts with '{', so `^>` could
    // never match and would make the assertion inert.)
    expect(JSON.stringify(body)).not.toMatch(/\n>|From:|Sent:|Subject:/);
  });

  it('posts /me/messages/{id}/replyAll', async () => {
    const { service, chain } = createFakes();
    chain.post.mockResolvedValue(undefined);

    await expect(service.replyAll(USER_ID, MESSAGE_ID)).resolves.toBe(true);

    expect(chain.api).toHaveBeenCalledWith(`/me/messages/${MESSAGE_ID}/replyAll`);
    expect(chain.post).toHaveBeenCalledWith({});
  });

  it('posts /me/messages/{id}/forward with the comment and the recipients', async () => {
    const { service, chain } = createFakes();
    chain.post.mockResolvedValue(undefined);

    await expect(
      service.forwardMessage(USER_ID, MESSAGE_ID, {
        comment: 'FYI',
        toRecipients: [{ name: 'Carol', address: 'carol@example.test' }],
      }),
    ).resolves.toBe(true);

    expect(chain.api).toHaveBeenCalledWith(`/me/messages/${MESSAGE_ID}/forward`);
    expect(chain.post).toHaveBeenCalledWith({
      comment: 'FYI',
      toRecipients: [{ emailAddress: { address: 'carol@example.test', name: 'Carol' } }],
    });
  });

  it('rejects toRecipients on reply: only forward may address new recipients', async () => {
    const { service, provider } = createFakes();

    await expect(
      service.replyToMessage(USER_ID, MESSAGE_ID, {
        comment: 'x',
        toRecipients: ['carol@example.test'],
      }),
    ).rejects.toMatchObject({ code: MAIL_ERROR_CODES.INVALID_RECIPIENT });

    expect(provider.getClient).not.toHaveBeenCalled();
  });

  it('rejects a reply failure instead of resolving a truthy value', async () => {
    const { service, chain } = createFakes();
    chain.post.mockRejectedValue({ statusCode: 404, code: 'ErrorItemNotFound', message: 'gone' });

    await expect(service.replyToMessage(USER_ID, MESSAGE_ID, { comment: 'x' }))
      .rejects.toMatchObject({ code: 'ErrorItemNotFound' });
  });
});

describe('AzureMailService — drafts', () => {
  it('creates a draft with POST /me/messages and never sends isDraft', async () => {
    const { service, chain } = createFakes();
    chain.post.mockResolvedValue(CREATED);

    const draft = await service.createDraft(USER_ID, baseMessage({ toRecipients: [] }));

    expect(chain.api).toHaveBeenCalledWith('/me/messages');
    expect(chain.post.mock.calls[0][0]).not.toHaveProperty('isDraft');
    expect(draft.id).toBe(MESSAGE_ID);
    expect(draft.toRecipients).toEqual([]);
  });

  it('rejects when Graph answers a draft create without an id', async () => {
    const { service, chain } = createFakes();
    chain.post.mockResolvedValue({ subject: 'no id' });

    await expect(service.createDraft(USER_ID, baseMessage())).rejects.toBeInstanceOf(ApiError);
  });

  it('PATCHes only the supplied draft fields', async () => {
    const { service, chain } = createFakes();
    chain.patch.mockResolvedValue({ id: MESSAGE_ID, subject: 'Updated' });

    const updated = await service.updateDraft(USER_ID, MESSAGE_ID, { subject: 'Updated' });

    expect(chain.api).toHaveBeenCalledWith(`/me/messages/${MESSAGE_ID}`);
    expect(chain.patch).toHaveBeenCalledWith({ subject: 'Updated' });
    expect(updated.subject).toBe('Updated');
  });

  it('rejects an empty draft patch rather than issuing a no-op', async () => {
    const { service, provider } = createFakes();

    await expect(service.updateDraft(USER_ID, MESSAGE_ID, {}))
      .rejects.toMatchObject({ code: MAIL_ERROR_CODES.INVALID_MESSAGE });

    expect(provider.getClient).not.toHaveBeenCalled();
  });

  it('sends a draft with POST /me/messages/{id}/send', async () => {
    const { service, chain } = createFakes();
    chain.post.mockResolvedValue(undefined);

    await expect(service.sendDraft(USER_ID, MESSAGE_ID)).resolves.toBe(true);

    expect(chain.api).toHaveBeenCalledWith(`/me/messages/${MESSAGE_ID}/send`);
    expect(chain.post).toHaveBeenCalledTimes(1);
    expect(chain.post.mock.calls[0]).toEqual([]);
  });

  it('rejects a draft send failure', async () => {
    const { service, chain } = createFakes();
    chain.post.mockRejectedValue({ statusCode: 400, code: 'ErrorInvalidRequest', message: 'bad' });

    await expect(service.sendDraft(USER_ID, MESSAGE_ID)).rejects.toMatchObject({
      code: 'ErrorInvalidRequest',
    });
  });

  it('deletes a draft with DELETE /me/messages/{id}', async () => {
    const { service, chain } = createFakes();
    chain.delete.mockResolvedValue(undefined);

    await expect(service.deleteDraft(USER_ID, MESSAGE_ID)).resolves.toBe(true);

    expect(chain.api).toHaveBeenCalledWith(`/me/messages/${MESSAGE_ID}`);
    expect(chain.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects a draft delete failure', async () => {
    const { service, chain } = createFakes();
    chain.delete.mockRejectedValue({ statusCode: 404, code: 'ErrorItemNotFound', message: 'gone' });

    await expect(service.deleteDraft(USER_ID, MESSAGE_ID))
      .rejects.toMatchObject({ code: 'ErrorItemNotFound' });
  });
});

describe('AzureMailService — attachment reads', () => {
  it('lists attachment metadata without requesting contentBytes', async () => {
    const { service, provider } = createFakes();

    provider.requestAll.mockResolvedValue([
      { id: 'att-1', name: 'a.pdf', contentType: 'application/pdf', size: 12, isInline: false },
      { id: 'att-2', name: 'b.png', contentType: 'image/png', size: 34, isInline: true },
    ]);

    const attachments = await service.listAttachments(USER_ID, MESSAGE_ID);

    expect(provider.requestAll).toHaveBeenCalledWith(
      USER_ID,
      `/me/messages/${MESSAGE_ID}/attachments`,
      { select: 'id,name,contentType,size,isInline,lastModifiedDateTime', operation: 'listAttachments' },
    );

    expect(attachments).toEqual([
      { id: 'att-1', name: 'a.pdf', contentType: 'application/pdf', size: 12 },
      { id: 'att-2', name: 'b.png', contentType: 'image/png', size: 34, isInline: true },
    ]);

    for (const entry of attachments) {
      expect(entry).not.toHaveProperty('contentBytes');
    }
  });

  it('returns exactly { name, contentType, size, contentBytes } for one attachment', async () => {
    const { service, provider } = createFakes();

    provider.request.mockResolvedValue({
      id: 'att-1',
      name: 'a.pdf',
      contentType: 'application/pdf',
      size: 3,
      isInline: false,
      contentBytes: 'QUJD',
      lastModifiedDateTime: '2026-11-01T00:00:00Z',
    });

    const attachment = await service.getAttachment(USER_ID, MESSAGE_ID, 'att-1');

    expect(provider.request).toHaveBeenCalledWith(
      USER_ID,
      `/me/messages/${MESSAGE_ID}/attachments/att-1`,
      expect.objectContaining({ operation: 'getAttachment' }),
    );

    expect(attachment).toEqual({
      name: 'a.pdf',
      contentType: 'application/pdf',
      size: 3,
      contentBytes: 'QUJD',
    });
  });

  it('rejects an attachment Graph returned without contentBytes', async () => {
    const { service, provider } = createFakes();
    provider.request.mockResolvedValue({ id: 'att-9', name: 'inline-image' });

    await expect(service.getAttachment(USER_ID, MESSAGE_ID, 'att-9'))
      .rejects.toMatchObject({ code: MAIL_ERROR_CODES.INVALID_ATTACHMENT });
  });
});

describe('AzureMailService — attachment routing', () => {
  it('sends a 100 KB attachment inline in the single sendMail request', async () => {
    const { service, chain, provider } = createFakes();
    chain.post.mockResolvedValue(undefined);

    const transport = jest.fn();
    setMailHttpClient(transport);

    const small = attachment(100 * 1024);
    await expect(service.sendMessage(USER_ID, baseMessage({ attachments: [small] })))
      .resolves.toBe(true);

    // One request only, to sendMail, with the payload inline.
    expect(chain.api).toHaveBeenCalledTimes(1);
    expect(chain.api).toHaveBeenCalledWith('/me/sendMail');

    const body = chain.post.mock.calls[0][0];
    expect(body.message.attachments).toHaveLength(1);
    expect(body.message.attachments[0]).toMatchObject({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'report.pdf',
      contentType: 'application/pdf',
      contentBytes: small.contentBytes,
    });

    // No upload session, no raw transport hop.
    expect(provider.getClient).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it('streams a 3 MB attachment through createUploadSession, then sends the draft', async () => {
    const { service, chain } = createFakes();

    chain.post
      .mockResolvedValueOnce({ id: 'draft-1' }) // POST /me/messages
      .mockResolvedValueOnce({ uploadUrl: 'https://outlook.office.com/upload/session-1' }) // createUploadSession
      .mockResolvedValueOnce(undefined); // POST /send

    // Graph answers intermediate fragments with 202 + nextExpectedRanges and the
    // final one with 201; mirror that rather than a blanket 201.
    const transport = jest.fn(async (request: IMailHttpRequest) => {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers?.['Content-Range'] || '');
      const end = Number(match?.[2]);
      const total = Number(match?.[3]);

      return end + 1 >= total
        ? { status: 201, headers: {}, body: { id: 'att-1' } }
        : { status: 202, headers: {}, body: { nextExpectedRanges: [`${end + 1}-`] } };
    });
    setMailHttpClient(transport);

    const big = attachment(MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES);
    await expect(service.sendMessage(USER_ID, baseMessage({ attachments: [big] })))
      .resolves.toBe(true);

    // sendMail was never used: the attachment cannot travel inline.
    expect(chain.api).not.toHaveBeenCalledWith('/me/sendMail');

    // 1. draft created
    expect(chain.api).toHaveBeenCalledWith('/me/messages');

    // 2. upload session for the draft
    expect(chain.api).toHaveBeenCalledWith(
      '/me/messages/draft-1/attachments/createUploadSession',
    );
    const sessionBody = chain.post.mock.calls[1][0];
    expect(sessionBody).toEqual({
      AttachmentItem: {
        attachmentType: 'file',
        name: 'report.pdf',
        size: MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES,
        contentType: 'application/pdf',
      },
    });

    // 3. the draft is sent only after every fragment landed
    expect(chain.api).toHaveBeenCalledWith('/me/messages/draft-1/send');

    const expectedFragments = Math.ceil(
      MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES / MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE,
    );

    expect(expectedFragments).toBe(3);
    expect(transport).toHaveBeenCalledTimes(expectedFragments);

    const calls = transport.mock.calls.map(([request]) => request as IMailHttpRequest);

    expect(calls[0].url).toBe('https://outlook.office.com/upload/session-1');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].headers).toMatchObject({
      'Content-Range': `bytes 0-${MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE - 1}/${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES}`,
      'Content-Type': 'application/pdf',
    });

    // Every fragment is 320 KiB-multiple addressed and the last one ends the file.
    const lastOffset = (expectedFragments - 1) * MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE;
    expect(calls[expectedFragments - 1].headers?.['Content-Range']).toBe(
      `bytes ${lastOffset}-${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES - 1}`
        + `/${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES}`,
    );

    // The upload URL is pre-authenticated: no bearer token may be attached.
    for (const call of calls) {
      expect(call.headers).not.toHaveProperty('Authorization');
      expect(call.headers).not.toHaveProperty('authorization');
    }
  });

  it('rejects and does not send when a fragment upload fails', async () => {
    const { service, chain } = createFakes();

    chain.post
      .mockResolvedValueOnce({ id: 'draft-1' })
      .mockResolvedValueOnce({ uploadUrl: 'https://outlook.office.com/upload/session-1' });

    chain.delete.mockResolvedValue(undefined);

    const transport = jest.fn().mockResolvedValue({
      status: 500,
      headers: {},
      body: JSON.stringify({ error: { code: 'generalException', message: 'fragment refused' } }),
    });
    setMailHttpClient(transport);

    await expect(
      service.sendMessage(USER_ID, baseMessage({ attachments: [attachment(MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES)] })),
    ).rejects.toMatchObject({ code: 'generalException' });

    // The message was never sent with a missing attachment ...
    expect(chain.api).not.toHaveBeenCalledWith('/me/messages/draft-1/send');
    // ... and the transient draft was cleaned up.
    expect(chain.api).toHaveBeenCalledWith('/me/messages/draft-1');
    expect(chain.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects an attachment with no contentBytes instead of dropping it', async () => {
    const { service, provider } = createFakes();

    await expect(
      service.sendMessage(USER_ID, baseMessage({
        attachments: [{ name: 'empty.pdf', contentBytes: '' }],
      })),
    ).rejects.toMatchObject({ code: MAIL_ERROR_CODES.INVALID_ATTACHMENT });

    // Nothing was sent: a send that cannot carry every attachment must not happen.
    expect(provider.getClient).not.toHaveBeenCalled();
  });

  it('rejects a non-base64 attachment payload', async () => {
    const { service, provider } = createFakes();

    await expect(
      service.sendMessage(USER_ID, baseMessage({
        attachments: [{ name: 'broken.pdf', contentBytes: 'not base64!!!' }],
      })),
    ).rejects.toMatchObject({ code: MAIL_ERROR_CODES.INVALID_ATTACHMENT });

    expect(provider.getClient).not.toHaveBeenCalled();
  });

  it('rejects saveToSentItems:false when a resumable upload is required', async () => {
    const { service, provider } = createFakes();

    await expect(
      service.sendMessage(
        USER_ID,
        baseMessage({ attachments: [attachment(MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES)] }),
        { saveToSentItems: false },
      ),
    ).rejects.toMatchObject({ code: MAIL_ERROR_CODES.SAVE_TO_SENT_ITEMS_UNSUPPORTED });

    // Refused before creating a draft that would silently save to Sent Items.
    expect(provider.getClient).not.toHaveBeenCalled();
  });

  it('rejects a forward with no recipients before any Graph request', async () => {
    const { service, provider } = createFakes();

    await expect(service.forwardMessage(USER_ID, MESSAGE_ID, { comment: 'FYI' }))
      .rejects.toMatchObject({ code: MAIL_ERROR_CODES.INVALID_RECIPIENT });

    await expect(service.forwardMessage(USER_ID, MESSAGE_ID, { toRecipients: [] }))
      .rejects.toMatchObject({ code: MAIL_ERROR_CODES.INVALID_RECIPIENT });

    // The neighbouring mistake (recipients on a reply) is rejected just as early.
    expect(provider.getClient).not.toHaveBeenCalled();
  });

  it('rejects a non-array attachments value instead of iterating it', async () => {
    const { service, provider } = createFakes();

    await expect(
      service.sendMessage(USER_ID, baseMessage({ attachments: 'not-an-array' as any })),
    ).rejects.toMatchObject({ code: MAIL_ERROR_CODES.INVALID_ATTACHMENT });

    expect(provider.getClient).not.toHaveBeenCalled();
  });

  it('rejects an upload session Graph did not authorise', async () => {
    const { service, chain } = createFakes();

    chain.post
      .mockResolvedValueOnce({ id: 'draft-1' })
      .mockResolvedValueOnce({}); // no uploadUrl

    chain.delete.mockResolvedValue(undefined);

    await expect(
      service.sendMessage(USER_ID, baseMessage({ attachments: [attachment(MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES)] })),
    ).rejects.toMatchObject({ code: MAIL_ERROR_CODES.MISSING_UPLOAD_URL });

    expect(chain.api).not.toHaveBeenCalledWith('/me/messages/draft-1/send');
  });
});

/* -------------------------------------------------------------------------- */
/* Production transport (B1)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * These tests exercise `defaultMailHttpClient` itself - the transport that runs
 * in production - by stubbing `globalThis.fetch` with a REAL `Response`.
 *
 * That distinction is the whole point: every other test replaces the transport
 * through `setMailHttpClient`, which is why a transport that returned
 * `response.body` (a ReadableStream, not JSON) passed a green suite while losing
 * the Graph error code in production. `Response.text()` is now read in the
 * transport, so the 400/416/202 payloads below are actually parsed.
 */
describe('AzureMailService — production attachment transport (real Response)', () => {
  const originalFetch = (globalThis as any).fetch;

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    setMailHttpClient(null);
  });

  /** A 3 MB attachment: three 1.25 MiB fragments. */
  function bigAttachment(): IMailAttachmentInput {
    return {
      name: 'report.pdf',
      contentType: 'application/pdf',
      contentBytes: Buffer.alloc(MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES, 0x41).toString('base64'),
    };
  }

  /** The draft + upload session the transport tests start from. */
  function primeSession(chain: any): void {
    chain.post
      .mockResolvedValueOnce({ id: 'draft-1' })
      .mockResolvedValueOnce({ uploadUrl: 'https://outlook.office.com/upload/session-1' });
    chain.delete.mockResolvedValue(undefined);
  }

  /** A real `Response` carrying JSON, exactly as `fetch` would return it. */
  function jsonResponse(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('surfaces the Graph code and message from a 400 (the body is now read)', async () => {
    const { service, chain } = createFakes();
    primeSession(chain);

    const fetchStub = jest.fn(async () => jsonResponse(400, {
      error: { code: 'resyncRequired', message: 'fragment refused' },
    }));
    (globalThis as any).fetch = fetchStub;

    const failure = await service
      .sendMessage(USER_ID, baseMessage({ attachments: [bigAttachment()] }))
      .catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as any).code).toBe('resyncRequired');
    expect((failure as any).message).toBe('fragment refused');

    // The Graph code survives translation rather than collapsing to the generic
    // fallback - the error-contract half of this ticket.
    expect((failure as any).graphCode).toBe('resyncRequired');
    expect((failure as any).status).toBe(400);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    // A failed upload must not send the draft.
    expect(chain.api).not.toHaveBeenCalledWith('/me/messages/draft-1/send');
  });

  it('honours nextExpectedRanges from a 202 instead of falling back to `end`', async () => {
    const { service, chain } = createFakes();
    primeSession(chain);

    const offsets: string[] = [];
    let call = 0;

    (globalThis as any).fetch = jest.fn(async (_url: string, init: any) => {
      offsets.push(init.headers['Content-Range']);
      call += 1;

      // First fragment: Graph says it already has bytes up to 2621440, so the next
      // fragment must start there (skipping the second 1.25 MiB block entirely).
      if (call === 1) return jsonResponse(202, { nextExpectedRanges: ['2621440-'] });

      return jsonResponse(201, { id: 'att-1' });
    });

    await expect(service.sendMessage(USER_ID, baseMessage({ attachments: [bigAttachment()] })))
      .resolves.toBe(true);

    expect(offsets[0]).toBe(`bytes 0-${MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE - 1}/${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES}`);
    // The parsed cursor - not the local `end` of the first fragment - drives this.
    expect(offsets[1]).toBe(
      `bytes 2621440-${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES - 1}/${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES}`,
    );

    // Two requests, not three: the cursor skipped a fragment.
    expect(offsets).toHaveLength(2);
  });

  it('advances to a 202 nextExpectedRanges cursor of 1310720', async () => {
    const { service, chain } = createFakes();
    primeSession(chain);

    const offsets: string[] = [];
    let call = 0;

    (globalThis as any).fetch = jest.fn(async (_url: string, init: any) => {
      offsets.push(init.headers['Content-Range']);
      call += 1;

      if (call === 1) return jsonResponse(202, { nextExpectedRanges: ['1310720-'] });

      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(init.headers['Content-Range'] || '');
      const end = Number(range?.[2]);
      const total = Number(range?.[3]);

      return end + 1 >= total
        ? jsonResponse(201, { id: 'att-1' })
        : jsonResponse(202, { nextExpectedRanges: [`${end + 1}-`] });
    });
    await expect(service.sendMessage(USER_ID, baseMessage({ attachments: [bigAttachment()] })))
      .resolves.toBe(true);

    expect(offsets[1]).toBe(
      // The cursor moved the offset to 1310720, so this fragment is the second
      // 1.25 MiB block - not the tail of the file.
      `bytes 1310720-2621439/${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES}`,
    );
  });

  it('resumes from a 416 that reports a higher next range', async () => {
    const { service, chain } = createFakes();
    primeSession(chain);

    const offsets: string[] = [];
    let call = 0;

    (globalThis as any).fetch = jest.fn(async (_url: string, init: any) => {
      offsets.push(init.headers['Content-Range']);
      call += 1;

      if (call === 1) return jsonResponse(416, { nextExpectedRanges: ['1310720-'] });
      if (call === 2) return jsonResponse(202, { nextExpectedRanges: ['2621440-'] });

      return jsonResponse(201, { id: 'att-1' });
    });

    await expect(service.sendMessage(USER_ID, baseMessage({ attachments: [bigAttachment()] })))
      .resolves.toBe(true);

    // The refused fragment is not retried from 0: the server names where to resume.
    expect(offsets).toEqual([
      `bytes 0-${MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE - 1}/${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES}`,
      `bytes 1310720-2621439/${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES}`,
      `bytes 2621440-${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES - 1}/${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES}`,
    ]);

    expect(chain.api).toHaveBeenCalledWith('/me/messages/draft-1/send');
  });

  it('rejects a 201 that arrives before the final byte', async () => {
    const { service, chain } = createFakes();
    primeSession(chain);

    (globalThis as any).fetch = jest.fn(async () => jsonResponse(201, { id: 'att-1' }));

    await expect(service.sendMessage(USER_ID, baseMessage({ attachments: [bigAttachment()] })))
      .rejects.toMatchObject({ code: MAIL_ERROR_CODES.UPLOAD_FAILED });

    // A truncated upload must never be followed by the send.
    expect(chain.api).not.toHaveBeenCalledWith('/me/messages/draft-1/send');
  });

  it('treats a final 202 as unconfirmed, then accepts it when the read-back finds the file', async () => {
    const { service, chain, provider } = createFakes();
    primeSession(chain);
    provider.requestAll.mockResolvedValue([{ id: 'att-1', name: 'report.pdf' }]);

    // Every fragment answers 202 with no cursor: the loop advances by `end` and
    // falls through to the read-back verification.
    (globalThis as any).fetch = jest.fn(async () => jsonResponse(202, {}));

    await expect(service.sendMessage(USER_ID, baseMessage({ attachments: [bigAttachment()] })))
      .resolves.toBe(true);

    expect(provider.requestAll).toHaveBeenCalledWith(
      USER_ID,
      '/me/messages/draft-1/attachments',
      expect.objectContaining({ operation: 'listAttachments' }),
    );
    expect(chain.api).toHaveBeenCalledWith('/me/messages/draft-1/send');
  });

  it('rejects when the read-back cannot confirm a final-202 upload', async () => {
    const { service, chain, provider } = createFakes();
    primeSession(chain);
    provider.requestAll.mockResolvedValue([]);

    (globalThis as any).fetch = jest.fn(async () => jsonResponse(202, {}));

    await expect(service.sendMessage(USER_ID, baseMessage({ attachments: [bigAttachment()] })))
      .rejects.toMatchObject({ code: MAIL_ERROR_CODES.UPLOAD_FAILED });

    expect(chain.api).not.toHaveBeenCalledWith('/me/messages/draft-1/send');
  });

  it('never sends an Authorization header to the pre-authenticated upload URL', async () => {
    const { service, chain } = createFakes();
    primeSession(chain);

    const headers: any[] = [];
    (globalThis as any).fetch = jest.fn(async (_url: string, init: any) => {
      headers.push(init.headers);

      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(init.headers['Content-Range'] || '');
      const end = Number(range?.[2]);
      const total = Number(range?.[3]);

      return end + 1 >= total
        ? jsonResponse(201, { id: 'att-1' })
        : jsonResponse(202, { nextExpectedRanges: [`${end + 1}-`] });
    });

    await service.sendMessage(USER_ID, baseMessage({ attachments: [bigAttachment()] }));

    const names = headers.flatMap((bag) => Object.keys(bag || {}).map((key) => key.toLowerCase()));
    expect(names).not.toContain('authorization');
  });
});

/* -------------------------------------------------------------------------- */
/* Remaining write branches (F3)                                               */
/* -------------------------------------------------------------------------- */

describe('AzureMailService — write guards and transport translation', () => {
  it('rejects a non-object draft patch', async () => {
    const { service, provider } = createFakes();

    await expect(service.updateDraft(USER_ID, MESSAGE_ID, null as any))
      .rejects.toMatchObject({ code: MAIL_ERROR_CODES.INVALID_MESSAGE });

    expect(provider.getClient).not.toHaveBeenCalled();
  });

  it('rejects an empty attachment id', async () => {
    const { service, provider } = createFakes();

    await expect(service.getAttachment(USER_ID, MESSAGE_ID, '   '))
      .rejects.toMatchObject({ code: MAIL_ERROR_CODES.INVALID_ATTACHMENT });

    expect(provider.request).not.toHaveBeenCalled();
  });

  it('rejects an empty userId on every AZ-05 entry point', async () => {
    const { service, provider } = createFakes();

    const attempts = [
      service.sendMessage('', baseMessage()),
      service.replyToMessage('  ', MESSAGE_ID),
      service.replyAll('', MESSAGE_ID),
      service.forwardMessage('', MESSAGE_ID, { toRecipients: ['a@b.test'] }),
      service.createDraft('', baseMessage()),
      service.updateDraft('', MESSAGE_ID, { subject: 'x' }),
      service.sendDraft('', MESSAGE_ID),
      service.deleteDraft('', MESSAGE_ID),
      service.listAttachments('', MESSAGE_ID),
      service.getAttachment('', MESSAGE_ID, 'att-1'),
    ];

    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({ code: 'NotConnected' });
    }

    expect(provider.getClient).not.toHaveBeenCalled();
    expect(provider.request).not.toHaveBeenCalled();
    expect(provider.requestAll).not.toHaveBeenCalled();
  });

  it('translates a transport throw into an ApiError', async () => {
    const { service, chain } = createFakes();
    chain.post
      .mockResolvedValueOnce({ id: 'draft-1' })
      .mockResolvedValueOnce({ uploadUrl: 'https://outlook.office.com/upload/session-1' });
    chain.delete.mockResolvedValue(undefined);

    setMailHttpClient(jest.fn().mockRejectedValue(new Error('socket hang up')));

    const failure = await service
      .sendMessage(USER_ID, baseMessage({ attachments: [attachment(MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES)] }))
      .catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as any).code).toBe('GraphRequestFailed');
    expect((failure as any).message).toBe('socket hang up');
  });

  it('parses a Buffer response body for the Graph code', async () => {
    const { service, chain } = createFakes();
    chain.post
      .mockResolvedValueOnce({ id: 'draft-1' })
      .mockResolvedValueOnce({ uploadUrl: 'https://outlook.office.com/upload/session-1' });
    chain.delete.mockResolvedValue(undefined);

    setMailHttpClient(jest.fn().mockResolvedValue({
      status: 403,
      headers: {},
      body: Buffer.from(JSON.stringify({ error: { code: 'ErrorAccessDenied', message: 'denied' } })),
    }));

    await expect(
      service.sendMessage(USER_ID, baseMessage({ attachments: [attachment(MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES)] })),
    ).rejects.toMatchObject({ code: 'ErrorAccessDenied' });
  });

  it('falls back to a { message } payload when the body is not JSON', async () => {
    const { service, chain } = createFakes();
    chain.post
      .mockResolvedValueOnce({ id: 'draft-1' })
      .mockResolvedValueOnce({ uploadUrl: 'https://outlook.office.com/upload/session-1' });
    chain.delete.mockResolvedValue(undefined);

    setMailHttpClient(jest.fn().mockResolvedValue({
      status: 500,
      headers: {},
      body: 'upstream proxy error',
    }));

    const failure = await service
      .sendMessage(USER_ID, baseMessage({ attachments: [attachment(MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES)] }))
      .catch((error) => error);

    expect((failure as any).code).toBe('GraphRequestFailed');
    expect((failure as any).message).toBe('upstream proxy error');
    expect((failure as any).status).toBe(500);
  });

  it('rejects a write when the provider cannot build a client at all', async () => {
    const { service } = createFakes();

    // A provider object with no `getClient`: the guard, not a thrown call.
    service.setGraphClientProvider({ request: jest.fn(), requestAll: jest.fn() });

    await expect(service.sendDraft(USER_ID, MESSAGE_ID))
      .rejects.toMatchObject({ code: 'NotConnected' });
  });
});