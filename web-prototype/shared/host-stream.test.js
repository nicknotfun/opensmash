import test from 'node:test';
import assert from 'node:assert/strict';
import {HostStream, HOST_STREAM_PROTOCOL} from './host-stream.js';

const neutral = [0, 0, 0, 0, 0, 0, 0];
const pressed = [0x100, 100, -100, 0, 0, 255, 0];
const id = n => n.toString(16).padStart(32, '0');
class Track {
  constructor(kind, id = kind) { this.kind = kind; this.id = id; this.readyState = 'live'; }
  stop() { this.readyState = 'ended'; }
}
class Stream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  addTrack(track) { this.tracks.push(track); }
}
class Channel {
  constructor() {
    Object.assign(this, {label: HOST_STREAM_PROTOCOL, protocol: HOST_STREAM_PROTOCOL, ordered: false,
      maxRetransmits: 0, readyState: 'connecting', bufferedAmount: 0, sent: []});
  }
  send(data) { this.sent.push(data); }
  open() { this.readyState = 'open'; this.onopen?.(); }
  close() { this.readyState = 'closed'; this.onclose?.(); }
  receive(packet) { this.onmessage?.({data: typeof packet === 'string' ? packet : JSON.stringify(packet)}); }
}
class Peer {
  constructor(config) { Object.assign(this, {config, tracks: [], candidates: [], connectionState: 'new'}); }
  addTrack(track) { this.tracks.push(track); }
  createDataChannel() { return this.channel = new Channel(); }
  async createOffer() { return {type: 'offer', sdp: 'test offer'}; }
  async createAnswer() { return {type: 'answer', sdp: 'test answer'}; }
  async setLocalDescription(value) {
    this.localDescription = value;
    this.onicecandidate?.({candidate: {toJSON: () => ({candidate: 'candidate:fixture', sdpMid: '0'})}});
    this.onicecandidate?.({candidate: null});
  }
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async addIceCandidate(value) { this.candidates.push(value); }
  close() { this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
}
function fixture(t, {seat = 0, ...options} = {}) {
  const peers = [], signals = [], pads = [], states = [], errors = [], streams = [];
  let clock = 0, serial = 0;
  const source = new Stream([new Track('video'), new Track('audio')]);
  const client = new HostStream({seat, ...(seat === 0 ? {stream: source} : {}),
    sendSignal: async (to, signal) => signals.push({to, signal}),
    peerFactory: config => { const peer = new Peer(config); peers.push(peer); return peer; },
    mediaStreamFactory: () => new Stream(), createNonce: () => id(++serial), now: () => clock,
    onPad: (seat, pad) => pads.push({seat, pad}), onState: state => states.push(state),
    onError: (error, seat) => errors.push({error, seat}), onStream: stream => streams.push(stream), ...options});
  t.after(() => client.close());
  return {client, peers, signals, pads, states, errors, streams, source, advance: ms => { clock += ms; client.sweepInputs(); }};
}
async function guestFixture(t) {
  const f = fixture(t, {seat: 2});
  await f.client.receiveSignal({from: 0, signal: {id: id(1), description: {type: 'offer', sdp: 'test offer'}}});
  const channel = new Channel(); f.peers[0].ondatachannel({channel}); channel.open();
  return {...f, channel};
}

test('role and seat are fixed and the host supplies a live video stream', async t => {
  assert.throws(() => new HostStream({seat: 0, sendSignal() {}}), /live game video/);
  assert.throws(() => new HostStream({seat: 4, sendSignal() {}}), /room seat/);
  assert.throws(() => new HostStream({seat: 1, sendSignal() {}, stream: new Stream()}), /Only the host/);
  const host = fixture(t), guest = fixture(t, {seat: 1});
  await assert.rejects(guest.client.connectGuest(2), /Only the host/);
  await assert.rejects(host.client.connectGuest(0), /Invalid guest seat/);
  assert.throws(() => host.client.sendPad(neutral), /local controller/);
  await assert.rejects(guest.client.receiveSignal({from: 2, signal: {id: id(1), candidate: null}}), /Invalid/);
  await assert.rejects(host.client.receiveSignal({from: 1, signal: {id: id(1), description: {type: 'offer', sdp: 'x'}}}), /role/);
});

test('host sends the offer before ICE, with borrowed video/audio and an unordered input channel', async t => {
  const f = fixture(t);
  await f.client.connectGuest(1);
  assert.deepEqual(f.peers[0].tracks, f.source.getTracks());
  assert.deepEqual(f.signals.map(({signal}) => signal.description?.type || 'ice'), ['offer', 'ice', 'ice']);
  assert.ok(f.signals.every(({to, signal}) => to === 1 && signal.id === id(1)));
  assert.equal(f.peers[0].channel.ordered, false);
  assert.equal(f.peers[0].channel.maxRetransmits, 0);
});

test('guest answers the host nonce and combines received media tracks', async t => {
  const f = await guestFixture(t);
  assert.deepEqual(f.signals.map(({signal}) => signal.description?.type || 'ice'), ['answer', 'ice', 'ice']);
  assert.ok(f.signals.every(({to, signal}) => to === 0 && signal.id === id(1)));
  const video = new Track('video'), audio = new Track('audio');
  f.peers[0].ontrack({track: video}); f.peers[0].ontrack({track: audio});
  assert.deepEqual(f.streams.at(-1).getTracks(), [video, audio]);
  assert.equal(f.states.at(-1).state, 'connected');
});

test('replacement connections ignore stale answers and candidates', async t => {
  const f = fixture(t);
  await f.client.connectGuest(1); await f.client.connectGuest(1);
  assert.equal(f.peers[0].connectionState, 'closed');
  assert.equal(await f.client.receiveSignal({from: 1, signal: {id: id(1), description: {type: 'answer', sdp: 'old'}}}), false);
  assert.equal(await f.client.receiveSignal({from: 1, signal: {id: id(1), candidate: {candidate: 'old'}}}), false);
  assert.equal(f.peers[1].remoteDescription, undefined);
  await f.client.receiveSignal({from: 1, signal: {id: id(2), candidate: {candidate: 'new'}}});
  await f.client.receiveSignal({from: 1, signal: {id: id(2), description: {type: 'answer', sdp: 'new'}}});
  assert.equal(f.peers[1].remoteDescription.sdp, 'new');
  assert.deepEqual(f.peers[1].candidates, [{candidate: 'new'}]);
});

test('a previously seen offer cannot replace a newer guest connection', async t => {
  const f = fixture(t, {seat: 1});
  const offer = n => ({from: 0, signal: {id: id(n), description: {type: 'offer', sdp: 'offer ' + n}}});
  await f.client.receiveSignal(offer(1)); await f.client.receiveSignal(offer(2));
  assert.equal(await f.client.receiveSignal(offer(1)), false);
  assert.equal(f.peers.length, 2);
  assert.equal(f.client.peers.get(0).id, id(2));
});

test('ordered complete input states belong to their channel seat, and stale replays cannot hold buttons', async t => {
  const f = fixture(t);
  await f.client.connectGuest(3); const channel = f.peers[0].channel; channel.open();
  channel.receive({v: 1, seq: 10, pad: pressed});
  f.advance(200);
  channel.receive({v: 1, seq: 9, pad: neutral});
  channel.receive({v: 1, seq: 10, pad: pressed});
  assert.deepEqual(f.pads, [{seat: 3, pad: pressed}]);
  f.advance(101);
  assert.deepEqual(f.pads.at(-1), {seat: 3, pad: neutral});
  f.advance(1000); assert.equal(f.pads.length, 2);
  channel.receive({v: 1, seq: 11, pad: pressed});
  assert.deepEqual(f.pads.at(-1), {seat: 3, pad: pressed});
});

test('bad pad ranges, extra seat fields, binary and oversized packets close and neutralize only the offender', async t => {
  const invalid = [
    {v: 1, seq: 1, pad: [0, 128, 0, 0, 0, 0, 0]},
    {v: 1, seq: -1, pad: neutral}, {v: 1, seq: 1, pad: neutral, seat: 2},
    {v: 2, seq: 1, pad: neutral}, {v: 1, seq: 1, pad: [0, 0, 0, 0, 0, -1, 0]},
    'x'.repeat(257), 'not json',
  ];
  for (const packet of invalid) {
    const f = fixture(t); await f.client.connectGuest(1); await f.client.connectGuest(2);
    const channel = f.peers[0].channel; channel.open(); channel.receive({v: 1, seq: 0, pad: pressed}); channel.receive(packet);
    assert.equal(f.client.peers.has(1), false); assert.equal(f.client.peers.has(2), true);
    assert.deepEqual(f.pads.at(-1), {seat: 1, pad: neutral}); assert.equal(f.errors.length, 1);
  }
  const f = fixture(t); await f.client.connectGuest(1);
  f.peers[0].channel.onmessage({data: new ArrayBuffer(5)});
  assert.equal(f.client.peers.size, 0);
});

test('input flood is bounded even when sequence numbers are repeated', async t => {
  const f = fixture(t); await f.client.connectGuest(1); const channel = f.peers[0].channel; channel.open();
  for (let n = 0; n < 181; n++) channel.receive({v: 1, seq: 0, pad: pressed});
  assert.match(f.errors[0].error.message, /rate/);
  assert.deepEqual(f.pads.at(-1), {seat: 1, pad: neutral});
});

test('guest drops buffered inputs instead of retaining a stale queue', async t => {
  const f = await guestFixture(t);
  f.channel.bufferedAmount = 1025;
  assert.equal(f.client.sendPad(pressed), false); assert.equal(f.channel.sent.length, 0);
  f.channel.bufferedAmount = 0;
  assert.equal(f.client.sendPad(neutral), true);
  assert.deepEqual(JSON.parse(f.channel.sent[0]), {v: 1, seq: 0, pad: neutral});
  assert.equal(f.client.sendPad(pressed), true);
  assert.equal(JSON.parse(f.channel.sent[1]).seq, 1);
  assert.throws(() => f.client.sendPad([1]), /Invalid/);
});

test('disconnect neutralizes each seat independently and cleanup preserves borrowed host media', async t => {
  const f = fixture(t);
  await f.client.connectGuest(1); await f.client.connectGuest(2);
  for (const peer of f.peers) { peer.channel.open(); peer.channel.receive({v: 1, seq: 0, pad: pressed}); }
  f.peers[0].connectionState = 'disconnected'; f.peers[0].onconnectionstatechange();
  assert.deepEqual(f.pads.at(-1), {seat: 1, pad: neutral});
  assert.equal(f.client.peers.get(2).neutral, false);
  f.client.close(); f.client.close();
  assert.deepEqual(f.pads.at(-1), {seat: 2, pad: neutral});
  assert.equal(f.client.peers.size, 0);
  assert.ok(f.source.getTracks().every(track => track.readyState === 'live'));
  assert.ok(f.peers.every(peer => peer.connectionState === 'closed' && peer.onicecandidate === null));
});

test('guest closes its received media and rejects an unexpected channel or inbound input', async t => {
  const f = await guestFixture(t); const track = new Track('video');
  f.peers[0].ontrack({track}); f.channel.receive({v: 1, seq: 0, pad: pressed});
  assert.match(f.errors[0].error.message, /Only the host/);
  assert.equal(track.readyState, 'ended');
  const g = fixture(t); await g.client.connectGuest(1);
  const extra = new Channel(); g.peers[0].ondatachannel({channel: extra});
  assert.equal(extra.readyState, 'closed'); assert.match(g.errors[0].error.message, /Unexpected/);
});

test('closing during offer creation prevents late signaling and borrowed media remains live', async t => {
  let release;
  const f = fixture(t, {peerFactory: config => {
    const peer = new Peer(config); peer.createOffer = () => new Promise(resolve => { release = resolve; }); return peer;
  }});
  const pending = f.client.connectGuest(1); f.client.close(); release({type: 'offer', sdp: 'late'}); await pending;
  assert.deepEqual(f.signals, []);
  assert.ok(f.source.getTracks().every(track => track.readyState === 'live'));
});

test('incoming signaling remains bounded while the browser is applying a description', async t => {
  const f = fixture(t); await f.client.connectGuest(1);
  let unblock;
  f.peers[0].setRemoteDescription = () => new Promise(resolve => { unblock = resolve; });
  const applying = f.client.receiveSignal({from: 1, signal: {id: id(1), description: {type: 'answer', sdp: 'slow'}}});
  await new Promise(resolve => setImmediate(resolve));
  const pending = Array.from({length: 127}, () => f.client.receiveSignal({from: 1, signal: {id: id(1), candidate: null}}));
  await assert.rejects(f.client.receiveSignal({from: 1, signal: {id: id(1), candidate: null}}), /Too many pending/);
  assert.equal(f.client.peers.size, 0);
  unblock(); await applying; await Promise.all(pending);
});

test('oversized signaling is rejected before allocating or touching a peer', async t => {
  const f = fixture(t, {seat: 1});
  await assert.rejects(f.client.receiveSignal({from: 0, signal: {id: id(1), description: {type: 'offer', sdp: 'a'.repeat(32768)}}}), /Invalid/);
  await assert.rejects(f.client.receiveSignal({from: 0, signal: {id: id(1), candidate: {candidate: 'a'.repeat(4097)}}}), /Invalid/);
  assert.equal(f.peers.length, 0);
});


test('SCTP user-initiated abort closes and neutralizes a peer without a spurious failure', async t => {
  const f = fixture(t); await f.client.connectGuest(1);
  const channel = f.peers[0].channel; channel.open(); channel.receive({v: 1, seq: 0, pad: pressed});
  channel.onerror({error: {errorDetail: 'sctp-failure', sctpCauseCode: 12, message: 'User-Initiated Abort, reason=Close called'}});
  assert.equal(f.client.peers.has(1), false);
  assert.deepEqual(f.pads.at(-1), {seat: 1, pad: neutral});
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.states.at(-1), {seat: 1, state: 'closed'});
  await f.client.connectGuest(1);
  f.peers[1].channel.open(); f.peers[1].channel.receive({v: 1, seq: 0, pad: pressed});
  assert.deepEqual(f.pads.at(-1), {seat: 1, pad: pressed});
  assert.equal(f.client.peers.get(1).lastSeq, 0);
});

test('other SCTP and unclassified channel errors still fail the peer and retain diagnostics', async t => {
  for (const cause of [{errorDetail: 'sctp-failure', sctpCauseCode: 13}, {errorDetail: 'dtls-failure', sctpCauseCode: 12}, undefined]) {
    const f = fixture(t); await f.client.connectGuest(1);
    const channel = f.peers[0].channel; channel.open(); channel.receive({v: 1, seq: 0, pad: pressed});
    channel.onerror({error: cause});
    assert.equal(f.client.peers.size, 0);
    assert.deepEqual(f.pads.at(-1), {seat: 1, pad: neutral});
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0].error.message, /Controller channel failed/);
    assert.equal(f.errors[0].error.cause, cause);
  }
});
