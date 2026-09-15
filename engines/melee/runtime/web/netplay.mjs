export const NETPLAY_PROTOCOL = 'opensmash-melee-vi-v1';
export const NEUTRAL_PAD = Object.freeze([0, 0x80808080, 0, 0]);

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function packNetworkPad(pad, connected = true) {
  if (!Array.isArray(pad) || pad.length !== 7 || !pad.every(Number.isInteger) ||
      pad[0] < 0 || (pad[0] & ~0x1f7f) ||
      pad.slice(1,5).some(value => value < -128 || value > 127) ||
      pad.slice(5).some(value => value < 0 || value > 255))
    throw Error('Invalid multiplayer controller packet.');
  const [buttons,x,y,cx,cy,l,r] = pad;
  return [buttons, ((x+128)|((y+128)<<8)|((cx+128)<<16)|((cy+128)<<24))>>>0, l|(r<<8), connected?1:0];
}

export function validateFrame(frame, pads) {
  if (!Number.isInteger(frame) || frame < 0 || frame >= 0xffffffff ||
      !Array.isArray(pads) || pads.length !== 4 || pads.some(p =>
        !Array.isArray(p) || p.length !== 4 || !p.every(Number.isInteger) ||
        p[0] < 0 || (p[0] & ~0x1f7f) || p[1] < 0 || p[1] > 0xffffffff ||
        p[2] < 0 || p[2] > 65535 || (p[3] !== 0 && p[3] !== 1)))
    throw Error('Invalid multiplayer frame.');
}

export async function netplayFingerprint({build, disc, system, seed, launch, costumes, cssAssets}, digest = bytes => crypto.subtle.digest('SHA-256', bytes)) {
  const hex = buffer => Array.from(new Uint8Array(buffer), value => value.toString(16).padStart(2,'0')).join('');
  const assets = await Promise.all([...costumes, ...cssAssets].map(async asset =>
    [asset.filename, hex(await digest(await asset.blob.arrayBuffer()))]));
  assets.sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const settings = {mode:launch.mode, stage:launch.stage, level:launch.level,
    stocks:launch.stocks, minutes:launch.minutes, ports:launch.packedPorts};
  return hex(await digest(new TextEncoder().encode(JSON.stringify({
    protocol:NETPLAY_PROTOCOL, build:build.wasmSha256, disc, system, seed, settings, assets,
  }))));
}
