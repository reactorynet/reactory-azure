import fs from 'fs';
import path from 'path';

/**
 * Contract-shape suite: the promises AZ-01 makes about the module's *surface*.
 *
 * These are the assertions a later ticket cannot quietly break: exactly 16 service
 * definitions, one Graph-client construction path, a shim that fails loudly, and a
 * root module definition that wires every barrel.
 */
jest.mock('@microsoft/microsoft-graph-client', () => {
  const chain: any = {};
  chain.headers = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.version = jest.fn(() => chain);
  chain.search = jest.fn(() => chain);
  chain.orderby = jest.fn(() => chain);
  chain.responseType = jest.fn(() => chain);
  chain.get = jest.fn();
  chain.post = jest.fn();
  chain.delete = jest.fn();

  const client = { api: jest.fn(() => chain) };
  const init = jest.fn(() => client);

  return { Client: { init }, ResponseType: { RAW: 'raw' }, __chain: chain, __client: client };
});

// eslint-disable-next-line import/first
import ApiError from '@reactory/server-core/exceptions';
// eslint-disable-next-line import/first
import services from '../services';
// eslint-disable-next-line import/first
import models, { AzureAuditLog, AzureToken } from '../models';
// eslint-disable-next-line import/first
import forms from '../forms';
// eslint-disable-next-line import/first
import queues from '../queues';
// eslint-disable-next-line import/first
import middleware from '../middleware';
// eslint-disable-next-line import/first
import { AZURE_MACROS, AZURE_TOOLS } from '../ai';
// eslint-disable-next-line import/first
import MSGraph from '../services/graph';
// eslint-disable-next-line import/first
import reactoryAzure from '../index';

const MODULE_ROOT = path.resolve(__dirname, '..');

const EXPECTED_FQNS = [
  'azure.AzureAuditService@1.0.0',
  'azure.AzureAuthService@1.0.0',
  'azure.AzureGraphClientProvider@1.0.0',
  'azure.AzureService@1.0.0',
  'azure.AzureMailService@1.0.0',
  'azure.AzureTodoService@1.0.0',
  'azure.AzureCalendarService@1.0.0',
  'azure.AzureDriveService@1.0.0',
  'azure.AzureDocumentService@1.0.0',
  'azure.AzureWorkbookService@1.0.0',
  'azure.AzureContactsService@1.0.0',
  'azure.AzureSyncService@1.0.0',
  'azure.AzureSubscriptionService@1.0.0',
  'azure.AzureTeamsService@1.0.0',
  'azure.AzureSharePointService@1.0.0',
  'azure.AzureBlobStorageService@1.0.0',
];

/** Every `.ts` file in the module, excluding tests and installed packages. */
function moduleSourceFiles(dir: string = MODULE_ROOT): string[] {
  const skip = new Set(['node_modules', '__tests__', 'dist', 'build', '.git', '.ai-agent']);
  const found: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...moduleSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }

  return found;
}

describe('services barrel', () => {
  it('exports exactly 16 definitions', () => {
    expect(Array.isArray(services)).toBe(true);
    expect(services).toHaveLength(16);
  });

  it('enumerates the expected FQNs, all azure.*@1.0.0', () => {
    const ids = services.map((definition: any) => definition.id);
    expect(ids).toEqual(EXPECTED_FQNS);
    expect(ids.every((id: string) => id.startsWith('azure.'))).toBe(true);
    expect(ids.every((id: string) => id.endsWith('@1.0.0'))).toBe(true);
    expect(new Set(ids).size).toBe(16);
  });

  it('gives every definition the metadata the registry requires', () => {
    for (const definition of services as any[]) {
      expect(definition.nameSpace).toBe('azure');
      expect(definition.version).toBe('1.0.0');
      expect(typeof definition.name).toBe('string');
      expect(typeof definition.service).toBe('function');

      const instance = definition.service({}, { getService: () => undefined, error: () => undefined });
      expect(instance).toBeTruthy();
      expect(instance.name).toBe(definition.name);
      expect(instance.nameSpace).toBe('azure');
    }
  });

  it('AGENT.md documents every exported FQN and nothing else', () => {
    const agentDoc = fs.readFileSync(path.join(MODULE_ROOT, 'AGENT.md'), 'utf8');
    const documented = new Set(agentDoc.match(/azure\.[A-Za-z]+@1\.0\.0/g) || []);

    expect(documented.size).toBe(services.length);
    expect(Array.from(documented).sort()).toEqual([...EXPECTED_FQNS].sort());
  });

  // A real guard, not a grep for a literal that exists nowhere: the Graph SDK may
  // only be constructed in the canonical provider file. `Client.init` currently
  // appears twice there - the userId client and the deprecated token client the
  // shim uses - and nowhere else in the module.
  it('constructs a Graph Client in exactly one file', () => {
    const CONSTRUCTOR = 'Client.init(';
    const CONSTRUCTOR_FILE = path.join('services', 'graph', 'AzureGraphClientProvider.ts');

    const matches: Array<{ file: string; count: number }> = [];
    for (const file of moduleSourceFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      const count = source.split(CONSTRUCTOR).length - 1;
      if (count > 0) matches.push({ file: path.relative(MODULE_ROOT, file), count });
    }

    expect(matches).toEqual([{ file: CONSTRUCTOR_FILE, count: 2 }]);
  });
});

describe('models and empty barrels', () => {
  it('registers exactly the two AZ-01 models', () => {
    expect(models).toHaveLength(2);
    expect((models as any[]).map((definition) => definition.name)).toEqual(['AzureToken', 'AzureAuditLog']);
    expect(AzureToken.modelName).toBe('AzureToken');
    expect(AzureToken.collection.name).toBe('azure_tokens');
    expect(AzureAuditLog.collection.name).toBe('azure_audit_logs');
  });

  it('contributes no forms, queues or middleware yet', () => {
    expect(forms).toEqual([]);
    expect(queues).toEqual([]);
    expect(middleware).toEqual([]);
  });
});

