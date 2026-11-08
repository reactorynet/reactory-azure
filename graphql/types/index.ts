import { loadGraphQLTypeDefinitions } from '@reactory/server-core/graph/graphql-loader';
import path from 'path';

/**
 * Loads every `.graphql` file in this directory.
 *
 * AZ-01 owns this barrel and lists all eleven files, including the ten stub
 * schemas, so no later ticket has to edit it. A ticket that adds a NEW file must
 * stop and raise - this list is part of the module's frozen surface.
 */
const typeDefs = loadGraphQLTypeDefinitions(
  [
    'Auth',
    'Mail',
    'Tasks',
    'Calendar',
    'Drive',
    'Documents',
    'Workbook',
    'Contacts',
    'Teams',
    'SharePoint',
    'Sync',
  ],
  path.join(__dirname),
  'reactory-azure',
);

export default typeDefs;
