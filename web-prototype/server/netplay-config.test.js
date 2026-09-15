import test from 'node:test';
import assert from 'node:assert/strict';
import {netplayConfig} from './netplay-config.js';
test('only a configured HTTPS relay origin is exposed to browsers', () => {
  assert.deepEqual(netplayConfig({}), {enabled: false});
  assert.deepEqual(netplayConfig({OPENSMASH_NETPLAY_URL: 'https://relay.example:8443/'}), {enabled: true, relayUrl: 'https://relay.example:8443', protocol: 1});
  for (const value of ['http://relay.example', 'https://user:pass@relay.example', 'https://relay.example/api', 'https://relay.example/?secret=1']) {
    assert.throws(() => netplayConfig({OPENSMASH_NETPLAY_URL: value}));
  }
});
