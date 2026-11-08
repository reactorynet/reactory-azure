import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

/**
 * AZ-13 macro + persona suite.
 *
 * The rule this suite is built around: **AZURE_MACROS is a shared array**.
 * AZ-01 assembles it from every `ai/macros/<domain>.macros.ts`, AZ-13 fills seven
 * of those files and AZ-14 fills `teams.macros.ts` independently. So every
 * assertion here is a *subset* assertion - "this name is present, exactly once" -
 * and never a whole-array length. A length assertion would be correct only on one
 * merge order and would break on the other.
 *
 * Nothing here touches Graph: the macros are called with a fake chat context
 * whose `getService` returns a jest double keyed by FQN. That is also the proof
 * that no macro holds a service singleton - the fake context is the only way the
 * component can reach a service.
 */

import { AZURE_MACROS } from '../ai';
import { STATUS_MACROS } from '../ai/macros/status.macros';
import { MAIL_MACROS } from '../ai/macros/mail.macros';
import { CALENDAR_MACROS } from '../ai/macros/calendar.macros';
import { DRIVE_MACROS } from '../ai/macros/drive.macros';
import { WORKBOOK_MACROS } from '../ai/macros/workbook.macros';
import { CONTACTS_MACROS } from '../ai/macros/contacts.macros';
import { TASKS_MACROS } from '../ai/macros/tasks.macros';
import { buildParameters, isNotConnected, notConnected } from '../ai/macros/macro-support';

const MODULE_ROOT = path.resolve(__dirname, '..');
const MACROS_DIR = path.join(MODULE_ROOT, 'ai', 'macros');
const PERSONA_PATH = path.join(MODULE_ROOT, 'ai', 'persona', 'AzureWorkspaceAssistant', 'agent.yaml');

const USER_ID = '5f8f9c1e2b3a4d5e6f7a8b9c';

/** The nine AZ-13 macros. `azure_send_teams_message` is AZ-14's, not ours. */
const NINE = [
  'azure_connection_status',
  'azure_send_email',
  'azure_search_email',
  'azure_create_event',
  'azure_list_events',
  'azure_search_drive',
  'azure_read_workbook',
  'azure_list_contacts',
  'azure_create_task',
];

/** The service each macro must resolve through `context.getService`. */
const SERVICE_FQN: Record<string, string> = {
  azure_connection_status: 'azure.AzureService@1.0.0',
  azure_send_email: 'azure.AzureMailService@1.0.0',
  azure_search_email: 'azure.AzureMailService@1.0.0',
  azure_create_event: 'azure.AzureCalendarService@1.0.0',
  azure_list_events: 'azure.AzureCalendarService@1.0.0',
  azure_search_drive: 'azure.AzureDriveService@1.0.0',
  azure_read_workbook: 'azure.AzureWorkbookService@1.0.0',
  azure_list_contacts: 'azure.AzureContactsService@1.0.0',
  azure_create_task: 'azure.AzureTodoService@1.0.0',
};

/** Every macro in AZURE_MACROS carrying `name`. */
const macrosNamed = (name: string): any[] => AZURE_MACROS.filter((macro: any) => macro.name === name);

/** The single macro carrying `name`; fails the test if it is missing or duplicated. */
const macroNamed = (name: string): any => {
  const found = macrosNamed(name);
  expect(found).toHaveLength(1);
  return found[0];
};

const toolOf = (name: string): any => macroNamed(name).tools[0].function;
const parametersOf = (name: string): any => toolOf(name).parameters;

/** A fake chat context that resolves exactly the services passed in. */
const stateWith = (services: Record<string, any>, user: any = { _id: USER_ID }) => ({
  context: {
    user,
    getService: jest.fn((id: string) => services[id]),
  },
} as any);

/** Invoke a macro component without fighting the generic component type. */
const run = (macro: any, params: any, state: any): Promise<any> => macro.component(params, state);

/** Assert the result survives `JSON.stringify` unchanged in substance. */
const expectJsonSerialisable = (value: any) => {
  const json = JSON.stringify(value);
  expect(typeof json).toBe('string');
  expect(JSON.parse(json)).toEqual(expect.any(Object));
};

const sourceOf = (file: string): string => fs.readFileSync(path.join(MACROS_DIR, file), 'utf8');

const macroFiles = (): string[] => fs.readdirSync(MACROS_DIR).filter((file) => file.endsWith('.macros.ts'));

/* -------------------------------------------------------------------------- */
/* Registration - subset assertions only                                      */
/* -------------------------------------------------------------------------- */

