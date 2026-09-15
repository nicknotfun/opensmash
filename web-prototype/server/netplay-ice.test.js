import test from 'node:test';
import assert from 'node:assert/strict';
import {createNetplayIce} from './netplay-ice.js';
const body = {room: 'a'.repeat(32), token: 'b'.repeat(43)};

test('ICE credentials require a currently connected streaming seat at the configured relay', async () => {
  let minted = 0;
  const ice = createNetplayIce({relayUrl: 'https://relay.example', publicOrigin: 'https://smash.example',
    provider: {iceServers: async () => { minted++; return {iceServers: [], relay: true}; }},
    fetchImpl: async (url, init) => {
      assert.equal(url, `https://relay.example/v1/rooms/${body.room}/authorize`);
      assert.equal(url.includes(body.token), false);
      assert.deepEqual(JSON.parse(init.body), {token: body.token});
      assert.equal(init.headers.Origin, 'https://smash.example');
      assert.equal(init.redirect, 'error');
      return {ok: true, json: async () => ({mode: 'host-stream', connected: true, seat: 2})};
    }});
  assert.equal((await ice(body)).relay, true);
  assert.equal(minted, 1);
  await assert.rejects(ice({...body, room: '../other'}), {status: 400});
  assert.equal(minted, 1);
});

test('invalid or disconnected seats cannot mint TURN credentials', async () => {
  for (const response of [
    {ok: false, status: 403}, {ok: true, json: async () => ({mode: 'lockstep', connected: true, seat: 1})},
    {ok: true, json: async () => ({mode: 'host-stream', connected: false, seat: 1})},
  ]) {
    const ice = createNetplayIce({relayUrl: 'https://relay.example', provider: {iceServers: () => assert.fail('minted')}, fetchImpl: async () => response});
    await assert.rejects(ice(body), {status: 403});
  }
});

test('relay failure is bounded and never silently grants credentials', async () => {
  const ice = createNetplayIce({relayUrl: 'https://relay.example', provider: {iceServers: () => assert.fail('minted')}, fetchImpl: async () => {throw Error('offline');}});
  await assert.rejects(ice(body), {status: 503});
});
