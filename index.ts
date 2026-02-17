
'use strict';
import services from './services';
import workflows from './workflows';
import Reactory from '@reactorynet/reactory-core';


const reactoryAzure: Reactory.Server.IReactoryModule = {
  id: 'reactory-azure',
  nameSpace: 'core',
  version: '1.0.0',
  name: 'ReactoryAzure',
  dependencies: ['core.ReactoryServer@1.0.0'],
  priority: 0,
  graphDefinitions: {
    Resolvers: {},
    Types: [],
  },
  models: [],
  workflows: [...workflows],
  forms: [],
  services: [...services],
  translations: [],
  clientPlugins: [],
  cli: [],
  description: 'Reactory Azure Module',
  grpc: null,
  passportProviders: [],
  pdfs: [],
};

export default reactoryAzure;