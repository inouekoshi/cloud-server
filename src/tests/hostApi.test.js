const http = require('http');
const { createHostApi, HostRelayStore, tokenMatches } = require('../hostApi');

describe('HostRelayStore', () => {
  test('commands get increasing sequence numbers', () => {
    const store = new HostRelayStore(() => 1000);
    expect(store.pushCommand({ type: 'next', expect_state: 0 })).toBe(1);
    expect(store.pushCommand({ type: 'answer', value: 42 })).toBe(2);
    expect(store.commandsAfter(0)).toEqual({
      latest: 2,
      commands: [
        { seq: 1, type: 'next', expect_state: 0, at: 1000 },
        { seq: 2, type: 'answer', value: 42, at: 1000 },
      ],
    });
    expect(store.commandsAfter(1).commands.map((c) => c.seq)).toEqual([2]);
    expect(store.commandsAfter(2)).toEqual({ latest: 2, commands: [] });
  });

  test('resync is accepted without extra fields', () => {
    const store = new HostRelayStore(() => 1000);
    expect(store.pushCommand({ type: 'resync', value: 5 })).toBe(1);
    expect(store.commandsAfter(0).commands).toEqual([{ seq: 1, type: 'resync', at: 1000 }]);
  });

  test('invalid commands are rejected', () => {
    const store = new HostRelayStore();
    expect(() => store.pushCommand(null)).toThrow();
    expect(() => store.pushCommand([])).toThrow();
    expect(() => store.pushCommand({ type: 'reset' })).toThrow();
    expect(() => store.pushCommand({ type: 'answer', value: 101 })).toThrow();
    expect(() => store.pushCommand({ type: 'answer', value: -1 })).toThrow();
    expect(() => store.pushCommand({ type: 'answer', value: 4.5 })).toThrow();
    expect(() => store.pushCommand({ type: 'answer', value: '50' })).toThrow();
    expect(() => store.pushCommand({ type: 'next', expect_state: '3' })).toThrow();
    expect(store.commandsAfter(0).latest).toBe(0);
  });

  test('a retried command with the same client_id is queued once', () => {
    const store = new HostRelayStore();
    expect(store.pushCommand({ type: 'next', client_id: 'abc' })).toBe(1);
    expect(store.pushCommand({ type: 'next', client_id: 'abc' })).toBe(1);
    expect(store.commandsAfter(0).commands).toHaveLength(1);
  });

  test('old commands are dropped', () => {
    const store = new HostRelayStore();
    for (let i = 0; i < 150; i++) store.pushCommand({ type: 'next' });
    const { latest, commands } = store.commandsAfter(0);
    expect(latest).toBe(150);
    expect(commands).toHaveLength(100);
    expect(commands[0].seq).toBe(51);
  });

  test('state reports its age', () => {
    let now = 10000;
    const store = new HostRelayStore(() => now);
    expect(store.getState()).toEqual({ state: null, age: null });
    store.setState({ state: 3 });
    now += 2500;
    expect(store.getState()).toEqual({ state: { state: 3 }, age: 2.5 });
    expect(() => store.setState('nope')).toThrow();
  });
});

describe('contestant answers', () => {
  const answering = (overrides = {}) => ({
    player_code: '0427',
    player: { state: 3, accepting_answer: true, question: { id: 7, text: 'Q7' } },
    ...overrides,
  });

  test('queued as an answer command for the backstage PC', () => {
    const store = new HostRelayStore(() => 5);
    store.setState(answering());
    expect(store.pushPlayerAnswer({ code: '0427', value: 45, question_id: 7 })).toBe(1);
    expect(store.commandsAfter(0).commands).toEqual([
      { seq: 1, type: 'answer', value: 45, source: 'player', code: '0427', question_id: 7, at: 5 },
    ]);
  });

  test('rejected unless the game is ready and accepting', () => {
    const store = new HostRelayStore();
    expect(() => store.pushPlayerAnswer({ code: '0427', value: 45, question_id: 7 })).toThrow('つながっていません');
    store.setState(answering({ player: { state: 2, accepting_answer: false, question: { id: 7 } } }));
    expect(() => store.pushPlayerAnswer({ code: '0427', value: 45, question_id: 7 })).toThrow('受け付けていません');
    store.setState(answering());
    expect(() => store.pushPlayerAnswer({ code: '0427', value: 45, question_id: 6 })).toThrow('問題が変わりました');
    expect(() => store.pushPlayerAnswer({ code: '0427', value: 101, question_id: 7 })).toThrow('0〜100');
    expect(store.commandsAfter(0).commands).toHaveLength(0);
  });

  test('wrong codes are rejected and eventually locked out', () => {
    let now = 0;
    const store = new HostRelayStore(() => now);
    store.setState(answering());
    for (let i = 0; i < 29; i++) {
      expect(() => store.pushPlayerAnswer({ code: String(i).padStart(4, '0'), value: 1, question_id: 7 })).toThrow('合言葉が違います');
    }
    // the 30th failure triggers the lockout; even the right code is refused for a while
    expect(() => store.pushPlayerAnswer({ code: '9999', value: 1, question_id: 7 })).toThrow('合言葉が違います');
    expect(() => store.pushPlayerAnswer({ code: '0427', value: 1, question_id: 7 })).toThrow('しばらく');
    now += 31 * 1000;
    expect(store.pushPlayerAnswer({ code: '0427', value: 1, question_id: 7 })).toBe(1);
  });

  test('failures spread over time do not lock out', () => {
    let now = 0;
    const store = new HostRelayStore(() => now);
    store.setState(answering());
    for (let i = 0; i < 60; i++) {
      now += 3000;
      expect(() => store.pushPlayerAnswer({ code: 'xxxx', value: 1, question_id: 7 })).toThrow('合言葉が違います');
    }
    expect(store.pushPlayerAnswer({ code: '0427', value: 1, question_id: 7 })).toBe(1);
  });

  test('player state exposes only the public part', () => {
    const store = new HostRelayStore(() => 0);
    expect(store.getPlayerState()).toEqual({ state: null, age: null });
    store.setState({ ...answering(), question: { correct: 93 } });
    const { state } = store.getPlayerState();
    expect(state).toEqual(answering().player);
    expect(JSON.stringify(state)).not.toContain('0427');
    expect(JSON.stringify(state)).not.toContain('93');
  });
});

