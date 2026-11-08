import resolvers from './resolvers';
import types from './types';

/**
 * The module's GraphQL contribution, wired into `graphDefinitions` by index.ts -
 * the same shape reactory-google uses.
 */
const AzureGraphqlDefinitions = {
  Types: types,
  Resolvers: resolvers,
};

export default AzureGraphqlDefinitions;
