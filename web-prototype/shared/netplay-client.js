// WebTransport carries lockstep controller frames or host-stream room signaling.
// The relay never receives game files or runs a game engine.
export const NETPLAY_PROTOCOL = 1;
export const INPUT_DELAY = 3;
export const ROOM_ID = /^[a-f0-9]{32}$/;
export const NEUTRAL_PAD = Object.freeze([0, 0, 0, 0, 0, 0, 0]);
const MAX_LINE = 128 * 1024;
const MAX_FRAMES = 32;

export function validPad(pad) {
  return Array.isArray(pad) && pad.length === 7 && pad.every(Number.isInteger)
    && pad[0] >= 0 && pad[0] <= 65535
    && pad.slice(1, 5).every(value => value >= -128 && value <= 127)
    && pad.slice(5).every(value => value >= 0 && value <= 255);
}

export function gameIdFromLocation(location) {
  const id = new URLSearchParams(location.search).get('game');
  if (id === null) return null;
  if (!ROOM_ID.test(id)) throw Error('This game link is invalid.');
  return id;
}

export function gameLink(origin, engine, id) {
  if (!ROOM_ID.test(id) || !['ssb64', 'melee'].includes(engine)) throw Error('Invalid game.');
  return new URL(`${engine === 'melee' ? '/melee' : '/'}?game=${id}`, origin).href;
}

export function relayOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('The game relay must use an HTTPS origin.');
  }
  return url.origin;
}

export async function readJson(response) {
  const body = await response.json();
  if (!response.ok) throw Error(body.error || body.message || `Game service returned ${response.status}.`);
  return body;
}

export async function loadNetplayConfig(fetchImpl = fetch) {
  const config = await readJson(await fetchImpl('/api/netplay/config', {cache: 'no-store'}));
  if (!config.enabled) throw Error('Online games are not configured on this server yet.');
  return {...config, relayUrl: relayOrigin(config.relayUrl)};
}

function accessKey(id) { return `opensmash-game-v1:${id}`; }
export function forgetAccess(id, storage = sessionStorage) { storage.removeItem(accessKey(id)); }
export function rememberAccess(access, storage = sessionStorage) {
  if (!ROOM_ID.test(access.room?.id) || !Number.isInteger(access.seat) || access.seat < 0 || access.seat > 3
      || typeof access.token !== 'string' || access.token.length < 20) throw Error('Invalid game credentials.');
  storage.setItem(accessKey(access.room.id), JSON.stringify({seat: access.seat, token: access.token}));
  return access;
}

export async function createGame(engine, config, {fetchImpl = fetch, storage = sessionStorage, mode} = {}) {
  if (mode !== undefined && (mode !== 'lockstep' && mode !== 'host-stream' || mode === 'host-stream' && engine !== 'melee')) throw Error('Invalid game mode.');
  const {relayUrl} = await loadNetplayConfig(fetchImpl);
  const access = await readJson(await fetchImpl(`${relayUrl}/v1/rooms`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({engine, config, ...(mode ? {mode} : {})}), credentials: 'omit',
  }));
  rememberAccess(access, storage);
  return {...access, relayUrl};
}

export async function joinGame(id, {fetchImpl = fetch, storage = sessionStorage, signal} = {}) {
  if (!ROOM_ID.test(id)) throw Error('This game link is invalid.');
  const {relayUrl} = await loadNetplayConfig(fetchImpl);
  const room = await readJson(await fetchImpl(`${relayUrl}/v1/rooms/${id}`, {signal, cache: 'no-store', credentials: 'omit'}));
  // REST returns the public room directly. A reconnect never silently takes a
  // second seat; the transport either accepts the original token or fails.
  let saved;
  try { saved = JSON.parse(storage.getItem(accessKey(id)) || 'null'); } catch { /* inaccessible storage */ }
  if (saved && room.players.some(player => player.seat === saved.seat)) return {room, ...saved, relayUrl};
  const access = await readJson(await fetchImpl(`${relayUrl}/v1/rooms/${id}/join`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}', credentials: 'omit', signal,
  }));
  rememberAccess(access, storage);
  return {...access, relayUrl};
}

