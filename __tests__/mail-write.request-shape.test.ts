import ApiError from '@reactory/server-core/exceptions';

/**
 * Request-shape suite for the AZ-05 write surface.
 *
 * The Graph SDK is mocked (the module has no tenant and must never make a live
 * call), but the **real** `AzureGraphClientProvider` sits between the service and
 * the SDK, so every assertion below covers the request the service actually
 * produces: the path, the body and - for a resumable attachment - the fragment
 * headers. The resumable-upload transport is replaced, because `uploadUrl` is a
 * pre-authenticated host that must not receive a bearer token.
 */
jest.mock('@microsoft/microsoft-graph-client', () => ({
  Client: { init: jest.fn() },
  ResponseType: { RAW: 'raw', TEXT: 'text', JSON: 'json' },
}));

// eslint-disable-next-line import/first
import { Client } from '@microsoft/microsoft-graph-client';
// eslint-disable-next-line import/first
import { AzureGraphClientProvider } from '../services/graph/AzureGraphClientProvider';
// eslint-disable-next-line import/first
import { AzureMailService, setMailHttpClient } from '../services/AzureMailService';
// eslint-disable-next-line import/first
import {
  MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES,
  MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE,
  type IMailAttachmentInput,
  type IMailHttpRequest,
  type IMailMessageInput,
} from '../types/mail.types';

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';
const MESSAGE_ID = 'AAMkAGI2';

/** The fluent SDK chain the provider talks to. */
function mockSdk(): any {
  const chain: any = {};
  chain.api = jest.fn(() => chain);
  chain.version = jest.fn(() => chain);
  chain.query = jest.fn(() => chain);
  chain.headers = jest.fn(() => chain);
  chain.get = jest.fn();
  chain.post = jest.fn();
  chain.patch = jest.fn();
  chain.delete = jest.fn();

  (Client.init as jest.Mock).mockReturnValue(chain);
  return chain;
}

function createService(): { service: AzureMailService } {
  const authService = {
    getToken: jest.fn().mockResolvedValue({ token: 'vault-token', source: 'vault' }),
  };

  const context: any = {
    getService: jest.fn((id: string) =>
      (id === 'azure.AzureAuthService@1.0.0' ? authService : undefined)),
  };

  const provider = new AzureGraphClientProvider({} as any, context);
  provider.setAzureAuthService(authService);

  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const service = new AzureMailService({} as any, context);
  service.setGraphClientProvider(provider);
  service.setRedisService(redis);

  return { service };
}

function baseMessage(overrides: Partial<IMailMessageInput> = {}): IMailMessageInput {
  return {
    subject: 'Quarterly report',
    body: { contentType: 'HTML', content: '<p>Please review</p>' },
    toRecipients: [{ name: 'Bob', address: 'bob@example.test' }],
    ...overrides,
  };
}

function attachment(sizeBytes: number, name = 'report.pdf'): IMailAttachmentInput {
  return {
    name,
    contentType: 'application/pdf',
    contentBytes: Buffer.alloc(sizeBytes, 0x41).toString('base64'),
  };
}

const CREATED = { id: MESSAGE_ID, subject: 'Quarterly report' };

afterEach(() => setMailHttpClient(null));

describe('AzureMailService — sendMail request shape', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts the message and saveToSentItems to /me/sendMail exactly', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.post.mockResolvedValue(undefined);

    await service.sendMessage(USER_ID, baseMessage({
      ccRecipients: ['carol@example.test'],
      bccRecipients: [{ address: 'audit@example.test' }],
      importance: 'high',
    }));

    expect(chain.api).toHaveBeenCalledWith('/me/sendMail');
    expect(chain.post).toHaveBeenCalledTimes(1);

    const body = chain.post.mock.calls[0][0];

    expect(body).toEqual({
      message: {
        body: { contentType: 'HTML', content: '<p>Please review</p>' },
        subject: 'Quarterly report',
        toRecipients: [{ emailAddress: { address: 'bob@example.test', name: 'Bob' } }],
        ccRecipients: [{ emailAddress: { address: 'carol@example.test' } }],
        bccRecipients: [{ emailAddress: { address: 'audit@example.test' } }],
        importance: 'high',
      },
      saveToSentItems: true,
    });

    // Nothing invented: no attachments key, no isDraft, no empty recipient lists.
    expect(body.message).not.toHaveProperty('attachments');
    expect(body.message).not.toHaveProperty('isDraft');
    expect(body.message).not.toHaveProperty('replyTo');
  });

  it('honours saveToSentItems:false and omits absent optional fields', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.post.mockResolvedValue(undefined);

    await service.sendMessage(
      USER_ID,
      {
        body: { contentType: 'text', content: 'plain text' },
        toRecipients: ['bob@example.test'],
      },
      { saveToSentItems: false },
    );

    expect(chain.post.mock.calls[0][0]).toEqual({
      message: {
        body: { contentType: 'Text', content: 'plain text' },
        toRecipients: [{ emailAddress: { address: 'bob@example.test' } }],
      },
      saveToSentItems: false,
    });
  });
});