test('tokenMatches', () => {
  expect(tokenMatches('secret', 'secret')).toBe(true);
  expect(tokenMatches('secreT', 'secret')).toBe(false);
  expect(tokenMatches('', 'secret')).toBe(false);
  expect(tokenMatches(undefined, 'secret')).toBe(false);
  expect(tokenMatches('secret', '')).toBe(false);
});

describe('HTTP API', () => {
  /** @type {http.Server} */
  let server;
  let base;
  let api;

  beforeAll((done) => {
    api = createHostApi({ token: 'secret' });
    server = http.createServer((req, res) => {
      if (!api.handle(req, res)) {
        res.statusCode = 418;
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('net').AddressInfo} */ (server.address());
      base = `http://127.0.0.1:${address.port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => done());
  });

  /**
   * @param {string} method
   * @param {string} path
   * @param {{token?: string, body?: unknown}} options
   */
  const call = (method, path, { token = 'secret', body = undefined } = {}) => fetch(base + path, {
    method,
    headers: token ? { 'X-Host-Token': token, 'Content-Type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  test('other paths are left to the static server', async () => {
    expect((await call('GET', '/host.html')).status).toBe(418);
  });

  test('a token is required', async () => {
    expect((await call('GET', '/api/host/state', { token: '' })).status).toBe(401);
    expect((await call('GET', '/api/host/state', { token: 'wrong' })).status).toBe(401);
    expect((await call('POST', '/api/host/command', { token: 'wrong', body: { type: 'next' } })).status).toBe(401);
  });

  test('round trip: phone -> server -> PC -> server -> phone', async () => {
    // phone queues a command
    let res = await call('POST', '/api/host/command', { body: { type: 'next', expect_state: 0 } });
    expect(res.status).toBe(200);
    const { seq } = await res.json();

    // PC picks it up
    res = await call('GET', '/api/host/command?after=0');
    const queued = await res.json();
    expect(queued.latest).toBe(seq);
    expect(queued.commands[0]).toMatchObject({ seq, type: 'next', expect_state: 0 });

    // PC reports the new state
    res = await call('POST', '/api/host/state', { body: { state: 1, last_command: { seq, ok: true } } });
    expect(res.status).toBe(200);

    // phone sees it
    res = await call('GET', '/api/host/state');
    const data = await res.json();
    expect(data.state).toEqual({ state: 1, last_command: { seq, ok: true } });
    expect(data.age).toBeLessThan(5);
  });

  test('bad requests get 400', async () => {
    expect((await call('POST', '/api/host/command', { body: { type: 'answer', value: 500 } })).status).toBe(400);
    const res = await fetch(base + '/api/host/state', {
      method: 'POST',
      headers: { 'X-Host-Token': 'secret' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  test('contestant endpoints need no host token', async () => {
    let res = await call('GET', '/api/player/state', { token: '' });
    expect(res.status).toBe(200);
    res = await call('POST', '/api/player/answer', { token: '', body: { code: 'nope', value: 1, question_id: 1 } });
    expect([403, 503]).toContain(res.status);
    expect((await res.json()).error).toBeTruthy();
  });

  test('audience ranking round trip', async () => {
    let res = await call('POST', '/api/score', {
      token: '', body: { id: 'viewer-abcdefgh', name: 'すずか', error_sum: 12, answered: 1, last_question: 1 },
    });
    expect(res.status).toBe(200);
    res = await call('POST', '/api/score', { token: '', body: { id: 'x', name: 'a', error_sum: 0, answered: 0, last_question: 0 } });
    expect(res.status).toBe(400);
    res = await call('GET', '/api/ranking?id=viewer-abcdefgh', { token: '' });
    const ranking = await res.json();
    expect(ranking.me.rank).toBe(1);
    expect(ranking.top[0].name).toBe('すずか');
    expect(JSON.stringify(ranking)).not.toContain('viewer-abcdefgh'); // ids are not exposed publicly

    // the MC can hide a name and reset the ranking
    expect((await call('GET', '/api/host/ranking', { token: '' })).status).toBe(401);
    res = await call('GET', '/api/host/ranking');
    expect((await res.json()).entries[0]).toEqual({ id: 'viewer-abcdefgh', name: 'すずか', hidden: false });
    await call('POST', '/api/host/ranking/hide', { body: { id: 'viewer-abcdefgh', hidden: true } });
    res = await call('GET', '/api/ranking', { token: '' });
    expect((await res.json()).top).toEqual([]);
    await call('POST', '/api/host/ranking/reset', { body: {} });
    res = await call('GET', '/api/ranking', { token: '' });
    expect((await res.json()).participants).toBe(0);
  });

  test('unknown API paths get 404', async () => {
    expect((await call('GET', '/api/host/nothing')).status).toBe(404);
  });

  test('disabled without a token configured', async () => {
    const disabled = createHostApi({ token: '' });
    const res = { statusCode: 0, headers: {}, setHeader() {}, end: jest.fn() };
    // @ts-ignore
    expect(disabled.handle({ url: '/api/host/state', headers: {} }, res)).toBe(true);
    expect(res.statusCode).toBe(503);
  });
});
