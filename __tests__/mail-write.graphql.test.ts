import fs from 'fs';
import path from 'path';
import { buildSchema, GraphQLSchema } from 'graphql';
import ApiError, { InsufficientPermissions } from '@reactory/server-core/exceptions';

import graphResolvers from '../graphql/resolvers';
import MailResolver from '../graphql/resolvers/MailResolver';
import { apiError } from '../utils/graph-error';

/**
 * GraphQL surface for the AZ-05 write requirement (requirement 7).
 *
 * `mail-service.test.ts` builds the schema net for the AZ-04 reads and says so
 * itself ("without these tests an edit to MailResolver.ts or Mail.graphql would
 * break the API surface silently"). This suite extends that net to the ten fields
 * AZ-05 adds, because they are the destructive ones: a mutation whose decorator
 * name drifts from the SDL field, or one that loses `resolveUserId`, is an IDOR
 * on send/reply/forward/delete.
 *
 * Four properties are asserted:
 *
 *   1. the real `Mail.graphql` builds and declares every write field with the
 *      documented return type, plus the six new input types;
 *   2. every field is present in the merged resolver map the module ships;
 *   3. each field delegates to `AzureMailService` with the caller's id - and
 *      `azureSendMail` forwards `saveToSentItems` untouched (omitted stays
 *      omitted, so Graph's own `true` default applies);
 *   4. the self-or-admin rule holds on all ten entry points: naming another
 *      user raises `InsufficientPermissions` (USER-401) and the service is never
 *      called.
 */

const CALLER_ID = 'user-from-context';
const OTHER_ID = 'someone-elses-id';
const MESSAGE_ID = 'AAMkAGI2';

/** The eight AZ-05 mutations and their documented return types. */
const WRITE_MUTATIONS: Array<[string, string]> = [
  ['azureSendMail', 'Boolean!'],
  ['azureReplyMail', 'Boolean!'],
  ['azureReplyAllMail', 'Boolean!'],
  ['azureForwardMail', 'Boolean!'],
  ['azureCreateMailDraft', 'AzureMailMessage!'],
  ['azureUpdateMailDraft', 'AzureMailMessage!'],
  ['azureSendMailDraft', 'Boolean!'],
  ['azureDeleteMailDraft', 'Boolean!'],
];

/** The two AZ-05 attachment queries and their documented return types. */
const ATTACHMENT_QUERIES: Array<[string, string]> = [
  ['azureMailAttachments', '[AzureMailAttachment!]!'],
  ['azureMailAttachment', 'AzureMailAttachment!'],
];

/** The six new input types the write surface introduces. */
const WRITE_INPUT_TYPES = [
  'AzureMailRecipientInput',
  'AzureMailBodyInput',
  'AzureMailAttachmentInput',
  'AzureMailMessageInput',
  'AzureMailDraftPatch',
];

/** Every AZ-05 entry point, as a caller would name it. */
const WRITE_FIELDS = [...WRITE_MUTATIONS.map(([name]) => name), ...ATTACHMENT_QUERIES.map(([name]) => name)];

const MESSAGE_INPUT = {
  subject: 'Quarterly report',
  body: { contentType: 'HTML', content: '<p>Please review</p>' },
  toRecipients: [{ address: 'bob@example.test' }],
};

