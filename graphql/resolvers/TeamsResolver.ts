import Reactory from '@reactorynet/reactory-core';
import { roles } from '@reactory/server-core/authentication/decorators';
import { resolver, query, mutation } from '@reactory/server-core/models/graphql/decorators/resolver';
import type { IAzureTeamsMessageInput, IAzureTeamsQueryOptions } from '../../types/teams.types';

/**
 * GraphQL surface for Microsoft Teams (AZ-14).
 *
 * A thin adapter over `azure.AzureTeamsService@1.0.0`: every field resolves the
 * service from the context and passes the calling user's id, so the service - not the
 * resolver - owns the Graph paths, id encoding, message validation and error
 * translation. Nothing here re-encodes an id: `AzureTeamsService` percent-encodes
 * every id in full, and a client passes ids exactly as Graph returned them.
 *
 * Two properties are carried through unchanged on purpose:
 *
 *   - `azurePresence` is a live read. The service never caches presence, so a client
 *     polling this field sees the real state rather than a stale snapshot;
 *   - a Graph refusal (403 on a channel the caller cannot read) is thrown, not
 *     converted. The client receives Graph's code (`Forbidden` / `accessDenied`)
 *     instead of an empty message list.
 *
 * Each field normalises its arguments to an object once (`const p = params || {}`)
 * rather than guarding every member: a field with no required argument can be called
 * with `undefined`, and one guard is easier to keep correct than a dozen optional
 * chains.
 */
@resolver
class TeamsResolver {
  resolver: any;

  private teamsService(context: Reactory.Server.IReactoryContext): any {
    const service = context.getService('azure.AzureTeamsService@1.0.0') as any;
    if (!service) throw new Error('Azure Teams Service not available');

    return service;
  }

  private userId(context: Reactory.Server.IReactoryContext): string {
    return String(context.user._id);
  }

  /** Collect the paging/projection arguments a field declares. */
  private queryOptions(params: {
    top?: number;
    skip?: number;
    filter?: string;
    select?: string[];
    expand?: string[];
  }): IAzureTeamsQueryOptions {
    return {
      top: params.top,
      skip: params.skip,
      filter: params.filter,
      select: params.select,
      expand: params.expand,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Queries                                                                  */
  /* ------------------------------------------------------------------------ */

  /** The signed-in user's chats: `/me/chats`. */
  @roles(['USER'], 'args.context')
  @query('azureChats')
  async listChats(
    _obj: any,
    params: { top?: number; skip?: number; filter?: string; select?: string[]; expand?: string[] },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.teamsService(context).listChats(this.userId(context), this.queryOptions(p));
  }

  /** Messages in one chat: `/chats/{chatId}/messages`. */
  @roles(['USER'], 'args.context')
  @query('azureChatMessages')
  async listChatMessages(
    _obj: any,
    params: { chatId: string; top?: number; skip?: number; filter?: string; select?: string[] },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.teamsService(context).listChatMessages(
      this.userId(context),
      p.chatId,
      this.queryOptions(p),
    );
  }

  /** Teams the signed-in user has joined: `/me/joinedTeams`. */
  @roles(['USER'], 'args.context')
  @query('azureTeams')
  async listJoinedTeams(
    _obj: any,
    params: { top?: number; skip?: number; filter?: string; select?: string[] },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.teamsService(context).listJoinedTeams(this.userId(context), this.queryOptions(p));
  }

  /** Channels in one team: `/teams/{teamId}/channels`. */
  @roles(['USER'], 'args.context')
  @query('azureChannels')
  async listChannels(
    _obj: any,
    params: { teamId: string; top?: number; skip?: number; filter?: string; select?: string[] },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.teamsService(context).listChannels(
      this.userId(context),
      p.teamId,
      this.queryOptions(p),
    );
  }

  /**
   * Messages in one channel.
   *
   * A 403 on a channel the caller cannot read propagates as the service's `ApiError`
   * with Graph's code - this method deliberately does not catch it.
   */
  @roles(['USER'], 'args.context')
  @query('azureChannelMessages')
  async listChannelMessages(
    _obj: any,
    params: { teamId: string; channelId: string; top?: number; skip?: number; filter?: string; select?: string[] },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.teamsService(context).listChannelMessages(
      this.userId(context),
      p.teamId,
      p.channelId,
      this.queryOptions(p),
    );
  }

  /** Presence for one or more users; never cached by the service. */
  @roles(['USER'], 'args.context')
  @query('azurePresence')
  async getPresence(
    _obj: any,
    params: { userIds: string[] },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.teamsService(context).getPresence(this.userId(context), p.userIds);
  }

  /* ------------------------------------------------------------------------ */
  /* Mutations                                                                */
  /* ------------------------------------------------------------------------ */

  /** Send a chat message: `POST /chats/{chatId}/messages`. */
  @roles(['USER'], 'args.context')
  @mutation('azureSendChatMessage')
  async sendChatMessage(
    _obj: any,
    params: { chatId: string; input: IAzureTeamsMessageInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.teamsService(context).sendChatMessage(
      this.userId(context),
      p.chatId,
      p.input,
    );
  }

  /** Send a channel message: `POST /teams/{teamId}/channels/{channelId}/messages`. */
  @roles(['USER'], 'args.context')
  @mutation('azureSendChannelMessage')
  async sendChannelMessage(
    _obj: any,
    params: { teamId: string; channelId: string; input: IAzureTeamsMessageInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    const p = (params || {}) as typeof params;

    return this.teamsService(context).sendChannelMessage(
      this.userId(context),
      p.teamId,
      p.channelId,
      p.input,
    );
  }
}

export default TeamsResolver;