describe('AZ-13 macro registration', () => {
  it.each(NINE)('%s is present in AZURE_MACROS exactly once', (name) => {
    const found = macrosNamed(name);

    // Subset semantics: present, not "the array has N entries". AZ-14 adds its
    // Teams macro to the same array, so a length assertion would be wrong.
    expect(found).toHaveLength(1);
    expect(AZURE_MACROS).toEqual(expect.arrayContaining([found[0]]));
  });

  it.each(NINE)('%s is a well-formed azure macro definition', (name) => {
    const macro = macroNamed(name);

    expect(macro.nameSpace).toBe('azure');
    expect(macro.version).toBe('1.0.0');
    expect(typeof macro.component).toBe('function');
    expect(typeof macro.description).toBe('string');
    expect(macro.description.length).toBeGreaterThan(0);

    expect(Array.isArray(macro.tools)).toBe(true);
    expect(macro.tools).toHaveLength(1);
    expect(macro.tools[0].type).toBe('function');
    expect(macro.tools[0].function.name).toBe(name);
  });

  it('contributes every macro from its own per-domain array (no barrel edit)', () => {
    const domainArrays = [
      STATUS_MACROS,
      MAIL_MACROS,
      CALENDAR_MACROS,
      DRIVE_MACROS,
      WORKBOOK_MACROS,
      CONTACTS_MACROS,
      TASKS_MACROS,
    ];

    for (const array of domainArrays) {
      expect(Array.isArray(array)).toBe(true);
      for (const macro of array as any[]) {
        expect(AZURE_MACROS).toEqual(expect.arrayContaining([macro]));
      }
    }

    expect((STATUS_MACROS as any[]).map((macro) => macro.name)).toEqual(['azure_connection_status']);
    expect((MAIL_MACROS as any[]).map((macro) => macro.name)).toEqual(['azure_send_email', 'azure_search_email']);
    expect((CALENDAR_MACROS as any[]).map((macro) => macro.name)).toEqual(['azure_create_event', 'azure_list_events']);
    expect((DRIVE_MACROS as any[]).map((macro) => macro.name)).toEqual(['azure_search_drive']);
    expect((WORKBOOK_MACROS as any[]).map((macro) => macro.name)).toEqual(['azure_read_workbook']);
    expect((CONTACTS_MACROS as any[]).map((macro) => macro.name)).toEqual(['azure_list_contacts']);
    expect((TASKS_MACROS as any[]).map((macro) => macro.name)).toEqual(['azure_create_task']);
  });

  it('does not declare the Teams macro in any file other than teams.macros.ts', () => {
    expect(fs.existsSync(path.join(MACROS_DIR, 'teams.macros.ts'))).toBe(true);

    for (const file of fs.readdirSync(MACROS_DIR).filter((entry) => entry.endsWith('.ts'))) {
      if (file === 'teams.macros.ts') continue;
      expect({ file, declaresTeams: sourceOf(file).includes('azure_send_teams_message') })
        .toEqual({ file, declaresTeams: false });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Parameter schemas                                                          */
/* -------------------------------------------------------------------------- */

describe('macro parameter schemas', () => {
  it.each(NINE)('%s declares an object schema with described parameters', (name) => {
    const parameters = parametersOf(name);

    expect(parameters).toBeDefined();
    expect(parameters.type).toBe('object');
    expect(parameters.properties).toEqual(expect.any(Object));
    expect(parameters.required).toEqual(expect.any(Array));
  });

  it.each(NINE)('%s gives every parameter a non-empty description', (name) => {
    const parameters = parametersOf(name);
    const properties = Object.entries(parameters.properties || {});

    for (const [parameterName, schema] of properties) {
      expect({ parameterName, hasDescription: typeof (schema as any).description === 'string' }).toEqual({
        parameterName,
        hasDescription: true,
      });
      expect((schema as any).description.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(NINE)('%s lists every required parameter in schema.required and nothing else', (name) => {
    const parameters = parametersOf(name);
    const propertyNames = Object.keys(parameters.properties || {});

    for (const requiredName of parameters.required) {
      expect(propertyNames).toContain(requiredName);
    }

    // The authoring `required` flag is translated into the schema-level array;
    // it must not leak into a property schema, where it would be invalid JSON
    // Schema and rejected by a provider.
    for (const schema of Object.values(parameters.properties || {})) {
      expect((schema as any).required).toBeUndefined();
    }
  });

  it('marks exactly the parameters a caller cannot omit as required', () => {
    expect(parametersOf('azure_send_email').required).toEqual(['to', 'subject', 'body']);
    expect(parametersOf('azure_search_email').required).toEqual(['query']);
    expect(parametersOf('azure_create_event').required).toEqual(['subject', 'start', 'end']);
    expect(parametersOf('azure_list_events').required).toEqual([]);
    expect(parametersOf('azure_search_drive').required).toEqual(['query']);
    expect(parametersOf('azure_read_workbook').required).toEqual(['itemId']);
    expect(parametersOf('azure_list_contacts').required).toEqual([]);
    expect(parametersOf('azure_create_task').required).toEqual(['title']);
    expect(parametersOf('azure_connection_status').required).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Service resolution - fake context, no singleton                            */
/* -------------------------------------------------------------------------- */

describe('service resolution', () => {
  it('imports no service singleton in any macro file', () => {
    for (const file of fs.readdirSync(MACROS_DIR).filter((entry) => entry.endsWith('.ts'))) {
      const source = sourceOf(file);

      // A service must be resolved from the chat context. Importing a service
      // module (or the barrel) would freeze a singleton into the macro and make
      // the fake-context tests below meaningless.
      expect({ file, importedFromServices: /from\s+['"][^'"]*\/services(\/|['"])/.test(source) })
        .toEqual({ file, importedFromServices: false });
      expect({ file, requiredServices: /require\(\s*['"][^'"]*\/services/.test(source) })
        .toEqual({ file, requiredServices: false });
    }
  });

  it.each(NINE)('%s resolves its service through context.getService', (name) => {
    const files = macroFiles().filter((file) => sourceOf(file).includes(name));

    expect(files.length).toBeGreaterThan(0);

    const source = files.map(sourceOf).join('\n');
    const fqn = SERVICE_FQN[name];

    expect(source).toContain(fqn);
    expect(source).toMatch(new RegExp(`getService\\(\\s*['"]${fqn.replace(/\./g, '\\.')}['"]\\s*\\)`));
  });

  it('reads the connection status from the AzureService facade', async () => {
    const azureService = {
      getConnectionStatus: jest.fn().mockResolvedValue({
        userId: USER_ID,
        status: 'CONNECTED',
        email: 'user@example.com',
        grantedScopes: ['Mail.Read', 'Calendars.ReadWrite'],
        connectedAt: new Date('2026-01-02T03:04:05.000Z'),
      }),
    };

    const result = await run(STATUS_MACROS[0], {}, stateWith({ 'azure.AzureService@1.0.0': azureService }));

    expect(azureService.getConnectionStatus).toHaveBeenCalledWith(USER_ID);
    expect(result).toMatchObject({
      success: true,
      tool: 'azure_connection_status',
      data: {
        connected: true,
        status: 'CONNECTED',
        email: 'user@example.com',
        grantedScopes: ['Mail.Read', 'Calendars.ReadWrite'],
        connectedAt: '2026-01-02T03:04:05.000Z',
      },
    });
    expectJsonSerialisable(result);
  });

  it('reports a disconnected account as connected: false instead of throwing', async () => {
    const azureService = {
      getConnectionStatus: jest.fn().mockResolvedValue({ userId: USER_ID, status: 'DISCONNECTED', grantedScopes: [] }),
    };

    const result = await run(STATUS_MACROS[0], {}, stateWith({ 'azure.AzureService@1.0.0': azureService }));

    expect(result.success).toBe(true);
    expect(result.data.connected).toBe(false);
    expect(result.data.status).toBe('DISCONNECTED');
    expect(result.message).toMatch(/not connected/i);
  });

  it('omits granted scopes when includeScopes is false', async () => {
    const azureService = {
      getConnectionStatus: jest.fn().mockResolvedValue({
        userId: USER_ID,
        status: 'CONNECTED',
        grantedScopes: ['Mail.Read'],
      }),
    };

    const result = await run(
      STATUS_MACROS[0],
      { includeScopes: false },
      stateWith({ 'azure.AzureService@1.0.0': azureService }),
    );

    expect(result.data.grantedScopes).toBeUndefined();
    expect(result.data.connected).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Mail                                                                       */
/* -------------------------------------------------------------------------- */

describe('azure_send_email', () => {
  it('sends through AzureMailService with a normalised payload', async () => {
    const mailService = { sendMessage: jest.fn().mockResolvedValue(true) };

    const result = await run(
      MAIL_MACROS[0],
      { to: 'alice@example.com, bob@example.com', cc: ['carol@example.com'], subject: 'Hello', body: 'Hi there' },
      stateWith({ 'azure.AzureMailService@1.0.0': mailService }),
    );

    expect(mailService.sendMessage).toHaveBeenCalledWith(
      USER_ID,
      {
        subject: 'Hello',
        body: { contentType: 'text', content: 'Hi there' },
        toRecipients: ['alice@example.com', 'bob@example.com'],
        ccRecipients: ['carol@example.com'],
      },
      { saveToSentItems: true },
    );
    expect(result).toMatchObject({
      success: true,
      tool: 'azure_send_email',
      data: { sent: true, to: ['alice@example.com', 'bob@example.com'], subject: 'Hello' },
    });
    expectJsonSerialisable(result);
  });

  it('refuses an empty recipient list without calling the service', async () => {
    const mailService = { sendMessage: jest.fn() };

    const result = await run(
      MAIL_MACROS[0],
      { to: [], subject: 'Hello', body: 'Hi' },
      stateWith({ 'azure.AzureMailService@1.0.0': mailService }),
    );

    expect(mailService.sendMessage).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/"to"/);
  });

  it('refuses a missing subject or body', async () => {
    const mailService = { sendMessage: jest.fn() };
    const state = stateWith({ 'azure.AzureMailService@1.0.0': mailService });

    const noSubject = await run(MAIL_MACROS[0], { to: 'a@example.com', body: 'Hi' }, state);
    const noBody = await run(MAIL_MACROS[0], { to: 'a@example.com', subject: 'Hello' }, state);

    expect(noSubject.success).toBe(false);
    expect(noSubject.error).toMatch(/subject/);
    expect(noBody.success).toBe(false);
    expect(noBody.error).toMatch(/body/);
    expect(mailService.sendMessage).not.toHaveBeenCalled();
  });
});

describe('azure_search_email', () => {
  const message = {
    id: 'AAMkAD',
    subject: 'Quarterly report',
    from: { name: 'Alice', address: 'alice@example.com' },
    toRecipients: [{ address: 'me@example.com' }],
    receivedDateTime: '2026-11-01T08:00:00Z',
    isRead: false,
    hasAttachments: true,
    importance: 'normal',
    bodyPreview: 'Attached is the report',
    webLink: 'https://outlook.example/message',
  };

  it('searches the mailbox with the caller\'s KQL expression', async () => {
    const mailService = { listMessages: jest.fn().mockResolvedValue({ items: [message], nextLink: 'next-page' }) };

    const result = await run(
      MAIL_MACROS[1],
      { query: 'from:alice@example.com', top: 5 },
      stateWith({ 'azure.AzureMailService@1.0.0': mailService }),
    );

    expect(mailService.listMessages).toHaveBeenCalledWith(USER_ID, { search: 'from:alice@example.com', top: 5 });
    expect(result.success).toBe(true);
    expect(result.data.count).toBe(1);
    expect(result.data.nextLink).toBe('next-page');
    expect(result.data.items[0]).toMatchObject({ id: 'AAMkAD', subject: 'Quarterly report', isRead: false });
    expectJsonSerialisable(result);
  });

  it('scopes the search to a folder when folderId is supplied', async () => {
    const mailService = { listMessagesInFolder: jest.fn().mockResolvedValue({ items: [message] }) };

    const result = await run(
      MAIL_MACROS[1],
      { query: 'subject:"Quarterly report"', folderId: 'FOLDER' },
      stateWith({ 'azure.AzureMailService@1.0.0': mailService }),
    );

    expect(mailService.listMessagesInFolder).toHaveBeenCalledWith(USER_ID, 'FOLDER', {
      search: 'subject:"Quarterly report"',
      top: 10,
    });
    expect(result.data.count).toBe(1);
  });

  it('refuses an empty query without calling the service', async () => {
    const mailService = { listMessages: jest.fn() };

    const result = await run(MAIL_MACROS[1], { query: '   ' }, stateWith({ 'azure.AzureMailService@1.0.0': mailService }));

    expect(mailService.listMessages).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/query/);
  });
});

/* -------------------------------------------------------------------------- */
/* Calendar                                                                   */
/* -------------------------------------------------------------------------- */

describe('azure_create_event', () => {
  it('creates an event with an explicit dateTimeTimeZone and attendees', async () => {
    const calendarService = {
      createEvent: jest.fn().mockResolvedValue({
        id: 'EVENT',
        subject: 'Standup',
        start: { dateTime: '2026-11-09T09:00:00', timeZone: 'UTC' },
        end: { dateTime: '2026-11-09T09:30:00', timeZone: 'UTC' },
        onlineMeeting: { joinUrl: 'https://teams.example/join' },
        webLink: 'https://outlook.example/event',
      }),
    };

    const result = await run(
      CALENDAR_MACROS[0],
      {
        subject: 'Standup',
        start: '2026-11-09T09:00:00',
        end: '2026-11-09T09:30:00',
        timeZone: 'UTC',
        attendees: 'alice@example.com',
        isOnlineMeeting: true,
      },
      stateWith({ 'azure.AzureCalendarService@1.0.0': calendarService }),
    );

    expect(calendarService.createEvent).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      subject: 'Standup',
      start: { dateTime: '2026-11-09T09:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-11-09T09:30:00', timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: 'alice@example.com' }, type: 'required' }],
      isOnlineMeeting: true,
    }));
    expect(result).toMatchObject({ success: true, tool: 'azure_create_event', data: { id: 'EVENT' } });
    expect(result.data.joinUrl).toBe('https://teams.example/join');
    expectJsonSerialisable(result);
  });

  it('requires both ends of the slot', async () => {
    const calendarService = { createEvent: jest.fn() };
    const state = stateWith({ 'azure.AzureCalendarService@1.0.0': calendarService });

    const result = await run(CALENDAR_MACROS[0], { subject: 'Standup', start: '2026-11-09T09:00:00' }, state);

    expect(calendarService.createEvent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/start/);
  });
});

describe('azure_list_events', () => {
  const event = {
    id: 'EVENT',
    subject: 'Standup',
    start: { dateTime: '2026-11-09T09:00:00', timeZone: 'UTC' },
    end: { dateTime: '2026-11-09T09:30:00', timeZone: 'UTC' },
    location: { displayName: 'Room 1' },
    isOnlineMeeting: false,
  };

  it('reads a range from AzureCalendarService', async () => {
    const calendarService = { listEvents: jest.fn().mockResolvedValue([event]) };

    const result = await run(
      CALENDAR_MACROS[1],
      { start: '2026-11-09T00:00:00', end: '2026-11-10T00:00:00', timeZone: 'UTC', top: 50 },
      stateWith({ 'azure.AzureCalendarService@1.0.0': calendarService }),
    );

    expect(calendarService.listEvents).toHaveBeenCalledWith(USER_ID, {
      start: { dateTime: '2026-11-09T00:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-11-10T00:00:00', timeZone: 'UTC' },
      top: 50,
    });
    expect(result.data.count).toBe(1);
    expect(result.data.items[0]).toMatchObject({ id: 'EVENT', location: 'Room 1' });
    expectJsonSerialisable(result);
  });

  it('rejects a half-specified range instead of reading an unbounded calendar', async () => {
    const calendarService = { listEvents: jest.fn() };

    const result = await run(
      CALENDAR_MACROS[1],
      { start: '2026-11-09T00:00:00' },
      stateWith({ 'azure.AzureCalendarService@1.0.0': calendarService }),
    );

    expect(calendarService.listEvents).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/both/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Drive                                                                      */
/* -------------------------------------------------------------------------- */

describe('azure_search_drive', () => {
  it('summarises the hits returned by AzureDriveService', async () => {
    const driveService = {
      search: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'ITEM',
            name: 'Budget.xlsx',
            webUrl: 'https://onedrive.example/budget',
            size: 1024,
            file: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
            parentReference: { path: '/drive/root:/Finance' },
            lastModifiedDateTime: '2026-10-01T00:00:00Z',
          },
          {
            id: 'FOLDER',
            name: 'Finance',
            folder: { childCount: 3 },
          },
        ],
        nextLink: 'next-page',
      }),
    };

    const result = await run(
      DRIVE_MACROS[0],
      { query: 'Budget' },
      stateWith({ 'azure.AzureDriveService@1.0.0': driveService }),
    );

    expect(driveService.search).toHaveBeenCalledWith(USER_ID, 'Budget', { top: 10 });
    expect(result.success).toBe(true);
    expect(result.data.count).toBe(2);
    expect(result.data.nextLink).toBe('next-page');
    expect(result.data.items[0]).toMatchObject({
      id: 'ITEM',
      name: 'Budget.xlsx',
      isFolder: false,
      path: '/drive/root:/Finance',
    });
    expect(result.data.items[1]).toMatchObject({ id: 'FOLDER', isFolder: true, childCount: 3 });
    expectJsonSerialisable(result);
  });

  it('refuses an empty query without calling the service', async () => {
    const driveService = { search: jest.fn() };

    const result = await run(DRIVE_MACROS[0], { query: '' }, stateWith({ 'azure.AzureDriveService@1.0.0': driveService }));

    expect(driveService.search).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/query/);
  });
});

/* -------------------------------------------------------------------------- */
/* Workbook                                                                   */
/* -------------------------------------------------------------------------- */

describe('azure_read_workbook', () => {
  const usedRange = {
    address: 'Sheet1!A1:B2',
    rowCount: 2,
    columnCount: 2,
    cellCount: 4,
    values: [['Name', 'Total'], ['Widgets', 12]],
    text: [['Name', 'Total'], ['Widgets', '12']],
  };

  it('reads the used range of the named worksheet', async () => {
    const workbookService = { getUsedRange: jest.fn().mockResolvedValue(usedRange) };

    const result = await run(
      WORKBOOK_MACROS[0],
      { itemId: 'ITEM', worksheet: 'Sheet1' },
      stateWith({ 'azure.AzureWorkbookService@1.0.0': workbookService }),
    );

    expect(workbookService.getUsedRange).toHaveBeenCalledWith(USER_ID, 'ITEM', 'Sheet1', { valuesOnly: true });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      itemId: 'ITEM',
      worksheet: 'Sheet1',
      address: 'Sheet1!A1:B2',
      rowCount: 2,
      values: [['Name', 'Total'], ['Widgets', 12]],
    });
    expectJsonSerialisable(result);
  });

  it('falls back to the first worksheet when none is named', async () => {
    const workbookService = {
      listWorksheets: jest.fn().mockResolvedValue([{ id: 'ws-1', name: 'Data' }, { id: 'ws-2', name: 'Notes' }]),
      getUsedRange: jest.fn().mockResolvedValue(usedRange),
    };

    const result = await run(
      WORKBOOK_MACROS[0],
      { itemId: 'ITEM', valuesOnly: false },
      stateWith({ 'azure.AzureWorkbookService@1.0.0': workbookService }),
    );

    expect(workbookService.listWorksheets).toHaveBeenCalledWith(USER_ID, 'ITEM', {});
    expect(workbookService.getUsedRange).toHaveBeenCalledWith(USER_ID, 'ITEM', 'Data', { valuesOnly: false });
    expect(result.data.worksheet).toBe('Data');
  });

  it('reads an explicit A1 range when one is supplied', async () => {
    const workbookService = { getRange: jest.fn().mockResolvedValue(usedRange) };

    const result = await run(
      WORKBOOK_MACROS[0],
      { itemId: 'ITEM', worksheet: 'Sheet1', range: 'A1:B2' },
      stateWith({ 'azure.AzureWorkbookService@1.0.0': workbookService }),
    );

    expect(workbookService.getRange).toHaveBeenCalledWith(USER_ID, 'ITEM', 'Sheet1', 'A1:B2', {});
    expect(result.data.address).toBe('Sheet1!A1:B2');
  });

  it('requires an itemId', async () => {
    const workbookService = { getUsedRange: jest.fn() };

    const result = await run(WORKBOOK_MACROS[0], {}, stateWith({ 'azure.AzureWorkbookService@1.0.0': workbookService }));

    expect(workbookService.getUsedRange).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/itemId/);
  });
});

/* -------------------------------------------------------------------------- */
/* Contacts                                                                   */
/* -------------------------------------------------------------------------- */

describe('azure_list_contacts', () => {
  it('summarises one page of contacts', async () => {
    const contactsService = {
      listContacts: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'CONTACT',
            displayName: 'Alice Adams',
            givenName: 'Alice',
            surname: 'Adams',
            emailAddresses: [{ name: 'Alice', address: 'alice@example.com' }, { address: '' }],
            businessPhones: ['+27 11 000 0000'],
            mobilePhone: '+27 82 000 0000',
            companyName: 'Example (Pty) Ltd',
            jobTitle: 'Engineer',
          },
        ],
        count: 1,
        nextLink: 'next-page',
      }),
    };

    const result = await run(
      CONTACTS_MACROS[0],
      {},
      stateWith({ 'azure.AzureContactsService@1.0.0': contactsService }),
    );

    expect(contactsService.listContacts).toHaveBeenCalledWith(USER_ID, { top: 25 });
    expect(result.success).toBe(true);
    expect(result.data.count).toBe(1);
    expect(result.data.items[0]).toMatchObject({
      id: 'CONTACT',
      displayName: 'Alice Adams',
      emails: ['alice@example.com'],
      jobTitle: 'Engineer',
    });
    expectJsonSerialisable(result);
  });

  it('drains every page when all is true', async () => {
    const contactsService = {
      listContacts: jest.fn().mockResolvedValue({ items: [] }),
    };

    await run(
      CONTACTS_MACROS[0],
      { all: true },
      stateWith({ 'azure.AzureContactsService@1.0.0': contactsService }),
    );

    expect(contactsService.listContacts).toHaveBeenCalledWith(USER_ID, { all: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Tasks                                                                      */
/* -------------------------------------------------------------------------- */

describe('azure_create_task', () => {
  it('creates a task in the supplied list with a dateTimeTimeZone due date', async () => {
    const todoService = {
      createTask: jest.fn().mockResolvedValue({
        id: 'TASK',
        title: 'File the report',
        status: 'notStarted',
        importance: 'high',
      }),
    };

    const result = await run(
      TASKS_MACROS[0],
      {
        title: 'File the report',
        listId: 'LIST',
        dueDateTime: '2026-11-09T17:00:00',
        timeZone: 'UTC',
        importance: 'high',
        categories: ['Work'],
      },
      stateWith({ 'azure.AzureTodoService@1.0.0': todoService }),
    );

    expect(todoService.createTask).toHaveBeenCalledWith(USER_ID, 'LIST', {
      title: 'File the report',
      importance: 'high',
      dueDateTime: { dateTime: '2026-11-09T17:00:00', timeZone: 'UTC' },
      categories: ['Work'],
    });
    expect(result).toMatchObject({ success: true, tool: 'azure_create_task', data: { id: 'TASK', listId: 'LIST' } });
    expectJsonSerialisable(result);
  });

  it('falls back to the well-known default list when listId is omitted', async () => {
    const todoService = {
      listTaskLists: jest.fn().mockResolvedValue([
        { id: 'OTHER', displayName: 'Chores' },
        { id: 'DEFAULT', displayName: 'Tasks', wellknownListName: 'defaultList' },
      ]),
      createTask: jest.fn().mockResolvedValue({ id: 'TASK', title: 'Buy milk' }),
    };

    const result = await run(
      TASKS_MACROS[0],
      { title: 'Buy milk' },
      stateWith({ 'azure.AzureTodoService@1.0.0': todoService }),
    );

    expect(todoService.listTaskLists).toHaveBeenCalledWith(USER_ID);
    expect(todoService.createTask).toHaveBeenCalledWith(USER_ID, 'DEFAULT', { title: 'Buy milk' });
    expect(result.data.listId).toBe('DEFAULT');
  });

  it('requires a title', async () => {
    const todoService = { createTask: jest.fn(), listTaskLists: jest.fn() };

    const result = await run(
      TASKS_MACROS[0],
      { listId: 'LIST' },
      stateWith({ 'azure.AzureTodoService@1.0.0': todoService }),
    );

    expect(todoService.createTask).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/title/);
  });
});

/* -------------------------------------------------------------------------- */
/* Not connected - an answer, never a throw                                   */
/* -------------------------------------------------------------------------- */

describe('not-connected handling', () => {
  const cases: Array<[string, any, string, any]> = [
    ['azure_connection_status', STATUS_MACROS[0], 'getConnectionStatus', {}],
    ['azure_send_email', MAIL_MACROS[0], 'sendMessage', { to: 'a@example.com', subject: 'S', body: 'B' }],
    ['azure_search_email', MAIL_MACROS[1], 'listMessages', { query: 'from:a@example.com' }],
    ['azure_create_event', CALENDAR_MACROS[0], 'createEvent', {
      subject: 'S',
      start: '2026-11-09T10:00:00',
      end: '2026-11-09T11:00:00',
    }],
    ['azure_list_events', CALENDAR_MACROS[1], 'listEvents', {}],
    ['azure_search_drive', DRIVE_MACROS[0], 'search', { query: 'budget' }],
    ['azure_read_workbook', WORKBOOK_MACROS[0], 'getUsedRange', { itemId: 'ITEM', worksheet: 'Sheet1' }],
    ['azure_list_contacts', CONTACTS_MACROS[0], 'listContacts', {}],
    ['azure_create_task', TASKS_MACROS[0], 'createTask', { title: 'T', listId: 'LIST' }],
  ];

  it.each(cases)('%s returns a not-connected payload when the service rejects with NotConnected', async (
    name,
    macro,
    method,
    params,
  ) => {
    const notConnectedError = Object.assign(
      new Error(`Microsoft Graph is not connected for user ${USER_ID}`),
      { code: 'NotConnected' },
    );
    const service = { [method]: jest.fn().mockRejectedValue(notConnectedError) };

    const result = await run(macro, params, stateWith({ [SERVICE_FQN[name]]: service }));

    expect(result.success).toBe(false);
    expect(result.connected).toBe(false);
    expect(result.status).toBe('DISCONNECTED');
    expect(result.tool).toBe(name);
    expect(result.error).toMatch(/not connected/i);
    expect(result.instructions).toMatch(/connect/i);
    expectJsonSerialisable(result);
  });

  it.each(cases)('%s returns a not-connected payload when the service is not registered', async (
    name,
    macro,
    _method,
    params,
  ) => {
    const result = await run(macro, params, stateWith({}));

    expect(result.success).toBe(false);
    expect(result.connected).toBe(false);
    expect(result.status).toBe('DISCONNECTED');
    expect(result.tool).toBe(name);
    expectJsonSerialisable(result);
  });

  it('recognises the module error code and its message fallback', () => {
    expect(isNotConnected(Object.assign(new Error('nope'), { code: 'NotConnected' }))).toBe(true);
    expect(isNotConnected(Object.assign(new Error('nope'), { code: 'InvalidAuthenticationToken' }))).toBe(true);
    expect(isNotConnected(new Error('Microsoft Graph is not connected for user x'))).toBe(true);
    expect(isNotConnected(new Error('itemNotFound'))).toBe(false);
    expect(isNotConnected(undefined)).toBe(false);
  });

  it('builds a serialisable not-connected envelope', () => {
    const payload = notConnected('azure_probe', { a: 1 });

    expect(payload).toMatchObject({ success: false, connected: false, status: 'DISCONNECTED', tool: 'azure_probe' });
    expect(payload.instructions).toMatch(/connect/i);
    expectJsonSerialisable(payload);
  });
});

/* -------------------------------------------------------------------------- */
/* Parameter builder                                                          */
/* -------------------------------------------------------------------------- */

describe('parameter builder', () => {
  it('translates the required flag into schema.required', () => {
    const schema = buildParameters([
      { name: 'a', type: 'string', description: 'A value', required: true },
      { name: 'b', type: 'integer', description: 'B value', required: false, default: 5 },
      { name: 'c', type: 'string', description: 'C value', required: false, enum: ['x', 'y'] },
    ]);

    expect(schema.required).toEqual(['a']);
    expect(schema.properties.a).toEqual({ type: 'string', description: 'A value' });
    expect(schema.properties.b).toMatchObject({ type: 'integer', description: 'B value', default: 5 });
    expect(schema.properties.c).toMatchObject({ enum: ['x', 'y'] });
  });
});

/* -------------------------------------------------------------------------- */
/* Persona                                                                    */
/* -------------------------------------------------------------------------- */

describe('AzureWorkspaceAssistant persona', () => {
  const persona: any = yaml.load(fs.readFileSync(PERSONA_PATH, 'utf8'));

  it('parses and carries the required identity', () => {
    expect(persona).toEqual(expect.any(Object));
    expect(persona.id).toBe('AzureWorkspaceAssistant');
    expect(persona.name).toBe('Azure Workspace Assistant');
    expect(persona.namespace).toBe('azure');
    expect(typeof persona.persona).toBe('string');
    expect(persona.persona.length).toBeGreaterThan(0);
    expect(typeof persona.features).toBe('string');
  });

  it('lists only tools this module actually registers', () => {
    const registered = new Set(AZURE_MACROS.map((macro: any) => macro.name));
    const included: string[] = persona.tools?.includes || [];

    expect(included.length).toBeGreaterThan(0);
    expect(new Set(included).size).toBe(included.length);

    for (const tool of included) {
      expect({ tool, registered: registered.has(tool) }).toEqual({ tool, registered: true });
    }
  });

  it('exposes exactly the nine AZ-13 macros', () => {
    expect(new Set(persona.tools.includes)).toEqual(new Set(NINE));
  });

  it('lists only macros this module actually registers', () => {
    const registered = new Set(AZURE_MACROS.map((macro: any) => macro.name));
    const included: string[] = persona.macros?.includes || [];

    for (const macro of included) {
      expect({ macro, registered: registered.has(macro) }).toEqual({ macro, registered: true });
    }
  });
});