describe('AzureMailService — reply / forward request shape', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts the comment to /me/messages/{id}/reply with no generated quoting', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.post.mockResolvedValue(undefined);

    await expect(service.replyToMessage(USER_ID, MESSAGE_ID, { comment: 'Thanks!' }))
      .resolves.toBe(true);

    expect(chain.api).toHaveBeenCalledWith(`/me/messages/${MESSAGE_ID}/reply`);
    expect(chain.api).not.toHaveBeenCalledWith('/me/sendMail');

    const body = chain.post.mock.calls[0][0];
    expect(body).toEqual({ comment: 'Thanks!' });
    expect(Object.keys(body)).toEqual(['comment']);
  });

  it('posts to /me/messages/{id}/replyAll', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.post.mockResolvedValue(undefined);

    await service.replyAll(USER_ID, MESSAGE_ID, { comment: 'Noted' });

    expect(chain.api).toHaveBeenCalledWith(`/me/messages/${MESSAGE_ID}/replyAll`);
    expect(chain.post.mock.calls[0][0]).toEqual({ comment: 'Noted' });
  });

  it('posts the comment and recipients to /me/messages/{id}/forward', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.post.mockResolvedValue(undefined);

    await service.forwardMessage(USER_ID, MESSAGE_ID, {
      comment: 'FYI',
      toRecipients: [{ name: 'Carol', address: 'carol@example.test' }],
    });

    expect(chain.api).toHaveBeenCalledWith(`/me/messages/${MESSAGE_ID}/forward`);
    expect(chain.post.mock.calls[0][0]).toEqual({
      comment: 'FYI',
      toRecipients: [{ emailAddress: { address: 'carol@example.test', name: 'Carol' } }],
    });
  });

  it('does not invent a comment when none was supplied', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.post.mockResolvedValue(undefined);

    await service.replyToMessage(USER_ID, MESSAGE_ID);

    expect(chain.post.mock.calls[0][0]).toEqual({});
  });
});

describe('AzureMailService — draft request shape', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a draft with POST /me/messages and no isDraft flag', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.post.mockResolvedValue(CREATED);

    const draft = await service.createDraft(USER_ID, baseMessage());

    expect(chain.api).toHaveBeenCalledWith('/me/messages');

    const body = chain.post.mock.calls[0][0];
    expect(body).not.toHaveProperty('isDraft');
    expect(body).toEqual({
      body: { contentType: 'HTML', content: '<p>Please review</p>' },
      subject: 'Quarterly report',
      toRecipients: [{ emailAddress: { address: 'bob@example.test', name: 'Bob' } }],
    });

    expect(draft.id).toBe(MESSAGE_ID);
  });

  it('updates a draft with PATCH /me/messages/{id} and only the supplied fields', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.patch.mockResolvedValue({ id: MESSAGE_ID, subject: 'Updated' });

    await service.updateDraft(USER_ID, MESSAGE_ID, {
      subject: 'Updated',
      body: { contentType: 'HTML', content: '<p>Updated</p>' },
    });

    expect(chain.api).toHaveBeenCalledWith(`/me/messages/${MESSAGE_ID}`);
    expect(chain.patch).toHaveBeenCalledWith({
      subject: 'Updated',
      body: { contentType: 'HTML', content: '<p>Updated</p>' },
    });
  });

  it('sends a draft with POST /me/messages/{id}/send and no body', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.post.mockResolvedValue(undefined);

    await expect(service.sendDraft(USER_ID, MESSAGE_ID)).resolves.toBe(true);

    expect(chain.api).toHaveBeenCalledWith(`/me/messages/${MESSAGE_ID}/send`);
    expect(chain.post.mock.calls[0]).toEqual([]);
  });

  it('deletes a draft with DELETE /me/messages/{id}', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.delete.mockResolvedValue(undefined);

    await expect(service.deleteDraft(USER_ID, MESSAGE_ID)).resolves.toBe(true);

    expect(chain.api).toHaveBeenCalledWith(`/me/messages/${MESSAGE_ID}`);
    expect(chain.delete).toHaveBeenCalledTimes(1);
  });
});

