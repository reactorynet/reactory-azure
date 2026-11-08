import Reactory from '@reactorynet/reactory-core';
import { InsufficientPermissions } from '@reactory/server-core/exceptions';
import { roles } from '@reactory/server-core/authentication/decorators';
import { resolver, query, mutation } from '@reactory/server-core/models/graphql/decorators/resolver';
import type {
  IMailDraftPatch,
  IMailGetOptions,
  IMailListOptions,
  IMailMessageInput,
  IMailReplyInput,
} from '../../types/mail.types';

/**
 * GraphQL surface for mail (AZ-04 reads, AZ-05 writes).
 *
 * Every field is a thin adapter over `azure.AzureMailService@1.0.0`: the resolver
 * resolves the caller and forwards the options. It performs no request shaping,
 * no caching and no error translation - the service owns all of that, and its
 * `ApiError` (with the Graph `code`) is what a client receives.
 *
 * The write fields are thin on purpose: `comment` is forwarded verbatim and no
 * quoting is built here or in the service (Graph's `/reply`, `/replyAll` and
 * `/forward` sub-paths own that). A resolved `Boolean!` therefore means "Graph
 * accepted it" - never "we returned something truthy".
 *
 * ## Mailbox ownership (security)
 *
 * `@roles(['USER'])` only proves the caller is *a* user; it does not bind the
 * request to that user. `AzureMailService` authenticates with
 * `AzureAuthService.getToken(userId)`, i.e. it reads the vaulted Microsoft token
 * of whichever user id it is given - so an unguarded `userId` argument would let
 * any authenticated USER read another user's mailbox (an IDOR).
 *
 * `userId` is therefore self-or-admin: it defaults to the caller, and a value
 * naming anyone else is rejected unless the caller holds ADMIN. This mirrors the
 * house precedent in `KYCResolver.getVerificationHistory`. Every field goes
 * through {@link resolveUserId} so the rule cannot be forgotten on one of them.
 */

/** The authenticated caller's id (`_id` is the vault key; `id` is its virtual). */
function callerId(context: Reactory.Server.IReactoryContext): string {
  return String(context?.user?._id ?? (context?.user as any)?.id ?? '');
}

/**
 * Resolve the mailbox to read: the caller by default, another user only for an
 * ADMIN.
 *
 * @throws InsufficientPermissions when `params.userId` names a different user and
 * the caller is not an ADMIN.
 */
function resolveUserId(
  params: { userId?: string } | undefined,
  context: Reactory.Server.IReactoryContext,
): string {
  const caller = callerId(context);
  const requested = params?.userId;

  if (requested === undefined || requested === null || String(requested).length === 0) {
    return caller;
  }

  const target = String(requested);
  if (target === caller) return caller;

  if (typeof context?.hasRole !== 'function' || context.hasRole('ADMIN') !== true) {
    throw new InsufficientPermissions(
      `User [${caller || 'anonymous'}] may not access the mailbox of [${target}]`,
      { allowedRoles: ['ADMIN'], contextKey: 'args.context', requestedUserId: target },
    );
  }

  return target;
}

/** Resolve the mail service, failing loudly when the module is not registered. */
function mailService(context: Reactory.Server.IReactoryContext): any {
  const service = context.getService('azure.AzureMailService@1.0.0');
  if (!service) throw new Error('Azure Mail Service not available');
  return service;
}

@resolver
class MailResolver {
  resolver: any;

