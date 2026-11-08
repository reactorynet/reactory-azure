import Reactory from '@reactorynet/reactory-core';
import GraphqlDefinitions from './graphql';
import Services from './services';
import Models from './models';
import Workflows from './workflows';
import Forms from './forms';
import Queues from './queues';
import Routes from './routes';
import Middleware from './middleware';
import { AZURE_MACROS, AZURE_TOOLS } from './ai';

/**
 * reactory-azure - the Microsoft Graph integration module.
 *
 * Module identity is `core.ReactoryAzure@1.0.0` (see audit §9.4: the module FQN is
 * deliberately NOT `azure.*`), while every contributed component lives in the
 * `azure` namespace: `azure.AzureMailService@1.0.0`.
 *
 * This file is owned by AZ-01 and must not be edited by a later ticket. It wires
 * every barrel - including the empty ones (forms, queues, middleware) and the
 * stubs - so no later ticket has to touch the root module definition.
 */
const reactoryAzure: Reactory.Server.IReactoryModule & { queues: any[] } = {
  id: 'reactory-azure',
  nameSpace: 'core',
  version: '1.0.0',
  name: 'ReactoryAzure',
  description: 'Reactory Azure Module - Microsoft Graph integration and Azure Blob Storage',
  dependencies: ['core.ReactoryServer@1.0.0'],
  priority: 0,

  graphDefinitions: GraphqlDefinitions,

  services: Services,
  models: Models,
  workflows: Workflows,
  forms: Forms,
  // `queues` is read by the queue registry but is not yet in the published
  // IReactoryModule type; the intersection above keeps the rest type-checked.
  queues: Queues,

  routes: {
    '/azure': Routes,
  },

  middleware: Middleware,

  reactor: {
    providers: [],
    agents: [],
    macros: AZURE_MACROS,
    tools: AZURE_TOOLS,
    mcp: [],
  },

  translations: [],
  clientPlugins: [],
  cli: [],
  grpc: [],
  passportProviders: [],
  pdfs: [],
};

export default reactoryAzure;
