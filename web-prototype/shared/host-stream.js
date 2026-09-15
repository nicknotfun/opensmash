// Browser-only media/input transport. Signaling must come from authenticated
// room seats; the adapter fences connection generations before calling here.
// This module never reads game files or drives the simulation/render loop.
import {NEUTRAL_PAD, validPad} from './netplay-client.js';

export const HOST_STREAM_PROTOCOL = 'opensmash-melee-pad-v1';
export const HOST_STREAM_INPUT_TIMEOUT = 300;
export const HOST_STREAM_MAX_SIGNAL_BYTES = 32 * 1024;
const MAX_PAD_BYTES = 256;
const MAX_BUFFERED_INPUT = 1024;
const MAX_PENDING_SIGNALS = 128;
const INPUTS_PER_SECOND = 180;
const NONCE = /^[a-f0-9]{32}$/;
const seatValid = seat => Number.isInteger(seat) && seat >= 0 && seat < 4;
const keysAre = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const bytes = text => new TextEncoder().encode(text).byteLength;
function nonce() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
}
function signalValid(signal) {
  if (!signal || !NONCE.test(signal.id) || bytes(JSON.stringify(signal)) > HOST_STREAM_MAX_SIGNAL_BYTES) return false;
  if (keysAre(signal, ['id', 'description'])) {
    return keysAre(signal.description, ['type', 'sdp']) && ['offer', 'answer'].includes(signal.description.type)
      && typeof signal.description.sdp === 'string' && signal.description.sdp.length > 0;
  }
  if (!keysAre(signal, ['id', 'candidate'])) return false;
  const c = signal.candidate;
  return c === null || (c && typeof c === 'object' && !Array.isArray(c)
    && Object.keys(c).every(key => ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'].includes(key))
    && typeof c.candidate === 'string' && c.candidate.length <= 4096
    && (c.sdpMid == null || typeof c.sdpMid === 'string')
    && (c.sdpMLineIndex == null || (Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0))
    && (c.usernameFragment == null || typeof c.usernameFragment === 'string'));
}

/** A host owns seat 0; each guest owns one immutable seat 1..3.
 *
 * sendSignal(to, signal) must route to that authenticated room member and use
 * the member's current connection generation. receiveSignal({from,signal}) is
 * called only after authenticating/fencing the sender in the room adapter.
 * The host supplies its borrowed MediaStream; its tracks remain caller-owned.
 * Guests call sendPad at their independent input cadence and on changes.
 */
export class HostStream {
  constructor({seat, sendSignal, stream, iceServers = [], iceTransportPolicy = 'all',
    onPad = () => {}, onStream = () => {}, onState = () => {}, onError = () => {},
    peerFactory = config => new RTCPeerConnection(config),
    mediaStreamFactory = () => new MediaStream(), createNonce = nonce,
    now = () => performance.now(), inputTimeout = HOST_STREAM_INPUT_TIMEOUT,
    negotiationTimeout = 15000} = {}) {
    if (!seatValid(seat) || typeof sendSignal !== 'function') throw Error('A room seat and authenticated signaling adapter are required.');
    if (!Number.isFinite(inputTimeout) || inputTimeout < 50 || inputTimeout > 2000
        || !Number.isFinite(negotiationTimeout) || negotiationTimeout < 100) throw Error('Invalid stream timeout.');
    if (seat === 0 && (!stream?.getTracks || !stream.getTracks().some(track => track.kind === 'video' && track.readyState === 'live'))) {
      throw Error('The host must supply a live game video stream.');
    }
    if (seat !== 0 && stream) throw Error('Only the host can supply game media.');
    if (!['all', 'relay'].includes(iceTransportPolicy)) throw Error('Invalid ICE policy.');
    Object.assign(this, {seat, sendSignal, stream, iceServers, iceTransportPolicy, onPad, onStream, onState, onError,
      peerFactory, mediaStreamFactory, createNonce, now, inputTimeout, negotiationTimeout});
    this.peers = new Map();
    this.closed = false;
    this.seenOffers = new Set();
    if (seat === 0) {
      this.sweepTimer = setInterval(() => this.sweepInputs(), Math.min(100, inputTimeout / 2));
      this.sweepTimer.unref?.();
    }
  }
  active(peer) { return !this.closed && !peer.closed && this.peers.get(peer.seat) === peer; }
  makePeer(seat, id) {
    const pc = this.peerFactory({iceServers: this.iceServers, iceTransportPolicy: this.iceTransportPolicy});
    const peer = {seat, id, pc, closed: false, channel: null, localCandidates: [], pendingCandidates: [],
      descriptionSent: false, sending: Promise.resolve(), receiving: Promise.resolve(), queuedSignals: 0, queuedReceives: 0,
      lastSeq: -1, nextSeq: 0, lastInput: null, neutral: true, rateAt: this.now(), tokens: INPUTS_PER_SECOND};
    this.peers.set(seat, peer);
    peer.timer = setTimeout(() => this.failPeer(peer, Error('Game streaming connection timed out.')), this.negotiationTimeout);
    peer.timer.unref?.();
    pc.onicecandidate = ({candidate}) => {
      if (!this.active(peer)) return;
      const value = candidate?.toJSON ? candidate.toJSON() : candidate;
      const signal = {id, candidate: value ?? null};
      if (!peer.descriptionSent) {
        if (peer.localCandidates.length >= MAX_PENDING_SIGNALS) return this.failPeer(peer, Error('Too many ICE candidates.'));
        peer.localCandidates.push(signal);
      } else void this.transmit(peer, signal).catch(error => this.failPeer(peer, error));
    };
    pc.onconnectionstatechange = () => {
      if (!this.active(peer)) return;
      const state = pc.connectionState;
      if (state === 'failed' || state === 'closed') return this.failPeer(peer, Error('Game streaming connection closed.'));
      if (state === 'disconnected') this.neutralize(peer);
      this.onState({seat, state});
    };
    pc.ondatachannel = ({channel}) => {
      if (this.seat === 0 || peer.channel) {
        channel.close();
        return this.failPeer(peer, Error('Unexpected controller channel.'));
      }
      this.attachChannel(peer, channel);
    };
    pc.ontrack = ({track}) => {
      if (!this.active(peer)) { track.stop(); return; }
      if (this.seat === 0 || !['audio', 'video'].includes(track.kind)) {
        track.stop();
        return this.failPeer(peer, Error('Unexpected game media.'));
      }
      peer.remoteStream ??= this.mediaStreamFactory();
      if (!peer.remoteStream.getTracks().some(existing => existing.id === track.id)) peer.remoteStream.addTrack(track);
      this.onStream(peer.remoteStream);
    };
    this.onState({seat, state: 'connecting'});
    return peer;
  }
  attachChannel(peer, channel) {
    if (!this.active(peer)) { channel.close(); return; }
    if (channel.label !== HOST_STREAM_PROTOCOL || channel.protocol !== HOST_STREAM_PROTOCOL
        || channel.ordered !== false || channel.maxRetransmits !== 0) {
      channel.close();
      return this.failPeer(peer, Error('Invalid controller channel.'));
    }
    peer.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      if (!this.active(peer)) return;
      clearTimeout(peer.timer);
      this.onState({seat: peer.seat, state: 'connected'});
    };
    channel.onclose = () => { if (this.active(peer)) this.removePeer(peer.seat); };
    channel.onerror = event => {
      if (!this.active(peer)) return;
      const cause = event?.error;
      // RTCPeerConnection.close() can arrive as SCTP User-Initiated Abort
      // before the room departure/new offer. RFC 9260 section 3.3.10.12 gives
      // this cause code 12. It closes and neutralizes this peer like onclose;
      // unrelated SCTP/DTLS/unknown failures still report an error.
      if (cause?.errorDetail === 'sctp-failure' && cause.sctpCauseCode === 12) {
        this.removePeer(peer.seat);
        return;
      }
      this.failPeer(peer, Error('Controller channel failed.', {cause}));
    };
    channel.onmessage = ({data}) => {
      if (!this.active(peer)) return;
      try {
        if (this.seat !== 0) throw Error('Only the host receives controller input.');
        this.receivePad(peer, data);
      } catch (error) { this.failPeer(peer, error); }
    };
    if (channel.readyState === 'open') channel.onopen();
  }
  async transmit(peer, signal) {
    if (!this.active(peer)) return false;
    if (!signalValid(signal)) throw Error('Invalid local game stream signal.');
    if (++peer.queuedSignals > MAX_PENDING_SIGNALS) {
      peer.queuedSignals--;
      throw Error('Too many pending game signals.');
    }
    const sent = peer.sending.then(async () => {
      if (!this.active(peer)) return false;
      await this.sendSignal(peer.seat, signal);
      return true;
    });
    peer.sending = sent.catch(() => {});
    try { return await sent; } finally { peer.queuedSignals--; }
  }
  async sendDescription(peer) {
    const description = peer.pc.localDescription;
    await this.transmit(peer, {id: peer.id, description: {type: description.type, sdp: description.sdp}});
    if (!this.active(peer)) return;
    peer.descriptionSent = true;
    const candidates = peer.localCandidates.splice(0);
    for (const signal of candidates) await this.transmit(peer, signal);
  }
  async connectGuest(seat) {
    if (this.seat !== 0) throw Error('Only the host can connect a guest.');
    if (!seatValid(seat) || seat === 0) throw Error('Invalid guest seat.');
    if (this.closed) throw Error('This stream has closed.');
    this.removePeer(seat);
    const id = this.createNonce();
    if (!NONCE.test(id)) throw Error('Invalid stream negotiation nonce.');
    const peer = this.makePeer(seat, id);
    try {
      for (const track of this.stream.getTracks()) peer.pc.addTrack(track, this.stream);
      this.attachChannel(peer, peer.pc.createDataChannel(HOST_STREAM_PROTOCOL,
        {protocol: HOST_STREAM_PROTOCOL, ordered: false, maxRetransmits: 0}));
      const offer = await peer.pc.createOffer();
      if (!this.active(peer)) return;
      await peer.pc.setLocalDescription(offer);
      if (this.active(peer)) await this.sendDescription(peer);
    } catch (error) { this.failPeer(peer, error); throw error; }
  }
  async receiveSignal({from, signal} = {}) {
    if (this.closed) return false;
    if (!seatValid(from) || from === this.seat || (this.seat === 0 ? from === 0 : from !== 0)
        || !signalValid(signal)) throw Error('Invalid game stream signal.');
    const type = signal.description?.type;
    if ((this.seat === 0 && type === 'offer') || (this.seat !== 0 && type === 'answer')) throw Error('Invalid signaling role.');
    let peer = this.peers.get(from);
    if (type === 'offer' && (!peer || peer.id !== signal.id)) {
      if (this.seenOffers.has(signal.id)) return false;
      if (this.seenOffers.size >= 128) throw Error('Too many stream negotiations. Rejoin the room.');
      this.seenOffers.add(signal.id);
      this.removePeer(from);
      peer = this.makePeer(from, signal.id);
    }
    // A stale answer/candidate never creates a peer or enters its replacement.
    if (!peer || peer.id !== signal.id) return false;
    if (++peer.queuedReceives > MAX_PENDING_SIGNALS) {
      peer.queuedReceives--;
      const error = Error('Too many pending incoming signals.');
      this.failPeer(peer, error);
      throw error;
    }
    const work = peer.receiving.then(async () => {
      if (!this.active(peer)) return false;
      if (signal.description) {
        if (peer.pc.remoteDescription) throw Error('Duplicate stream description.');
        await peer.pc.setRemoteDescription(signal.description);
        if (!this.active(peer)) return false;
        for (const candidate of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(candidate);
        if (type === 'offer') {
          const answer = await peer.pc.createAnswer();
          if (!this.active(peer)) return false;
          await peer.pc.setLocalDescription(answer);
          if (this.active(peer)) await this.sendDescription(peer);
        }
      } else if (!peer.pc.remoteDescription) {
        if (peer.pendingCandidates.length >= MAX_PENDING_SIGNALS) throw Error('Too many pending ICE candidates.');
        peer.pendingCandidates.push(signal.candidate);
      } else await peer.pc.addIceCandidate(signal.candidate);
      return true;
    });
    peer.receiving = work.catch(() => {});
    try { return await work; } catch (error) { this.failPeer(peer, error); throw error; }
    finally { peer.queuedReceives--; }
  }
  receivePad(peer, data) {
    const now = this.now();
    peer.tokens = Math.min(INPUTS_PER_SECOND, peer.tokens + Math.max(0, now - peer.rateAt) * INPUTS_PER_SECOND / 1000);
    peer.rateAt = now;
    if (peer.tokens < 1) throw Error('Controller input rate exceeded.');
    peer.tokens--;
    if (typeof data !== 'string' || data.length > MAX_PAD_BYTES || bytes(data) > MAX_PAD_BYTES) throw Error('Invalid controller packet size.');
    let packet;
    try { packet = JSON.parse(data); } catch { throw Error('Invalid controller packet.'); }
    if (!keysAre(packet, ['v', 'seq', 'pad']) || packet.v !== 1 || !Number.isInteger(packet.seq)
        || packet.seq < 0 || packet.seq > 0xffffffff || !validPad(packet.pad)) throw Error('Invalid controller packet.');
    if (packet.seq <= peer.lastSeq) return;
    peer.lastSeq = packet.seq;
    peer.lastInput = now;
    peer.neutral = packet.pad.every(value => value === 0);
    this.onPad(peer.seat, [...packet.pad]);
  }
  sendPad(pad) {
    if (this.seat === 0) throw Error('The host reads its local controller directly.');
    if (!validPad(pad)) throw Error('Invalid controller state.');
    if (this.closed) return false;
    const peer = this.peers.get(0), channel = peer?.channel;
    if (!channel || channel.readyState !== 'open' || channel.bufferedAmount > MAX_BUFFERED_INPUT) return false;
    if (peer.nextSeq > 0xffffffff) { this.failPeer(peer, Error('Controller sequence exhausted. Rejoin the room.')); return false; }
    try {
      channel.send(JSON.stringify({v: 1, seq: peer.nextSeq++, pad}));
      return true;
    } catch (error) { this.failPeer(peer, error); return false; }
  }
  neutralize(peer) {
    if (this.seat !== 0 || peer.neutral) return;
    peer.neutral = true;
    this.onPad(peer.seat, [...NEUTRAL_PAD]);
  }
  sweepInputs() {
    const now = this.now();
    for (const peer of this.peers.values()) {
      if (peer.lastInput !== null && now - peer.lastInput >= this.inputTimeout) this.neutralize(peer);
    }
  }
  failPeer(peer, error) {
    if (!this.active(peer)) return;
    this.removePeer(peer.seat);
    this.onError(error instanceof Error ? error : Error(String(error)), peer.seat);
  }
  removePeer(seat) {
    const peer = this.peers.get(seat);
    if (!peer) return;
    this.peers.delete(seat);
    peer.closed = true;
    clearTimeout(peer.timer);
    this.neutralize(peer);
    const channel = peer.channel;
    if (channel) {
      channel.onopen = channel.onclose = channel.onerror = channel.onmessage = null;
      channel.close();
    }
    peer.pc.onicecandidate = peer.pc.onconnectionstatechange = peer.pc.ondatachannel = peer.pc.ontrack = null;
    peer.pc.close();
    peer.remoteStream?.getTracks().forEach(track => track.stop());
    peer.localCandidates.length = peer.pendingCandidates.length = 0;
    this.onState({seat, state: 'closed'});
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    for (const seat of [...this.peers.keys()]) this.removePeer(seat);
    this.seenOffers.clear();
  }
}