  /** `GET /me/messages` - one page, or every page when `options.all` is set. */
  @roles(['USER'], 'args.context')
  @query('azureMailMessages')
  async listMessages(
    _obj: any,
    params: { userId?: string; options?: IMailListOptions },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).listMessages(resolveUserId(params, context), params?.options || {});
  }

  /** `GET /me/messages/{id}` - optionally `$expand=attachments`. */
  @roles(['USER'], 'args.context')
  @query('azureMailMessage')
  async getMessage(
    _obj: any,
    params: { userId?: string; id: string; options?: IMailGetOptions },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).getMessage(
      resolveUserId(params, context),
      params?.id,
      params?.options || {},
    );
  }

  /** `GET /me/mailFolders` - cached for ten minutes in Redis. */
  @roles(['USER'], 'args.context')
  @query('azureMailFolders')
  async listFolders(
    _obj: any,
    params: { userId?: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).listFolders(resolveUserId(params, context));
  }

  /** `GET /me/outlook/masterCategories`. */
  @roles(['USER'], 'args.context')
  @query('azureMailCategories')
  async listCategories(
    _obj: any,
    params: { userId?: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).listCategories(resolveUserId(params, context));
  }

  /**
   * `GET /me/messages?$filter=conversationId eq '...'`.
   *
   * Graph has no thread resource, so a conversation read is a filtered listing.
   * There is deliberately no `azureMailThread` field.
   */
  @roles(['USER'], 'args.context')
  @query('azureMailConversation')
  async listByConversation(
    _obj: any,
    params: { userId?: string; conversationId: string; options?: IMailListOptions },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).listByConversation(
      resolveUserId(params, context),
      params?.conversationId,
      params?.options || {},
    );
  }

  /** `PATCH /me/messages/{id}` with `{ categories }`; returns the updated message. */
  @roles(['USER'], 'args.context')
  @mutation('azureSetMailCategories')
  async setCategories(
    _obj: any,
    params: { userId?: string; messageId: string; categories: string[] },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).setCategories(
      resolveUserId(params, context),
      params?.messageId,
      params?.categories || [],
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Attachment reads (AZ-05)                                                */
  /* ---------------------------------------------------------------------- */

  /** `GET /me/messages/{id}/attachments` - metadata only. */
  @roles(['USER'], 'args.context')
  @query('azureMailAttachments')
  async listAttachments(
    _obj: any,
    params: { userId?: string; messageId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).listAttachments(
      resolveUserId(params, context),
      params?.messageId,
    );
  }

  /** `GET /me/messages/{id}/attachments/{attachmentId}` - metadata + contentBytes. */
  @roles(['USER'], 'args.context')
  @query('azureMailAttachment')
  async getAttachment(
    _obj: any,
    params: { userId?: string; messageId: string; attachmentId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).getAttachment(
      resolveUserId(params, context),
      params?.messageId,
      params?.attachmentId,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Writes (AZ-05)                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * `POST /me/sendMail`.
   *
   * `saveToSentItems` is forwarded as supplied; omitting it keeps Graph's own
   * default (`true`). A Graph failure rejects with the service's `ApiError`.
   */
  @roles(['USER'], 'args.context')
  @mutation('azureSendMail')
  async sendMail(
    _obj: any,
    params: { userId?: string; message: IMailMessageInput; saveToSentItems?: boolean },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).sendMessage(
      resolveUserId(params, context),
      params?.message,
      { saveToSentItems: params?.saveToSentItems },
    );
  }

  /** `POST /me/messages/{id}/reply`. */
  @roles(['USER'], 'args.context')
  @mutation('azureReplyMail')
  async replyMail(
    _obj: any,
    params: { userId?: string; messageId: string; input?: IMailReplyInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).replyToMessage(
      resolveUserId(params, context),
      params?.messageId,
      params?.input || {},
    );
  }

  /** `POST /me/messages/{id}/replyAll`. */
  @roles(['USER'], 'args.context')
  @mutation('azureReplyAllMail')
  async replyAllMail(
    _obj: any,
    params: { userId?: string; messageId: string; input?: IMailReplyInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).replyAll(
      resolveUserId(params, context),
      params?.messageId,
      params?.input || {},
    );
  }

  /** `POST /me/messages/{id}/forward`. */
  @roles(['USER'], 'args.context')
  @mutation('azureForwardMail')
  async forwardMail(
    _obj: any,
    params: { userId?: string; messageId: string; input?: IMailReplyInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).forwardMessage(
      resolveUserId(params, context),
      params?.messageId,
      params?.input || {},
    );
  }

  /** `POST /me/messages` - create a draft. */
  @roles(['USER'], 'args.context')
  @mutation('azureCreateMailDraft')
  async createMailDraft(
    _obj: any,
    params: { userId?: string; message: IMailMessageInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).createDraft(
      resolveUserId(params, context),
      params?.message,
    );
  }

  /** `PATCH /me/messages/{id}` - update a draft. */
  @roles(['USER'], 'args.context')
  @mutation('azureUpdateMailDraft')
  async updateMailDraft(
    _obj: any,
    params: { userId?: string; messageId: string; patch: IMailDraftPatch },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).updateDraft(
      resolveUserId(params, context),
      params?.messageId,
      params?.patch,
    );
  }

  /** `POST /me/messages/{id}/send` - send an existing draft. */
  @roles(['USER'], 'args.context')
  @mutation('azureSendMailDraft')
  async sendMailDraft(
    _obj: any,
    params: { userId?: string; messageId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).sendDraft(
      resolveUserId(params, context),
      params?.messageId,
    );
  }

  /** `DELETE /me/messages/{id}` - delete a draft. */
  @roles(['USER'], 'args.context')
  @mutation('azureDeleteMailDraft')
  async deleteMailDraft(
    _obj: any,
    params: { userId?: string; messageId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    return mailService(context).deleteDraft(
      resolveUserId(params, context),
      params?.messageId,
    );
  }
}

export default MailResolver;