describe('AzureMailService — attachment request shape', () => {
  beforeEach(() => jest.clearAllMocks());

  it('carries a 100 KB attachment inline in a single sendMail request', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.post.mockResolvedValue(undefined);

    const transport = jest.fn();
    setMailHttpClient(transport);

    const small = attachment(100 * 1024);
    await service.sendMessage(USER_ID, baseMessage({ attachments: [small] }));

    // Exactly one path: the one-shot send.
    expect(chain.api.mock.calls.map((call: any[]) => call[0])).toEqual(['/me/sendMail']);

    const body = chain.post.mock.calls[0][0];
    expect(body.saveToSentItems).toBe(true);
    expect(body.message.attachments).toEqual([
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'report.pdf',
        contentType: 'application/pdf',
        contentBytes: small.contentBytes,
      },
    ]);

    expect(transport).not.toHaveBeenCalled();
  });

  it('streams a 3 MB attachment through an upload session, then sends the draft', async () => {
    const { service } = createService();
    const chain = mockSdk();

    const big = attachment(MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES);

    chain.post
      .mockResolvedValueOnce({ id: 'draft-1' })
      .mockResolvedValueOnce({ uploadUrl: 'https://outlook.office.com/upload/session-1' })
      .mockResolvedValueOnce(undefined);

    // Intermediate fragments: 202 + nextExpectedRanges. Final fragment: 201.
    const transport = jest.fn(async (request: IMailHttpRequest) => {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers?.['Content-Range'] || '');
      const end = Number(match?.[2]);
      const total = Number(match?.[3]);

      return end + 1 >= total
        ? { status: 201, headers: {}, body: { id: 'att-1' } }
        : { status: 202, headers: {}, body: { nextExpectedRanges: [`${end + 1}-`] } };
    });
    setMailHttpClient(transport);

    await expect(service.sendMessage(USER_ID, baseMessage({ attachments: [big] })))
      .resolves.toBe(true);

    // The exact request order Graph requires for a large attachment.
    expect(chain.api.mock.calls.map((call: any[]) => call[0])).toEqual([
      '/me/messages',
      '/me/messages/draft-1/attachments/createUploadSession',
      '/me/messages/draft-1/send',
    ]);

    // The draft carries no inline attachment: it cannot be inlined.
    expect(chain.post.mock.calls[0][0]).not.toHaveProperty('attachments');

    // The session declares the file, its real byte size and its type.
    expect(chain.post.mock.calls[1][0]).toEqual({
      AttachmentItem: {
        attachmentType: 'file',
        name: 'report.pdf',
        size: MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES,
        contentType: 'application/pdf',
      },
    });

    const fragments = Math.ceil(
      MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES / MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE,
    );

    expect(transport).toHaveBeenCalledTimes(fragments);

    const requests = transport.mock.calls.map(([request]) => request as IMailHttpRequest);

    expect(requests[0]).toMatchObject({
      url: 'https://outlook.office.com/upload/session-1',
      method: 'PUT',
      headers: {
        'Content-Range': `bytes 0-${MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE - 1}/${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES}`,
        'Content-Type': 'application/pdf',
      },
    });

    const lastOffset = (fragments - 1) * MAIL_ATTACHMENT_UPLOAD_CHUNK_SIZE;
    expect(requests[fragments - 1].headers?.['Content-Range']).toBe(
      `bytes ${lastOffset}-${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES - 1}`
        + `/${MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES}`,
    );

    // A pre-authenticated upload URL must never see the vaulted bearer token.
    for (const request of requests) {
      const headerNames = Object.keys(request.headers || {}).map((key) => key.toLowerCase());
      expect(headerNames).not.toContain('authorization');
    }
  });

  it('rejects a Graph send failure with the ApiError and makes no fallback request', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.post.mockRejectedValue({
      statusCode: 400,
      code: 'ErrorInvalidRequest',
      message: 'Invalid message',
    });

    const failure = await service.sendMessage(USER_ID, baseMessage()).catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as any).code).toBe('ErrorInvalidRequest');
    expect(chain.api.mock.calls.map((call: any[]) => call[0])).toEqual(['/me/sendMail']);
    expect(chain.post).toHaveBeenCalledTimes(1);
  });

  it('rejects when the upload session cannot be created, without sending the draft', async () => {
    const { service } = createService();
    const chain = mockSdk();

    chain.post
      .mockResolvedValueOnce({ id: 'draft-1' })
      .mockRejectedValueOnce({
        statusCode: 403,
        code: 'ErrorAccessDenied',
        message: 'Access is denied',
      });

    chain.delete.mockResolvedValue(undefined);

    const failure = await service
      .sendMessage(USER_ID, baseMessage({ attachments: [attachment(MAIL_ATTACHMENT_SIMPLE_UPLOAD_MAX_BYTES)] }))
      .catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as any).code).toBe('ErrorAccessDenied');

    const paths = chain.api.mock.calls.map((call: any[]) => call[0]);
    expect(paths).not.toContain('/me/messages/draft-1/send');
    expect(paths).toContain('/me/messages/draft-1');
  });
});
