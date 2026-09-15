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

function streamRoom() {
  return {...room(), engine: 'melee', mode: 'host-stream', players: [
    {seat: 0, connected: true, generation: 1}, {seat: 1, connected: true, generation: 2},
  ]};
}

test('stream start never submits lockstep input and supports joining a running room', async t => {
  const f = await fixture(t);
  f.session.room = streamRoom();
  await f.emit({type: 'start', epoch: 1, seed: 42});
  assert.equal(f.session.started, true);
  assert.equal(f.outbound.some(message => message.type === 'input'), false);
  await assert.rejects(f.session.nextFrame(0, [0, 0, 0, 0, 0, 0, 0]), /does not use lockstep/);
  f.session.started = false;
  await f.emit({type: 'room', room: {...streamRoom(), state: 'running', epoch: 1}});
  assert.equal(f.session.started, true);
});

test('stream signaling binds to connected seat generations and buffers early offers', async t => {
  const f = await fixture(t);
  f.session.room = streamRoom();
  const signal = {id: 'c'.repeat(32), description: {type: 'answer', sdp: 'v=0'}};
  const incoming = {type: 'signal', from: 1, generation: 2, toGeneration: 1, signal};
  await f.emit(incoming);
  const received = [];
  const off = f.session.subscribeSignals(message => received.push(message));
  assert.deepEqual(received, [incoming]);
  await f.emit({...incoming, generation: 1});
  assert.equal(received.length, 1);
  await f.session.signal(1, {id: signal.id, candidate: null});
  assert.deepEqual(f.outbound.at(-1), {type: 'signal', to: 1, generation: 2, signal: {id: signal.id, candidate: null}});
  off();
  await f.emit(incoming);
  f.session.room.players[1].generation = 3;
  f.session.subscribeSignals(message => received.push(message));
  assert.equal(received.length, 1, 'old buffered answer cannot enter replacement connection');
});

test('guests cannot signal each other and stream rooms reject lockstep frames', async t => {
  const f = await fixture(t);
  f.session.room = streamRoom(); f.session.seat = 1;
  await assert.rejects(f.session.signal(1, {}), /no longer connected/);
  await f.emit({type: 'frame', epoch: 1, tick: 0, pads: []});
  assert.match(f.session.error, /Unexpected lockstep/);
});

test('host stream creation explicitly selects its mode without changing default creation', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    if (url === '/api/netplay/config') return ok({enabled: true, relayUrl: 'https://relay.example'});
    sent = JSON.parse(init.body);
    return ok({room: streamRoom(), seat: 0, token});
  };
  await createGame('melee', {seed: 42}, {mode: 'host-stream', fetchImpl, storage: storage()});
  assert.equal(sent.mode, 'host-stream');
  await assert.rejects(createGame('ssb64', {}, {mode: 'host-stream', fetchImpl, storage: storage()}), /Invalid game mode/);
});

test('expected stale signaling races preserve the host while control failures remain fatal', async t => {
  const f = await fixture(t); f.session.room = streamRoom();
  for (const code of ['not_connected', 'stale_generation', 'stale_negotiation']) {
    await f.emit({type:'error', request:'signal', code, message:'Old peer'});
    assert.equal(f.session.closed,false);
  }
  await f.emit({type:'error', code:'not_connected', message:'Control failure'});
  assert.equal(f.session.closed,true);
  assert.equal(f.session.error,'Control failure');
});
