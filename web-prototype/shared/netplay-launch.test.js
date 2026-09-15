import test from 'node:test';
import assert from 'node:assert/strict';
import {makeGameConfig, ssb64RoomUrl, meleeRoomAction, publicGameAction} from './netplay-launch.js';

test('a host resolves the whole SSB64 lineup once; peers only assign frozen human seats', () => {
  const config = makeGameConfig('ssb64', {type: 'start'}, {}, null, 123);
  const room = {config, players: [{seat: 0}, {seat: 2}]};
  const first = ssb64RoomUrl(room), second = ssb64RoomUrl(structuredClone(room));
  assert.equal(first, second);
  const params = new URL(first, 'https://example.com').searchParams;
  assert.equal(params.get('SSB64_BOOT_SLOTS'), 'hchc');
  assert.equal(params.get('SSB64_BOOT_HUMANS'), '2');
  assert.equal(params.has('roster'), false);
  assert.equal(params.get('SSB64_BOOT_BATTLE').split(',').filter((_, i) => i !== 3).join(','),
    new URL(config.engineUrl, 'https://example.com').searchParams.get('SSB64_BOOT_BATTLE').split(',').filter((_, i) => i !== 3).join(','));
});

test('room configuration cannot navigate an iframe to another origin or a script URL', () => {
  for (const engineUrl of ['https://attacker.example/', 'javascript:alert(1)', '//attacker.example/', '/engine/../../create']) {
    assert.throws(() => ssb64RoomUrl({config: {engineUrl}, players: [{seat: 0}]}));
  }
});

test('Melee freezes devices by seat and leaves unoccupied fighters under CPU control', () => {
  const original = {ports: Array.from({length: 4}, () => ({device: 'off', character: 'random'})), stage: 31, mode: 4};
  const config = makeGameConfig('melee', {type: 'start'}, {}, original, 456);
  const action = meleeRoomAction({config, players: [{seat: 0}, {seat: 3}]});
  assert.deepEqual(action.netplaySettings.ports.map(port => port.device), ['keyboard', 'cpu', 'cpu', 'gamepad2']);
  assert.equal(action.netplaySettings.mode, 0);
  assert.equal(original.mode, 4);
});

test('duplicate seats or an invalid seed are rejected before engine boot', () => {
  assert.throws(() => makeGameConfig('ssb64', {}, {}, null, -1));
  assert.throws(() => meleeRoomAction({config: {}, players: [{seat: 0}, {seat: 0}]}));
});

test('online auto-opponents come from public assets, never the owners private fighter pool', () => {
  const catalog = [{slug: 'public-one', name: 'One', fkind: 0}, {slug: 'public-two', name: 'Two', fkind: 1}];
  const original = {type: 'character', character: {...catalog[0], bundleUrl: '/private/token'}, opponents: [{type: 'character', character: {slug: 'private'}}]};
  const action = publicGameAction(original, catalog);
  assert.equal(action.character, catalog[0]);
  assert.equal(action.opponents.some(opponent => opponent.character?.slug === 'private'), false);
  assert.equal(JSON.stringify(action).includes('/private/token'), false);
  assert.throws(() => publicGameAction({character: {slug: 'private'}}, catalog), /public fighters/);
  assert.throws(() => publicGameAction({}, catalog, {ports: [{character: 'private'}]}), /public fighters/);
});

test('crafted invitations cannot schedule conversions for more than four fighters', () => {
  const room = {config: {action: {picks: Array.from({length: 100}, (_, index) => ({slug: `fighter-${index}`}))}}, players: [{seat: 0}]};
  assert.throws(() => meleeRoomAction(room), /only four/);
  room.config.action.picks = 'not-an-array';
  assert.throws(() => meleeRoomAction(room), /only four/);
  room.config.action.picks = [{slug: '../../private'}];
  assert.throws(() => meleeRoomAction(room), /Invalid fighter/);
});
