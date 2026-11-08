/**
 * services/graph.ts — the retained compatibility shim.
 *
 * `reactory-core` reads two of these methods' *success shapes*, not just their
 * names:
 *   - `ProfileResolver.ts` passes the User-document token to `getUserDetails` and
 *     reads `msuser.avatar` from the result (and expects the raw `/me` payload
 *     otherwise);
 *   - `UserEmails.ts` maps `value[]` from `getEmails`.
 *
 * The rejection contract of `sendEmail`/`getEmails` is covered in
 * contract-shape.test.ts; here the success shapes and the surviving legacy task
 * calls are exercised, because "kept the names" is not the same promise as "kept
 * the shape".
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
import moment from 'moment';
// eslint-disable-next-line import/first
import ApiError from '@reactory/server-core/exceptions';
// eslint-disable-next-line import/first
import MSGraph from '../services/graph';

const sdk: any = jest.requireMock('@microsoft/microsoft-graph-client');
const chain = sdk.__chain;
const client = sdk.__client;

const TOKEN = 'legacy-user-document-token';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('shim.getUserDetails — the ProfileResolver contract', () => {
  it('returns the raw /me payload unchanged and does not fetch a photo by default', async () => {
    const me = { mail: 'ada@contoso.com', givenName: 'Ada', surname: 'Lovelace' };
    chain.get.mockResolvedValue(me);

    const result = await MSGraph.getUserDetails(TOKEN);

    expect(result).toBe(me);
    expect(result).toMatchObject({ mail: 'ada@contoso.com', givenName: 'Ada', surname: 'Lovelace' });
    expect(result.avatar).toBeUndefined();

    expect(client.api).toHaveBeenCalledWith('/me');
    expect(chain.select).toHaveBeenCalledWith('mail,givenName,surname');
    expect(chain.responseType).not.toHaveBeenCalled();
  });

  it('sets avatar when profileImage is true', async () => {
    const me = { mail: 'ada@contoso.com', givenName: 'Ada', surname: 'Lovelace' };
    chain.get
      .mockResolvedValueOnce(me)
      .mockResolvedValueOnce({ body: Buffer.from('jpeg-bytes'), headers: { 'content-type': 'image/jpeg' } });

    const result = await MSGraph.getUserDetails(TOKEN, { profileImage: true, imageSize: '48x48' });

    expect(result.avatar).toBe(`data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`);
    expect(client.api).toHaveBeenCalledWith('/me/photos/48x48/$value');
    expect(chain.responseType).toHaveBeenCalledWith('raw');
  });

  it('defaults the photo size to 120x120 and yields a null avatar when the photo is missing', async () => {
    chain.get
      .mockResolvedValueOnce({ mail: 'ada@contoso.com' })
      .mockRejectedValueOnce({ statusCode: 404, code: 'ImageNotFound' });

    const result = await MSGraph.getUserDetails(TOKEN, { profileImage: true });

    expect(result.avatar).toBeNull();
    expect(client.api).toHaveBeenCalledWith('/me/photos/120x120/$value');
  });

  it('rejects with an ApiError when /me fails', async () => {
    chain.get.mockRejectedValue({ statusCode: 500, code: 'generalException', message: 'boom' });

    await expect(MSGraph.getUserDetails(TOKEN)).rejects.toBeInstanceOf(ApiError);
    await expect(MSGraph.getUserDetails(TOKEN)).rejects.toMatchObject({ code: 'generalException' });
  });
});

describe('shim.getProfileImage', () => {
  it('returns a data URI using the response content type', async () => {
    chain.get.mockResolvedValue({ body: Buffer.from('png'), headers: { 'content-type': 'image/png' } });

    await expect(MSGraph.getProfileImage(TOKEN, '96x96')).resolves.toBe(
      `data:image/png;base64,${Buffer.from('png').toString('base64')}`,
    );
    expect(client.api).toHaveBeenCalledWith('/me/photos/96x96/$value');
  });

  it('returns null for an empty body', async () => {
    chain.get.mockResolvedValue({ body: Buffer.alloc(0) });
    await expect(MSGraph.getProfileImage(TOKEN)).resolves.toBeNull();
  });

  it('returns null when the body cannot be read at all', async () => {
    chain.get.mockResolvedValue({ headers: {} });
    await expect(MSGraph.getProfileImage(TOKEN)).resolves.toBeNull();
  });

  it('returns null on a Graph failure', async () => {
    chain.get.mockRejectedValue({ statusCode: 404, code: 'ImageNotFound' });
    await expect(MSGraph.getProfileImage(TOKEN)).resolves.toBeNull();
  });
});

describe('shim.getEvents', () => {
  it('keeps the original select and ordering and returns the raw page', async () => {
    const events = { value: [{ subject: 'Standup' }] };
    chain.get.mockResolvedValue(events);

    await expect(MSGraph.getEvents(TOKEN)).resolves.toBe(events);
    expect(client.api).toHaveBeenCalledWith('/me/events');
    expect(chain.select).toHaveBeenCalledWith('subject,organizer,start,end');
    expect(chain.orderby).toHaveBeenCalledWith('createdDateTime DESC');
  });

  it('rejects when Graph rejects', async () => {
    chain.get.mockRejectedValue({ statusCode: 403, code: 'ErrorAccessDenied' });

    await expect(MSGraph.getEvents(TOKEN)).rejects.toMatchObject({ code: 'ErrorAccessDenied' });
  });
});

describe('shim task methods (the documented beta block)', () => {
  it('getTasks reads /me/outlook/tasks on beta with the original select', async () => {
    const page = { value: [{ id: 't1' }] };
    chain.get.mockResolvedValue(page);

    await expect(MSGraph.getTasks(TOKEN, {})).resolves.toBe(page);
    expect(client.api).toHaveBeenCalledWith('/me/outlook/tasks');
    expect(chain.version).toHaveBeenCalledWith('beta');
    expect(chain.select).toHaveBeenCalledWith('id,dueDateTime,assignedTo,subject,body');
  });

  it('getTask addresses the single task by id', async () => {
    const task = { id: 't1', subject: 'Write tests' };
    chain.get.mockResolvedValue(task);

    await expect(MSGraph.getTask(TOKEN, 't1')).resolves.toBe(task);
    expect(client.api).toHaveBeenCalledWith('/me/outlook/tasks/t1');
    expect(chain.version).toHaveBeenCalledWith('beta');
  });

  it('deleteTask resolves to the Graph result and rejects on failure', async () => {
    chain.delete.mockResolvedValue(undefined);
    await expect(MSGraph.deleteTask(TOKEN, 't1')).resolves.toBeUndefined();
    expect(client.api).toHaveBeenCalledWith('/me/outlook/tasks/t1');

    chain.delete.mockRejectedValue({ statusCode: 404, code: 'ErrorItemNotFound' });
    await expect(MSGraph.deleteTask(TOKEN, 'gone')).rejects.toMatchObject({ code: 'ErrorItemNotFound' });
  });

  it('createTask posts a dateTimeTimeZone pair, not a bare ISO string', async () => {
    const created = { id: 't2' };
    chain.post.mockResolvedValue(created);

    const result = await MSGraph.createTask(
      TOKEN,
      'Write tests',
      null,
      moment('2026-11-08T09:00:00'),
      moment('2026-11-09T17:30:00'),
      'South Africa Standard Time',
    );

    expect(result).toBe(created);

    const body = chain.post.mock.calls[0][0];
    expect(body.subject).toBe('Write tests');
    expect(body.assignedTo).toBeNull();
    expect(body.startDateTime).toEqual({ dateTime: '2026-11-08T09:00:00', timeZone: 'South Africa Standard Time' });
    expect(body.dueDateTime).toEqual({ dateTime: '2026-11-09T17:30:00', timeZone: 'South Africa Standard Time' });
    expect(client.api).toHaveBeenCalledWith('/me/outlook/tasks');
  });

  it('createTask defaults the time zone and rejects on failure', async () => {
    chain.post.mockResolvedValue({ id: 't3' });

    await MSGraph.createTask(TOKEN, 'No zone', null, moment('2026-11-08T09:00:00'), moment('2026-11-09T09:00:00'));
    expect(chain.post.mock.calls[0][0].dueDateTime.timeZone).toBe('South Africa Standard Time');

    chain.post.mockRejectedValue({ statusCode: 400, code: 'ErrorInvalidRequest' });
    await expect(
      MSGraph.createTask(TOKEN, 'Bad', null, moment(), moment()),
    ).rejects.toMatchObject({ code: 'ErrorInvalidRequest' });
  });
});

describe('shim.getEmails — search and page shape', () => {
  it('passes $search through quoted and returns the raw page', async () => {
    const page = { value: [{ id: 'm1' }] };
    chain.get.mockResolvedValue(page);

    await expect(MSGraph.getEmails(TOKEN, { search: 'invoice' })).resolves.toBe(page);

    expect(client.api).toHaveBeenCalledWith('/me/messages');
    expect(chain.search).toHaveBeenCalledWith('"invoice"');
  });

  it('omits $search when the filter carries none', async () => {
    chain.get.mockResolvedValue({ value: [] });

    await MSGraph.getEmails(TOKEN, { size: 10 });

    expect(chain.search).not.toHaveBeenCalled();
  });
});

describe('shim.sendEmail — request shape', () => {
  it('defaults the content type to text and honours saveToSentItems', async () => {
    chain.post.mockResolvedValue(undefined);

    await MSGraph.sendEmail(TOKEN, 'Subject', null, 'Body', [{ emailAddress: { address: 'a@b.test' } }], false);

    const payload = chain.post.mock.calls[0][0];
    expect(payload.saveToSentItems).toBe(false);
    expect(payload.message.body).toEqual({ contentType: 'text', content: 'Body' });
    expect(client.api).toHaveBeenCalledWith('/me/sendMail');
  });
});

describe('shim.getProfileImage — body shapes', () => {
  it('drains a stream body', async () => {
    const { Readable } = require('stream');
    chain.get.mockResolvedValue({ body: Readable.from([Buffer.from('streamed')]), headers: {} });

    await expect(MSGraph.getProfileImage(TOKEN)).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from('streamed').toString('base64')}`,
    );
  });

  it('reads an arrayBuffer() body', async () => {
    chain.get.mockResolvedValue({
      body: { arrayBuffer: async () => new Uint8Array([120]).buffer },
      headers: {},
    });

    await expect(MSGraph.getProfileImage(TOKEN)).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from('x').toString('base64')}`,
    );
  });
});
