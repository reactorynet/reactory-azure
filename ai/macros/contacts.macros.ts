import type {
  ChatState,
  MacroComponentDefinition,
} from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

import {
  AZURE_NS,
  AZURE_VERSION,
  ROLE_SET,
  buildParameters,
  compactObject,
  fail,
  macroFailure,
  notConnected,
  ok,
  optionalBoolean,
  optionalNumber,
  optionalString,
  userIdFrom,
} from './macro-support';

/**
 * Contacts macro (AZ-13): `azure_list_contacts`.
 *
 * Resolves `azure.AzureContactsService@1.0.0` from the chat context and reads the
 * user's personal contacts (`/me/contacts`) - not directory users, which need
 * `User.ReadBasic.All` and a different service method.
 *
 * Paging is the service's contract, so the macro exposes it as-is: `top`/`skip`
 * for a page, `all` to drain every page, and the opaque `nextLink` comes back in
 * the response for a caller that wants to continue. `filter`/`orderBy` are raw
 * OData expressions: inventing a friendlier dialect in the macro would make the
 * tool answer differently from the GraphQL path.
 */

const TOOL_NAME = 'azure_list_contacts';

/** One contact, reduced to what an assistant needs to address or identify a person. */
const summariseContact = (contact: any) => ({
  id: contact?.id,
  displayName: contact?.displayName,
  givenName: contact?.givenName,
  surname: contact?.surname,
  emails: Array.isArray(contact?.emailAddresses)
    ? contact.emailAddresses
      .map((entry: any) => entry?.address)
      .filter((address: any) => typeof address === 'string' && address.length > 0)
    : [],
  businessPhones: Array.isArray(contact?.businessPhones) ? [...contact.businessPhones] : [],
  mobilePhone: contact?.mobilePhone,
  companyName: contact?.companyName,
  jobTitle: contact?.jobTitle,
  department: contact?.department,
  officeLocation: contact?.officeLocation,
});

const ListContacts = async (params: any, state: ChatState) => {
  const { context } = state;

  const userId = userIdFrom(context);
  if (!userId) {
    return fail(
      TOOL_NAME,
      params,
      'No authenticated user in context',
      'Contacts are read from the signed-in user\'s mailbox; a user is required.',
    );
  }

  const contactsService = context?.getService('azure.AzureContactsService@1.0.0') as any;
  if (!contactsService) {
    return notConnected(TOOL_NAME, params, 'AzureContactsService is not registered');
  }

  const all = optionalBoolean(params?.all) === true;
  const top = all
    ? 0
    : Math.min(Math.max(Math.trunc(optionalNumber(params?.top) ?? 25), 1), 100);

  const options = compactObject({
    top: all ? undefined : top,
    skip: all ? undefined : optionalNumber(params?.skip),
    all: all ? true : undefined,
    filter: optionalString(params?.filter),
    orderBy: optionalString(params?.orderBy),
  });

  try {
    const page = await contactsService.listContacts(userId, options);
    const items = (Array.isArray(page?.items) ? page.items : []).map(summariseContact);

    return ok(
      TOOL_NAME,
      params,
      {
        count: items.length,
        items,
        total: page?.count,
        nextLink: page?.nextLink,
      },
      `Found ${items.length} contact(s)`,
    );
  } catch (error) {
    return macroFailure(TOOL_NAME, params, error);
  }
};

const ListContactsMacro: MacroComponentDefinition<typeof ListContacts> = {
  nameSpace: AZURE_NS,
  name: TOOL_NAME,
  version: AZURE_VERSION,
  component: ListContacts,
  description: 'List the connected user\'s Outlook contacts',
  alias: TOOL_NAME,
  runat: 'server',
  icon: 'contacts',
  roles: ROLE_SET,
  tags: ['azure', 'contacts', 'outlook', 'people', 'read'],
  tools: [
    {
      type: 'function',
      roles: ROLE_SET,
      runat: 'server',
      safeForAutoExecution: true,
      function: {
        name: TOOL_NAME,
        icon: 'contacts',
        description:
          'List the connected user\'s personal Outlook contacts with their email addresses, '
          + 'phone numbers and organisation details. Returns one page by default; set "all" '
          + 'to read every page.',
        parameters: buildParameters([
          {
            name: 'top',
            type: 'integer',
            required: false,
            default: 25,
            description:
              'Page size, 1-100. Defaults to 25. Ignored when "all" is true.',
          },
          {
            name: 'skip',
            type: 'integer',
            required: false,
            description:
              'Offset to skip before returning contacts. Ignored when "all" is true or when '
              + 'continuing from a nextLink.',
          },
          {
            name: 'all',
            type: 'boolean',
            required: false,
            default: false,
            description:
              'When true, follow every page and return the complete contact list. Defaults '
              + 'to false.',
          },
          {
            name: 'filter',
            type: 'string',
            required: false,
            description:
              'Optional raw OData $filter expression, for example '
              + '"startswith(displayName,\'Ann\')". Passed to Graph unchanged.',
          },
          {
            name: 'orderBy',
            type: 'string',
            required: false,
            description:
              'Optional raw OData $orderby expression, for example "displayName" or '
              + '"surname asc". Passed to Graph unchanged.',
          },
        ]),
      },
    },
  ],
};

export const CONTACTS_MACROS: MacroComponentDefinition<unknown>[] = [ListContactsMacro];

export { ListContactsMacro };
export default CONTACTS_MACROS;