/** One connection, one game epoch, one owned seat. Never falls back to local play. */
export class NetplaySession {
  constructor(access, {transportFactory = url => new WebTransport(url), frameTimeout = 30000, heartbeat = 15000, connectTimeout = 15000} = {}) {
    this.room = access.room;
    this.seat = access.seat;
    this.relayUrl = relayOrigin(access.relayUrl);
    this.token = access.token;
    this.transportFactory = transportFactory;
    this.frameTimeout = frameTimeout;
    this.heartbeat = heartbeat;
    this.connectTimeout = connectTimeout;
    this.listeners = new Set();
    this.signalListeners = new Set();
    this.pendingSignals = [];
    this.pendingSignalBytes = 0;
    this.waiters = new Map();
    this.frames = new Map();
    this.pendingInputs = new Map();
    this.lastRequested = -1;
    this.lastReceived = -1;
    this.connected = false;
    this.started = false;
    this.error = '';
    this.closed = false;
    this.writes = Promise.resolve();
  }
  getSnapshot() { return {room: this.room, seat: this.seat, connected: this.connected, started: this.started, error: this.error}; }
  subscribe(listener) { this.listeners.add(listener); listener(this.getSnapshot()); return () => this.listeners.delete(listener); }
  notify() { for (const listener of this.listeners) listener(this.getSnapshot()); }
  subscribeSignals(listener) {
    this.signalListeners.add(listener);
    const pending = this.pendingSignals;
    this.pendingSignals = []; this.pendingSignalBytes = 0;
    for (const message of pending) {
      if (this.currentSignal(message)) listener(message);
    }
    return () => this.signalListeners.delete(listener);
  }
  currentSignal(message) {
    const sender = this.room.players.find(player => player.seat === message.from);
    const self = this.room.players.find(player => player.seat === this.seat);
    return sender?.connected && self?.connected && sender.generation === message.generation && self.generation === message.toGeneration;
  }
  signal(to, signal) {
    const recipient = this.room.players.find(player => player.seat === to);
    if (this.room.mode !== 'host-stream' || !recipient?.connected || to === this.seat
        || (this.seat !== 0 && to !== 0) || !Number.isSafeInteger(recipient.generation) || recipient.generation < 1) {
      return Promise.reject(Error('The other player is no longer connected.'));
    }
    return this.send({type: 'signal', to, generation: recipient.generation, signal});
  }
  async connect() {
    try {
      if (this.closed) throw Error('The game has closed.');
      const url = new URL('/v1/connect', this.relayUrl);
      url.searchParams.set('room', this.room.id);
      url.searchParams.set('token', this.token);
      this.transport = this.transportFactory(url.href);
      this.transport.closed.then(() => { if (!this.closed) this.fail(Error('Connection to the game closed.')); }, error => this.fail(error));
      await Promise.race([this.transport.ready, new Promise((_, reject) => {
        this.connectTimer = setTimeout(() => reject(Error('Could not connect to the game relay. Check that UDP traffic is allowed.')), this.connectTimeout);
      })]);
      clearTimeout(this.connectTimer);
      if (this.closed) return;
      const stream = await this.transport.createBidirectionalStream();
      this.writer = stream.writable.getWriter();
      this.reader = stream.readable.getReader();
      this.connected = true;
      await this.send({type: 'hello'});
      this.timer = setInterval(() => { this.send({type: 'hello'}).catch(error => this.fail(error)); }, this.heartbeat);
      this.notify();
      this.readLoop().catch(error => this.fail(error));
    } catch (error) { this.fail(error); throw error; }
  }
  send(message) {
    if (this.closed || !this.writer) return Promise.reject(Error('The game connection is unavailable.'));
    const bytes = new TextEncoder().encode(JSON.stringify(message) + '\n');
    if (bytes.byteLength > MAX_LINE) return Promise.reject(Error('Game message is too large.'));
    this.writes = this.writes.then(() => this.writer.write(bytes));
    return this.writes;
  }
  prepare() { return this.send({type: 'prepare'}); }
  ready(fingerprint) { return this.send({type: 'ready', fingerprint}); }
  start() { return this.send({type: 'start'}); }
  async readLoop() {
    let buffered = '';
    const decoder = new TextDecoder('utf-8', {fatal: true});
    while (!this.closed) {
      const {done, value} = await this.reader.read();
      if (done) { if (!this.closed) throw Error('The game connection ended.'); return; }
      buffered += decoder.decode(value, {stream: true});
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        if (end > MAX_LINE) throw Error('The game server sent an oversized message.');
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        if (line) this.receive(JSON.parse(line));
      }
      if (buffered.length > MAX_LINE) throw Error('The game server sent an oversized message.');
    }
  }
  receive(message) {
    if (this.closed) return;
    if (message.type === 'room') {
      if (message.room?.id !== this.room.id || !Array.isArray(message.room.players)) throw Error('Invalid game room update.');
      if ((message.room.mode || 'lockstep') !== (this.room.mode || 'lockstep')) throw Error('The game changed modes.');
      this.room = message.room;
      if (this.room.mode === 'host-stream' && this.room.state === 'running') { this.started = true; this.epoch = this.room.epoch; }
      this.notify();
    } else if (message.type === 'prepare') {
      // The following room snapshot supplies the frozen roster. No simulation
      // starts from this notification alone.
    } else if (message.type === 'start') {
      if ((this.started && this.room.mode !== 'host-stream') || !Number.isInteger(message.epoch) || message.epoch < 1 || message.seed !== this.room.config.seed) throw Error('Invalid game start.');
      this.started = true; this.epoch = message.epoch;
      if (this.room.mode === 'host-stream') { this.notify(); return; }
      for (let tick = 0; tick < INPUT_DELAY; tick++) this.submit(tick, NEUTRAL_PAD);
      for (const [tick, pad] of this.pendingInputs) this.submit(tick, pad);
      this.pendingInputs.clear();
      this.notify();
    } else if (message.type === 'signal') {
      if (this.room.mode !== 'host-stream' || !Number.isInteger(message.from) || message.from < 0 || message.from > 3
          || message.from === this.seat || (this.seat !== 0 && message.from !== 0)
          || !Number.isSafeInteger(message.generation) || message.generation < 1
          || !Number.isSafeInteger(message.toGeneration) || message.toGeneration < 1
          || !message.signal || typeof message.signal !== 'object') throw Error('Invalid game signaling.');
      if (!this.currentSignal(message)) return;
      if (this.signalListeners.size) for (const listener of this.signalListeners) listener(message);
      else {
        const bytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
        if (this.pendingSignals.length >= 32 || this.pendingSignalBytes + bytes > MAX_LINE) throw Error('Too much pending game signaling.');
        this.pendingSignals.push(message); this.pendingSignalBytes += bytes;
      }
    } else if (message.type === 'frame') {
      if (this.room.mode === 'host-stream') throw Error('Unexpected lockstep frame.');
      if (!this.started || message.epoch !== this.epoch || message.tick !== this.lastReceived + 1
          || !Array.isArray(message.pads) || message.pads.length !== 4 || !message.pads.every(validPad)) throw Error('Invalid confirmed input frame.');
      this.lastReceived = message.tick;
      const waiting = this.waiters.get(message.tick);
      if (waiting) { clearTimeout(waiting.timer); this.waiters.delete(message.tick); waiting.resolve(message.pads); }
      else {
        if (this.frames.size >= MAX_FRAMES) throw Error('The game received too many future frames.');
        this.frames.set(message.tick, message.pads);
      }
    } else if (message.type === 'ended' || message.type === 'error') {
      // In-flight ICE can arrive after a guest leaves or a host reoffers. The
      // authoritative room update already retires that peer; keep other games
      // connected. Control errors and malformed/unauthorized signals stay fatal.
      if (message.type === 'error' && message.request === 'signal' && this.room.mode === 'host-stream'
          && ['not_connected', 'stale_generation', 'stale_negotiation'].includes(message.code)) return;
      this.fail(Error(message.reason || message.message || 'This game has ended.'));
    } else throw Error('Unknown game protocol message.');
  }
  submit(tick, pad) {
    this.send({type: 'input', epoch: this.epoch, tick, pad}).catch(error => this.fail(error));
  }
  nextFrame(tick, localPad) {
    if (this.room.mode === 'host-stream') return Promise.reject(Error('Host streaming does not use lockstep input frames.'));
    if (this.closed) return Promise.reject(Error(this.error || 'This game has ended.'));
    if (!Number.isInteger(tick) || tick !== this.lastRequested + 1 || !validPad(localPad)) {
      const error = Error('The game engine requested an invalid input frame.'); this.fail(error); return Promise.reject(error);
    }
    this.lastRequested = tick;
    const future = tick + INPUT_DELAY;
    if (this.started) this.submit(future, [...localPad]);
    else this.pendingInputs.set(future, [...localPad]);
    if (this.frames.has(tick)) { const pads = this.frames.get(tick); this.frames.delete(tick); return Promise.resolve(pads); }
    if (this.waiters.size >= MAX_FRAMES) { const error = Error('The game engine ran too far ahead.'); this.fail(error); return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      // Preparation can take minutes. A timeout only begins once a match is
      // running; the transport heartbeat protects the lobby connection.
      const timer = setInterval(() => {
        if (!this.started) return;
        const waiting = this.waiters.get(tick);
        if (!waiting) return;
        waiting.startedAt ??= Date.now();
        if (Date.now() - waiting.startedAt >= this.frameTimeout) this.fail(Error('A player stopped sending inputs. Start a new game to reconnect.'));
      }, Math.min(1000, this.frameTimeout));
      this.waiters.set(tick, {resolve, reject, timer});
    });
  }
  fail(error) {
    if (this.closed) return;
    this.error = error?.message || String(error);
    this.close(this.error);
  }
  close(reason = 'Left the game.') {
    if (this.closed) return;
    this.closed = true; this.connected = false;
    clearInterval(this.timer);
    clearTimeout(this.connectTimer);
    for (const waiter of this.waiters.values()) { clearInterval(waiter.timer); waiter.reject(Error(reason)); }
    this.waiters.clear(); this.frames.clear(); this.pendingInputs.clear();
    this.signalListeners.clear(); this.pendingSignals = []; this.pendingSignalBytes = 0;
    this.reader?.cancel().catch(() => {});
    this.transport?.close({closeCode: 0, reason: 'Game closed'});
    this.notify();
  }
}
