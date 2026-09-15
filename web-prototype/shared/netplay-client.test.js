import test from 'node:test';
import assert from 'node:assert/strict';
import {NetplaySession, INPUT_DELAY, gameLink, gameIdFromLocation, validPad, createGame, joinGame, relayOrigin} from './netplay-client.js';

const id = 'b'.repeat(32), token = 'host-secret-capability-1234567890';
const room = () => ({id, engine: 'ssb64', config: {seed: 42}, state: 'preparing', players: [{seat: 0, connected: true, ready: false}]});
const storage = () => { const values = new Map(); return {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)}; };
const ok = value => ({ok: true, json: async () => value});
async function fixture(t) {
  const toServer = new TransformStream(), toClient = new TransformStream();
  const outbound = [], serverReader = toServer.readable.getReader(), serverWriter = toClient.writable.getWriter();
  let openedUrl;
  const session = new NetplaySession({room: room(), seat: 0, token, relayUrl: 'https://relay.example'}, {
    frameTimeout: 50, transportFactory(url) {
      openedUrl = url;
      return {ready: Promise.resolve(), closed: new Promise(() => {}),
        createBidirectionalStream: async () => ({readable: toClient.readable, writable: toServer.writable}), close() {}};
    },
  });
  const drain = (async () => { const decoder = new TextDecoder(); while (true) { const {value, done} = await serverReader.read(); if (done) return; outbound.push(JSON.parse(decoder.decode(value))); } })();
  t.after(() => { session.close(); serverReader.cancel(); serverWriter.abort().catch(() => {}); return drain; });
  await session.connect();
  return {session, outbound, openedUrl, async emit(message) {
    await serverWriter.write(new TextEncoder().encode(JSON.stringify(message) + '\n'));
    await new Promise(resolve => setImmediate(resolve));
  }, serverWriter};
}

test('invitation links contain only a unique room id, never a player credential', () => {
  assert.equal(gameLink('https://game.example', 'melee', id), `https://game.example/melee?game=${id}`);
  assert.equal(gameIdFromLocation({search: `?game=${id}`}), id);
  assert.equal(gameIdFromLocation({search: ''}), null);
  assert.throws(() => gameIdFromLocation({search: '?game=../../../secrets'}), /invalid/);
  assert.throws(() => gameLink('https://game.example', 'unknown', id));
  assert.throws(() => relayOrigin('https://user:secret@relay.example'));
  assert.throws(() => relayOrigin('http://relay.example'));
});

test('create saves the host capability locally and a returning host keeps its seat', async () => {
  const local = storage(), calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({url, init});
    if (url === '/api/netplay/config') return ok({enabled: true, relayUrl: 'https://relay.example'});
    if (url.endsWith('/v1/rooms')) return ok({room: room(), seat: 0, token});
    if (url.endsWith(id)) return ok(room());
    throw Error('A host must not reserve a second seat.');
  };
  await createGame('ssb64', {seed: 42}, {fetchImpl, storage: local});
  const access = await joinGame(id, {fetchImpl, storage: local});
  assert.equal(access.seat, 0); assert.equal(access.token, token);
  assert.equal(calls.filter(call => call.init?.method === 'POST').length, 1);
});

test('an unconfigured relay rejects creation without inventing a playable local link', async () => {
  await assert.rejects(createGame('ssb64', {seed: 1}, {storage: storage(), fetchImpl: async () => ok({enabled: false})}), /not configured/);
});

test('transport authenticates its own seat and opens the stream with hello', async t => {
  const f = await fixture(t);
  assert.equal(new URL(f.openedUrl).searchParams.get('token'), token);
  assert.deepEqual(f.outbound[0], {type: 'hello'});
  await f.session.prepare(); await f.session.ready('matching-build'); await f.session.start();
  assert.deepEqual(f.outbound.slice(1).map(message => message.type), ['prepare', 'ready', 'start']);
});

test('a game waits for start and confirmed inputs, while sampling three frames ahead', async t => {
  const f = await fixture(t);
  const localPad = [0x100, -80, 50, 0, 0, 0, 255];
  let resolved = false;
  const first = f.session.nextFrame(0, localPad).then(pads => { resolved = true; return pads; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(f.outbound.filter(message => message.type === 'input').length, 0);
  await f.emit({type: 'start', epoch: 1, seed: 42, players: [0]});
  const inputs = f.outbound.filter(message => message.type === 'input');
  assert.deepEqual(inputs.map(message => message.tick), [0, 1, 2, INPUT_DELAY]);
  assert.deepEqual(inputs.at(-1).pad, localPad);
  assert.equal(resolved, false);
  const pads = [[0, 0, 0, 0, 0, 0, 0], [1, 50, -80, 0, 0, 0, 0], [2, 0, 0, 0, 0, 0, 0], [3, 0, 0, 0, 0, 0, 0]];
  await f.emit({type: 'frame', epoch: 1, tick: 0, pads});
  assert.deepEqual(await first, pads);
});

test('confirmed frames arriving before the engine requests them are preserved', async t => {
  const f = await fixture(t);
  await f.emit({type: 'start', epoch: 2, seed: 42});
  const pads = Array.from({length: 4}, (_, i) => [i, 0, 0, 0, 0, 0, 0]);
  await f.emit({type: 'frame', epoch: 2, tick: 0, pads});
  assert.deepEqual(await f.session.nextFrame(0, [0, 0, 0, 0, 0, 0, 0]), pads);
});

test('epoch, sequence and controller validation stop the game rather than applying bad frames', async t => {
  const f = await fixture(t);
  await f.emit({type: 'start', epoch: 1, seed: 42});
  const waiting = f.session.nextFrame(0, [0, 0, 0, 0, 0, 0, 0]);
  const rejected = assert.rejects(waiting, /Invalid confirmed/);
  await f.emit({type: 'frame', epoch: 99, tick: 0, pads: Array(4).fill([0, 0, 0, 0, 0, 0, 0])});
  await rejected; assert.equal(f.session.closed, true);
  assert.equal(validPad([0, 128, 0, 0, 0, 0, 0]), false);
  assert.equal(validPad([0, 0, 0, 0, 0, 0, -1]), false);
  assert.equal(validPad([NaN, 0, 0, 0, 0, 0, 0]), false);
});

test('peer departure rejects a pending frame and releases all buffers', async t => {
  const f = await fixture(t);
  const pending = f.session.nextFrame(0, [0, 0, 0, 0, 0, 0, 0]);
  const rejected = assert.rejects(pending, /Player 2 disconnected/);
  await f.emit({type: 'ended', reason: 'Player 2 disconnected'});
  await rejected;
  assert.equal(f.session.waiters.size, 0); assert.equal(f.session.pendingInputs.size, 0);
});

test('partial and coalesced stream chunks decode as distinct control messages', async t => {
  const f = await fixture(t);
  const payload = JSON.stringify({type: 'room', room: {...room(), players: [{seat: 0, connected: true, ready: true}]}}) + '\n';
  const encoded = new TextEncoder().encode(payload);
  await f.serverWriter.write(encoded.slice(0, 9));
  assert.equal(f.session.room.players[0].ready, false);
  await f.serverWriter.write(encoded.slice(9));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.session.room.players[0].ready, true);
});

test('a stalled live frame times out without continuing with neutral predictions', async t => {
  const f = await fixture(t);
  await f.emit({type: 'start', epoch: 1, seed: 42});
  await assert.rejects(f.session.nextFrame(0, [0, 0, 0, 0, 0, 0, 0]), /stopped sending inputs/);
  assert.equal(f.session.closed, true);
});
