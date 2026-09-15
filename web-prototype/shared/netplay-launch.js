import {engineUrl, selectDirectBattleOpponents} from '../../engines/ssb64/launcher/launch-options.mjs';

export function publicGameAction(action, catalog, meleeSettings) {
  validatePicks(action);
  if (!Array.isArray(catalog)) throw Error('Could not load the public fighter roster.');
  const bySlug = new Map(catalog.map(character => [character.slug, character]));
  const publicPick = pick => {
    if (!pick) return undefined;
    const character = bySlug.get(pick.slug);
    if (!character) throw Error('Online games currently require public fighters so every player can load the same assets. Choose a public fighter.');
    return character;
  };
  for (const port of meleeSettings?.ports || []) {
    if (!['selected', 'random'].includes(port.character) && !/^vanilla:\d+$/.test(port.character) && !bySlug.has(port.character)) {
      throw Error('Choose public fighters or random opponents in Melee settings for an online game.');
    }
  }
  const character = publicPick(action.character);
  return {type: 'character', character, picks: (action.picks || []).map(publicPick),
    opponents: selectDirectBattleOpponents(character, catalog, [])};
}

function validatePicks(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)
      || (action.picks !== undefined && (!Array.isArray(action.picks) || action.picks.length > 3))) {
    throw Error('A game can contain only four selected fighters.');
  }
  for (const pick of [action.character, ...(action.picks || [])].filter(Boolean)) {
    if (typeof pick !== 'object' || Array.isArray(pick) || typeof pick.slug !== 'string'
        || !/^[a-zA-Z0-9_-]{1,128}$/.test(pick.slug)
        || (pick.name !== undefined && (typeof pick.name !== 'string' || pick.name.length > 256))) {
      throw Error('Invalid fighter in this game invitation.');
    }
  }
}

export function makeGameConfig(engine, action, advancedOptions, meleeSettings, seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw Error('Invalid game seed.');
  if (engine === 'melee') return {seed, action: structuredClone(action), meleeSettings: structuredClone(meleeSettings)};
  if (engine !== 'ssb64') throw Error('Unknown game engine.');
  // Resolve random stage/opponents ONCE on the creator. Every participant gets
  // exactly the same URL, with only human/CPU roles filled after seats freeze.
  // Direct matches preload their chosen assets; lazy in-game roster changes
  // cannot yet be included in the startup compatibility fingerprint.
  const options = {...advancedOptions, bootMode: 'free-for-all', ports: ['keyboard', 'cpu', 'cpu', 'cpu'], selectionMode: 'full-roster'};
  const launch = {...action, type: 'character'};
  return {seed, engineUrl: engineUrl(launch, options, [])};
}

export function roomSeats(room) {
  const seats = room.players.map(player => player.seat);
  if (!seats.includes(0) || seats.some(seat => !Number.isInteger(seat) || seat < 0 || seat > 3) || new Set(seats).size !== seats.length) {
    throw Error('Invalid game player assignments.');
  }
  return new Set(seats);
}

export function ssb64RoomUrl(room) {
  const src = room.config.engineUrl;
  if (typeof src !== 'string' || !src.startsWith('/engine/?')) throw Error('Invalid Smash 64 game configuration.');
  const url = new URL(src, 'https://opensmash.invalid');
  if (url.pathname !== '/engine/' || url.hash) throw Error('Invalid Smash 64 game URL.');
  const injections = url.searchParams.getAll('inject_player');
  if (injections.length > 3) throw Error('A game can contain only four selected fighters.');
  const injectedSeats = new Set();
  for (const value of injections) {
    const pick = JSON.parse(value);
    if (!Number.isInteger(pick.player) || pick.player < 1 || pick.player > 3 || injectedSeats.has(pick.player)) throw Error('Invalid fighter assignment.');
    injectedSeats.add(pick.player);
  }
  const seats = roomSeats(room);
  const plan = Array.from({length: 4}, (_, seat) => seats.has(seat)
    ? seat === 0 ? {kind: 'keyboard'} : {kind: 'gamepad', index: seat - 1, id: `Online P${seat + 1}`}
    : {kind: 'none'});
  url.searchParams.set('ports', JSON.stringify(plan));
  url.searchParams.set('SSB64_BOOT_SLOTS', Array.from({length: 4}, (_, seat) => seats.has(seat) ? 'h' : 'c').join(''));
  url.searchParams.set('SSB64_BOOT_HUMANS', String(seats.size));
  const battle = url.searchParams.get('SSB64_BOOT_BATTLE')?.split(',');
  if (!battle || battle.length !== 6) throw Error('Online Smash 64 requires a direct VS match.');
  battle[3] = seats.size > 1 ? '0' : '1';
  url.searchParams.set('SSB64_BOOT_BATTLE', battle.join(','));
  url.searchParams.delete('roster');
  return url.pathname + url.search;
}

export function meleeRoomAction(room) {
  validatePicks(room.config.action);
  const seats = roomSeats(room);
  const settings = structuredClone(room.config.meleeSettings);
  if (!settings || !Array.isArray(settings.ports) || settings.ports.length !== 4) throw Error('Invalid Melee game configuration.');
  settings.mode = 0;
  settings.ports = settings.ports.map((port, seat) => ({...port, device: seats.has(seat) ? seat === 0 ? 'keyboard' : `gamepad${seat - 1}` : 'cpu'}));
  return {...room.config.action, type: 'character', netplaySettings: settings, selectionMode: 'full-roster',
    portPlan: settings.ports.map((port, seat) => port.device === 'cpu' ? {kind: 'cpu'}
      : seat === 0 ? {kind: 'keyboard'} : {kind: 'gamepad', index: seat - 1})};
}
