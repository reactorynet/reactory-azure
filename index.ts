
'use strict';
import services from './services';
import workflows from './workflows';
import { Reactory } from '@reactory/server-core/types/reactory';


const reactoryAzure: Reactory.IReactoryModule = {
  nameSpace: 'core',
  version: '1.0.0',
  name: 'ReactoryAzure',
  dependencies: ['core.ReactoryServer@1.0.0'],
  priority: 0,
  graphDefinitions: {
    Resolvers: {},
    Types: [],
  },
  workflows: [...workflows],
  forms: [],
  services: [...services],
};

export default reactoryAzure;