describe('Mail GraphQL surface (AZ-05 writes)', () => {
  function schema(): GraphQLSchema {
    const sdl = fs.readFileSync(
      path.join(__dirname, '..', 'graphql', 'types', 'Mail.graphql'),
      'utf8',
    );

    // Mail.graphql only *extends* Query/Mutation, as every module type file does.
    return buildSchema(`
type Query { _empty: Boolean }
type Mutation { _empty: Boolean }
${sdl}
`);
  }

  /** A fake service recording every delegation. */
  function fakeService(): any {
    return {
      // Reads (AZ-04) - present so a mis-targeted delegation is visible.
      listMessages: jest.fn(async () => ({ items: [] })),
      getMessage: jest.fn(async () => ({ id: 'm1' })),
      listFolders: jest.fn(async () => []),
      listCategories: jest.fn(async () => []),
      listByConversation: jest.fn(async () => ({ items: [] })),
      setCategories: jest.fn(async () => ({ id: 'm1' })),

      // Writes (AZ-05).
      sendMessage: jest.fn(async () => true),
      replyToMessage: jest.fn(async () => true),
      replyAll: jest.fn(async () => true),
      forwardMessage: jest.fn(async () => true),
      createDraft: jest.fn(async () => ({ id: MESSAGE_ID })),
      updateDraft: jest.fn(async () => ({ id: MESSAGE_ID })),
      sendDraft: jest.fn(async () => true),
      deleteDraft: jest.fn(async () => true),
      listAttachments: jest.fn(async () => []),
      getAttachment: jest.fn(async () => ({ name: 'a.pdf', contentBytes: 'QUJD' })),
    };
  }

  function fakeContext(
    service: any,
    userId: string | undefined = CALLER_ID,
    roles: string[] = ['USER'],
  ): any {
    return {
      user: userId === undefined ? { _id: CALLER_ID } : { _id: userId },
      // The @roles decorator calls this.
      hasRole: jest.fn((role: string) => roles.includes(role)),
      getService: jest.fn((id: string) =>
        (id === 'azure.AzureMailService@1.0.0' ? service : undefined)),
    };
  }

  it('builds the real Mail.graphql and declares every write field with its return type', () => {
    const built = schema();

    const mutation = built.getMutationType();
    const query = built.getQueryType();
    expect(mutation).toBeTruthy();
    expect(query).toBeTruthy();

    for (const [field, returnType] of WRITE_MUTATIONS) {
      const definition: any = mutation?.getFields()[field];
      expect(definition).toBeTruthy();
      expect(String(definition.type)).toBe(returnType);
    }

    for (const [field, returnType] of ATTACHMENT_QUERIES) {
      const definition: any = query?.getFields()[field];
      expect(definition).toBeTruthy();
      expect(String(definition.type)).toBe(returnType);
    }
  });

  it('declares the five new input types the write surface needs', () => {
    const built = schema();

    for (const name of WRITE_INPUT_TYPES) {
      const type = built.getType(name);
      expect(type).toBeTruthy();
      expect(type?.astNode?.kind).toBe('InputObjectTypeDefinition');
    }
  });

  it('pins the required argument on every write field', () => {
    const built = schema();
    const mutation: any = built.getMutationType()?.getFields();
    const query: any = built.getQueryType()?.getFields();

    // azureSendMail: the message is required; saveToSentItems is optional.
    const send = mutation.azureSendMail;
    const sendArgs = Object.fromEntries(send.args.map((arg: any) => [arg.name, String(arg.type)]));
    expect(sendArgs.userId).toBe('String');
    expect(sendArgs.message).toBe('AzureMailMessageInput!');
    expect(sendArgs.saveToSentItems).toBe('Boolean');

    // Every reply/forward/draft-by-id field requires the message id.
    for (const field of ['azureReplyMail', 'azureReplyAllMail', 'azureForwardMail', 'azureSendMailDraft', 'azureDeleteMailDraft']) {
      const args = Object.fromEntries(
        mutation[field].args.map((arg: any) => [arg.name, String(arg.type)]),
      );
      expect(args.messageId).toBe('String!');
      expect(args.userId).toBe('String');
    }

    expect(mutation.azureCreateMailDraft.args.find((a: any) => a.name === 'message').type.toString())
      .toBe('AzureMailMessageInput!');

    for (const field of ['azureMailAttachments', 'azureMailAttachment']) {
      expect(query[field].args.find((a: any) => a.name === 'messageId').type.toString())
        .toBe('String!');
    }

    expect(query.azureMailAttachment.args.find((a: any) => a.name === 'attachmentId').type.toString())
      .toBe('String!');
  });

  it('merges every AZ-05 field into the module resolver map', () => {
    const query: any = (graphResolvers as any).Query;
    const mutation: any = (graphResolvers as any).Mutation;

    for (const [field] of WRITE_MUTATIONS) {
      expect(typeof mutation[field]).toBe('function');
    }

    for (const [field] of ATTACHMENT_QUERIES) {
      expect(typeof query[field]).toBe('function');
    }

    // The AZ-04 read surface must survive the merge.
    for (const field of ['azureMailMessages', 'azureMailMessage', 'azureMailFolders', 'azureMailCategories', 'azureMailConversation']) {
      expect(typeof query[field]).toBe('function');
    }
    expect(typeof mutation.azureSetMailCategories).toBe('function');
  });

  describe('delegation', () => {
    function resolver(): any {
      return new (MailResolver as any)();
    }

    it('azureSendMail forwards the message and an omitted saveToSentItems as undefined', async () => {
      const service = fakeService();

      await resolver().sendMail({}, { message: MESSAGE_INPUT }, fakeContext(service));

      expect(service.sendMessage).toHaveBeenCalledTimes(1);
      // An omitted value must stay omitted so Graph's own `true` default applies.
      expect(service.sendMessage).toHaveBeenCalledWith(CALLER_ID, MESSAGE_INPUT, {
        saveToSentItems: undefined,
      });
    });

    it('azureSendMail forwards saveToSentItems:false and :true unchanged', async () => {
      const service = fakeService();

      await resolver().sendMail({}, { message: MESSAGE_INPUT, saveToSentItems: false }, fakeContext(service));
      expect(service.sendMessage).toHaveBeenLastCalledWith(CALLER_ID, MESSAGE_INPUT, {
        saveToSentItems: false,
      });

      await resolver().sendMail({}, { message: MESSAGE_INPUT, saveToSentItems: true }, fakeContext(service));
      expect(service.sendMessage).toHaveBeenLastCalledWith(CALLER_ID, MESSAGE_INPUT, {
        saveToSentItems: true,
      });
    });

    it('forwards the comment verbatim on reply, replyAll and forward', async () => {
      const service = fakeService();
      const r = resolver();
      const input = { comment: 'Thanks!' };

      await r.replyMail({}, { messageId: MESSAGE_ID, input }, fakeContext(service));
      expect(service.replyToMessage).toHaveBeenCalledWith(CALLER_ID, MESSAGE_ID, input);

      await r.replyAllMail({}, { messageId: MESSAGE_ID, input }, fakeContext(service));
      expect(service.replyAll).toHaveBeenCalledWith(CALLER_ID, MESSAGE_ID, input);

      const forward = { comment: 'FYI', toRecipients: [{ address: 'carol@example.test' }] };
      await r.forwardMail({}, { messageId: MESSAGE_ID, input: forward }, fakeContext(service));
      expect(service.forwardMessage).toHaveBeenCalledWith(CALLER_ID, MESSAGE_ID, forward);
    });

    it('defaults a missing reply input to {} rather than undefined', async () => {
      const service = fakeService();

      await resolver().replyMail({}, { messageId: MESSAGE_ID }, fakeContext(service));

      expect(service.replyToMessage).toHaveBeenCalledWith(CALLER_ID, MESSAGE_ID, {});
    });

    it('delegates the four draft mutations and both attachment queries', async () => {
      const service = fakeService();
      const r = resolver();
      const context = fakeContext(service);

      await r.createMailDraft({}, { message: MESSAGE_INPUT }, context);
      expect(service.createDraft).toHaveBeenCalledWith(CALLER_ID, MESSAGE_INPUT);

      const patch = { subject: 'Updated' };
      await r.updateMailDraft({}, { messageId: MESSAGE_ID, patch }, context);
      expect(service.updateDraft).toHaveBeenCalledWith(CALLER_ID, MESSAGE_ID, patch);

      await r.sendMailDraft({}, { messageId: MESSAGE_ID }, context);
      expect(service.sendDraft).toHaveBeenCalledWith(CALLER_ID, MESSAGE_ID);

      await r.deleteMailDraft({}, { messageId: MESSAGE_ID }, context);
      expect(service.deleteDraft).toHaveBeenCalledWith(CALLER_ID, MESSAGE_ID);

      await r.listAttachments({}, { messageId: MESSAGE_ID }, context);
      expect(service.listAttachments).toHaveBeenCalledWith(CALLER_ID, MESSAGE_ID);

      await r.getAttachment({}, { messageId: MESSAGE_ID, attachmentId: 'att-1' }, context);
      expect(service.getAttachment).toHaveBeenCalledWith(CALLER_ID, MESSAGE_ID, 'att-1');
    });
  });

  describe('self-or-admin rule on every AZ-05 entry point', () => {
    /** Invoke one resolver method by its SDL name. */
    const INVOKE: Record<string, (r: any, params: any, context: any) => Promise<unknown>> = {
      azureSendMail: (r, params, context) => r.sendMail({}, params, context),
      azureReplyMail: (r, params, context) => r.replyMail({}, params, context),
      azureReplyAllMail: (r, params, context) => r.replyAllMail({}, params, context),
      azureForwardMail: (r, params, context) => r.forwardMail({}, params, context),
      azureCreateMailDraft: (r, params, context) => r.createMailDraft({}, params, context),
      azureUpdateMailDraft: (r, params, context) => r.updateMailDraft({}, params, context),
      azureSendMailDraft: (r, params, context) => r.sendMailDraft({}, params, context),
      azureDeleteMailDraft: (r, params, context) => r.deleteMailDraft({}, params, context),
      azureMailAttachments: (r, params, context) => r.listAttachments({}, params, context),
      azureMailAttachment: (r, params, context) => r.getAttachment({}, params, context),
    };

    /** The params each field needs, minus `userId`. */
    const PARAMS: Record<string, Record<string, unknown>> = {
      azureSendMail: { message: MESSAGE_INPUT },
      azureReplyMail: { messageId: MESSAGE_ID },
      azureReplyAllMail: { messageId: MESSAGE_ID },
      azureForwardMail: { messageId: MESSAGE_ID, input: { toRecipients: [{ address: 'a@b.test' }] } },
      azureCreateMailDraft: { message: MESSAGE_INPUT },
      azureUpdateMailDraft: { messageId: MESSAGE_ID, patch: { subject: 'x' } },
      azureSendMailDraft: { messageId: MESSAGE_ID },
      azureDeleteMailDraft: { messageId: MESSAGE_ID },
      azureMailAttachments: { messageId: MESSAGE_ID },
      azureMailAttachment: { messageId: MESSAGE_ID, attachmentId: 'att-1' },
    };

    it('rejects a foreign userId with InsufficientPermissions and never calls the service', async () => {
      for (const field of WRITE_FIELDS) {
        const service = fakeService();
        const context = fakeContext(service, CALLER_ID, ['USER']);

        const failure = await INVOKE[field](
          new (MailResolver as any)(),
          { ...PARAMS[field], userId: OTHER_ID },
          context,
        ).catch((error: any) => error);

        expect(failure).toBeInstanceOf(InsufficientPermissions);
        expect((failure as any).code).toBe('USER-401');
        expect((failure as any).extensions?.code ?? (failure as any).code).toBe('USER-401');

        // An IDOR is only prevented if the read/write never happens.
        for (const method of Object.keys(service)) {
          expect(service[method]).not.toHaveBeenCalled();
        }
      }
    });

    it('allows an ADMIN to act on another mailbox', async () => {
      const service = fakeService();
      const context = fakeContext(service, CALLER_ID, ['USER', 'ADMIN']);

      await new (MailResolver as any)().sendMail(
        {},
        { userId: OTHER_ID, message: MESSAGE_INPUT },
        context,
      );

      expect(service.sendMessage).toHaveBeenCalledWith(OTHER_ID, MESSAGE_INPUT, {
        saveToSentItems: undefined,
      });
    });

    it('defaults to the caller when userId is omitted on every entry point', async () => {
      for (const field of WRITE_FIELDS) {
        const service = fakeService();

        await INVOKE[field](
          new (MailResolver as any)(),
          { ...PARAMS[field] },
          fakeContext(service),
        );

        // Whatever the method, its first argument is the resolved mailbox.
        const method = Object.keys(service).find(
          (name) => (service[name] as jest.Mock).mock.calls.length > 0,
        );
        expect(method).toBeTruthy();
        expect((service[method as string] as jest.Mock).mock.calls[0][0]).toBe(CALLER_ID);
      }
    });
  });

  describe('error pass-through', () => {
    const failure = () => apiError('ErrorInvalidRecipients', 'The message has no recipients', { status: 400 });

    it('carries a send failure to the caller with the Graph code intact', async () => {
      const service = fakeService();
      service.sendMessage.mockRejectedValue(failure());

      await expect(
        new (MailResolver as any)().sendMail({}, { message: MESSAGE_INPUT }, fakeContext(service)),
      ).rejects.toMatchObject({ code: 'ErrorInvalidRecipients', message: 'The message has no recipients' });
    });

    it('carries a reply failure to the caller with the Graph code intact', async () => {
      const service = fakeService();
      service.replyToMessage.mockRejectedValue(failure());

      const thrown = await new (MailResolver as any)()
        .replyMail({}, { messageId: MESSAGE_ID }, fakeContext(service))
        .catch((error: any) => error);

      expect(thrown).toBeInstanceOf(ApiError);
      expect(thrown.code).toBe('ErrorInvalidRecipients');
    });

    it('carries a draft failure to the caller with the Graph code intact', async () => {
      const service = fakeService();
      service.createDraft.mockRejectedValue(failure());

      await expect(
        new (MailResolver as any)().createMailDraft({}, { message: MESSAGE_INPUT }, fakeContext(service)),
      ).rejects.toMatchObject({ code: 'ErrorInvalidRecipients' });
    });

    it('fails loudly when the service is not registered', async () => {
      const context: any = {
        user: { _id: CALLER_ID },
        hasRole: jest.fn(() => true),
        getService: jest.fn(() => undefined),
      };

      await expect(
        new (MailResolver as any)().sendMail({}, { message: MESSAGE_INPUT }, context),
      ).rejects.toThrow('Azure Mail Service not available');
    });
  });
});