describe('AI barrels', () => {
  it('exposes the macro arrays the barrel assembles', () => {
    expect(Array.isArray(AZURE_MACROS)).toBe(true);
    expect(Array.isArray(AZURE_TOOLS)).toBe(true);
    expect((reactoryAzure as any).reactor.macros).toBe(AZURE_MACROS);
    expect((reactoryAzure as any).reactor.tools).toBe(AZURE_TOOLS);
  });

  it('creates every per-domain macro array', () => {
    const files = fs.readdirSync(path.join(MODULE_ROOT, 'ai', 'macros'))
      .filter((name) => name.endsWith('.macros.ts'));

    expect(files.sort()).toEqual([
      'calendar.macros.ts',
      'contacts.macros.ts',
      'drive.macros.ts',
      'mail.macros.ts',
      'status.macros.ts',
      'tasks.macros.ts',
      'teams.macros.ts',
      'workbook.macros.ts',
    ]);

    for (const file of files) {
      const source = fs.readFileSync(path.join(MODULE_ROOT, 'ai', 'macros', file), 'utf8');
      expect(source).toMatch(/export const [A-Z_]+_MACROS/);
    }
  });
});

describe('legacy shim (services/graph.ts)', () => {
  const sdk: any = jest.requireMock('@microsoft/microsoft-graph-client');

  beforeEach(() => jest.clearAllMocks());

  it('still exports the nine original method names', () => {
    expect(Object.keys(MSGraph).sort()).toEqual([
      'createTask',
      'deleteTask',
      'getEmails',
      'getEvents',
      'getProfileImage',
      'getTask',
      'getTasks',
      'getUserDetails',
      'sendEmail',
    ]);
  });

  it('sendEmail rejects on a Graph failure and never resolves to an object', async () => {
    sdk.__chain.post.mockRejectedValue({
      statusCode: 400,
      code: 'ErrorInvalidRecipients',
      message: 'One or more recipients are invalid',
    });

    let resolved: unknown;
    let caught: any;

    try {
      resolved = await MSGraph.sendEmail('token', 'Subject', 'text' as any, 'Body', [
        { emailAddress: { address: 'nobody@example.test' } },
      ]);
    } catch (error) {
      caught = error;
    }

    // The failure must not resolve at all - the historical bug returned express's
    // `response` object from the catch block, so a failed send looked successful.
    expect(resolved).toBeUndefined();
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe('ErrorInvalidRecipients');
    expect(caught.status).toBe(400);
  });

  it('sendEmail resolves to undefined on success', async () => {
    sdk.__chain.post.mockResolvedValue(undefined);

    await expect(
      MSGraph.sendEmail('token', 'Subject', 'text' as any, 'Body', []),
    ).resolves.toBeUndefined();

    expect(sdk.__chain.post).toHaveBeenCalledWith(
      expect.objectContaining({
        saveToSentItems: true,
        message: expect.objectContaining({ subject: 'Subject' }),
      }),
    );
  });

  it('getEmails rejects instead of returning an empty page', async () => {
    sdk.__chain.get.mockRejectedValue({ statusCode: 401, code: 'InvalidAuthenticationToken' });

    await expect(MSGraph.getEmails('expired-token', {})).rejects.toMatchObject({
      code: 'InvalidAuthenticationToken',
    });
  });

  it('getEmails still returns the raw Graph page shape UserEmails maps', async () => {
    sdk.__chain.get.mockResolvedValue({ value: [{ id: 'm1' }] });

    await expect(MSGraph.getEmails('token', {})).resolves.toEqual({ value: [{ id: 'm1' }] });
  });
});

describe('root module definition', () => {
  it('declares the module identity and every barrel', () => {
    expect(reactoryAzure.id).toBe('reactory-azure');
    expect(reactoryAzure.nameSpace).toBe('core');
    expect(reactoryAzure.version).toBe('1.0.0');
    // The module FQN is composed from its parts, as the registry composes it. An
    // `a || 'expected'` fallback here would make the assertion unfalsifiable.
    expect(`${reactoryAzure.nameSpace}.${reactoryAzure.name}@${reactoryAzure.version}`)
      .toBe('core.ReactoryAzure@1.0.0');

    expect(reactoryAzure.services).toBe(services);
    expect(reactoryAzure.models).toBe(models);
    expect(reactoryAzure.forms).toBe(forms);
    expect((reactoryAzure as any).queues).toBe(queues);
    expect(reactoryAzure.middleware).toBe(middleware);
  });

  it('mounts the router at /azure', () => {
    expect(Object.keys(reactoryAzure.routes || {})).toEqual(['/azure']);
    expect((reactoryAzure.routes as any)['/azure']).toBeTruthy();
  });

  it('wires graph definitions with all eleven type files and eleven resolvers', () => {
    const graphDefinitions: any = reactoryAzure.graphDefinitions;

    expect(Array.isArray(graphDefinitions.Types)).toBe(true);
    expect(graphDefinitions.Types).toHaveLength(11);
    expect(graphDefinitions.Resolvers).toBeTruthy();
    expect(graphDefinitions.Resolvers.Query || graphDefinitions.Resolvers.Mutation).toBeTruthy();
  });

  it('wires the Reactor contribution', () => {
    expect((reactoryAzure as any).reactor).toMatchObject({
      providers: [],
      agents: [],
      mcp: [],
    });
  });
});
