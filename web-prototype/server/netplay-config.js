export function netplayConfig(env = process.env) {
  if (!env.OPENSMASH_NETPLAY_URL) return {enabled: false};
  const url = new URL(env.OPENSMASH_NETPLAY_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('OPENSMASH_NETPLAY_URL must be an HTTPS origin without credentials or a path.');
  }
  return {enabled: true, relayUrl: url.origin, protocol: 1};
}
