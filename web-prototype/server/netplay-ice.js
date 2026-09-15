import {relayOrigin, ROOM_ID} from '../shared/netplay-client.js';

// The room capability proves a connected seat. Credentials never enter URLs.
export function createNetplayIce({relayUrl, publicOrigin, provider, fetchImpl = fetch}) {
  const origin = relayUrl ? relayOrigin(relayUrl) : null;
  return async function ice(body) {
    const fail = (message, status) => { throw Object.assign(Error(message), {status}); };
    if (!origin) fail('Online games are unavailable.', 503);
    if (!body || !ROOM_ID.test(body.room || '') || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(body.token)) fail('Invalid game credentials.', 400);
    let response;
    try {
      response = await fetchImpl(`${origin}/v1/rooms/${body.room}/authorize`, {
        method: 'POST', headers: {'Content-Type': 'application/json', ...(publicOrigin ? {Origin: publicOrigin} : {})},
        body: JSON.stringify({token: body.token}), redirect: 'error', signal: AbortSignal.timeout(5000),
      });
    } catch { fail('Could not verify the game connection.', 503); }
    if (!response.ok) fail('Join the game before connecting video.', response.status === 403 || response.status === 404 ? 403 : 503);
    const seat = await response.json();
    if (seat.mode !== 'host-stream' || seat.connected !== true || !Number.isInteger(seat.seat) || seat.seat < 0 || seat.seat > 3) fail('The game connection is unavailable.', 403);
    return provider.iceServers();
  };
}
