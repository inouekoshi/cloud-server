// Host (MC) screen relay for the "Suzuleague" stage event.
//
// The MC operates the game from their phone, but the phone cannot reach the
// backstage PC that runs the game engine (the venue Wi-Fi gives no such
// guarantee). This server acts as a mailbox between them:
//
//   MC's phone --POST /api/host/command--> here <--GET /api/host/command-- backstage PC
//              <--GET  /api/host/state----      <--POST /api/host/state---
//
// Every endpoint requires the shared secret in the X-Host-Token header, so a
// leaked URL alone cannot take over the game. Unlike cloud variables, the token
// is never broadcast to other clients. If HOST_TOKEN is not set, the API is
// disabled entirely.
//
// Everything is kept in memory: the event lasts 40 minutes, and the backstage
// PC re-sends the full state every few seconds.

const crypto = require('crypto');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMMANDS = 100;
const COMMAND_TYPES = ['next', 'answer'];

class HostRelayStore {
  /**
   * @param {() => number} now Current time in milliseconds.
   */
  constructor(now = Date.now) {
    this.now = now;
    this.seq = 0;
    /** @type {object[]} */
    this.commands = [];
    /** @type {Map<string, number>} client_id -> seq, so that a retried request is not queued twice */
    this.clientIds = new Map();
    this.state = null;
    this.stateReceivedAt = 0;
  }

  /**
   * Validate and queue a command from the MC's phone.
   * @param {unknown} body
   * @returns {number} The sequence number of the command.
   */
  pushCommand(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('invalid command');
    }
    const { type, value, expect_state: expectState, client_id: clientId } = /** @type {any} */ (body);
    if (!COMMAND_TYPES.includes(type)) {
      throw new Error('invalid command type');
    }
    if (type === 'answer' && !(Number.isInteger(value) && value >= 0 && value <= 100)) {
      throw new Error('answer must be an integer between 0 and 100');
    }
    if (expectState !== undefined && expectState !== null && !Number.isInteger(expectState)) {
      throw new Error('invalid expect_state');
    }
    if (clientId !== undefined && typeof clientId !== 'string') {
      throw new Error('invalid client_id');
    }
    if (clientId && this.clientIds.has(clientId)) {
      return /** @type {number} */ (this.clientIds.get(clientId));
    }

    this.seq += 1;
    const command = { seq: this.seq, type, at: this.now() };
    if (type === 'answer') command.value = value;
    if (Number.isInteger(expectState)) command.expect_state = expectState;
    this.commands.push(command);
    if (this.commands.length > MAX_COMMANDS) {
      this.commands.shift();
    }
    if (clientId) {
      this.clientIds.set(clientId, this.seq);
      if (this.clientIds.size > MAX_COMMANDS) {
        this.clientIds.delete(this.clientIds.keys().next().value);
      }
    }
    return this.seq;
  }

  /**
   * @param {number} after
   */
  commandsAfter(after) {
    return {
      latest: this.seq,
      commands: this.commands.filter((c) => c.seq > after),
    };
  }

  /**
   * @param {unknown} state
   */
  setState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('invalid state');
    }
    this.state = state;
    this.stateReceivedAt = this.now();
  }

  getState() {
    return {
      state: this.state,
      // seconds since the backstage PC last reported in
      age: this.state ? (this.now() - this.stateReceivedAt) / 1000 : null,
    };
  }
}

/**
 * Compare secrets in constant time.
 * @param {unknown} given
 * @param {string} expected
 */
function tokenMatches(given, expected) {
  if (typeof given !== 'string' || !expected) {
    return false;
  }
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(data);
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<unknown>}
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {{token: string | undefined, store?: HostRelayStore}} options
 */
function createHostApi({ token, store = new HostRelayStore() }) {
  /**
   * Handle a request if it belongs to this API.
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   * @returns {boolean} true if the request was handled here.
   */
  function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/host/')) {
      return false;
    }
    if (!token) {
      sendJson(res, 503, { error: 'host API is disabled (HOST_TOKEN is not set)' });
      return true;
    }
    if (!tokenMatches(req.headers['x-host-token'], token)) {
      sendJson(res, 401, { error: 'invalid token' });
      return true;
    }

    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/host/state') {
      sendJson(res, 200, store.getState());
    } else if (route === 'GET /api/host/command') {
      const after = Number(url.searchParams.get('after') || 0);
      sendJson(res, 200, store.commandsAfter(Number.isFinite(after) ? after : 0));
    } else if (route === 'POST /api/host/command' || route === 'POST /api/host/state') {
      readJson(req)
        .then((body) => {
          if (route === 'POST /api/host/command') {
            sendJson(res, 200, { seq: store.pushCommand(body) });
          } else {
            store.setState(body);
            sendJson(res, 200, { ok: true });
          }
        })
        .catch((e) => sendJson(res, 400, { error: String(e && e.message || e) }));
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
    return true;
  }

  return { handle, store };
}

module.exports = {
  createHostApi,
  HostRelayStore,
  tokenMatches,
};
