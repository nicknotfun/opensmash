// Actual browser WebTransport interoperability, using the application's shared
// client and a real Go relay. No ROM, engine binaries, or mocked transport.
import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {createHash, X509Certificate} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = await mkdtemp(join(tmpdir(), 'opensmash-browser-smoke-'));
const TICKS = 180;
const browserExecutable = process.env.CHROME_BIN || process.env.CHROMIUM_EXECUTABLE;
let browser, app, relay;
let relayLogs = '';
const browserLogs = [];
const redact = value => String(value).replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function unusedTCPPort() {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1');
  await once(listener, 'listening'); const {port} = listener.address();
  await new Promise(resolve => listener.close(resolve)); return port;
}
async function waitHealthy(url, ca) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (relay.exitCode !== null) throw Error(`Relay exited before readiness: ${relayLogs}`);
    try {
      await new Promise((resolve, reject) => {
        const req = https.get(url, {ca, timeout: 1000}, res => {
          res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(Error('Not ready')));
        }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('timeout')));
      }); return;
    } catch { await delay(50); }
  }
  throw Error(`Relay readiness timed out: ${relayLogs}`);
}
async function waitState(page, predicate, argument) {
  await page.waitForFunction(({source, arg}) => {
    if (window.session?.error) throw Error(window.session.error);
    return new Function('state', 'arg', `return (${source})(state, arg)`)(window.session?.getSnapshot(), arg);
  }, {source: predicate.toString(), arg: argument}, {timeout: 15000});
}

try {
  const certPath = join(scratch, 'cert.pem'), keyPath = join(scratch, 'key.pem');
  await run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost']);
  const certificate = await readFile(certPath);
  const spki = new X509Certificate(certificate).publicKey.export({type: 'spki', format: 'der'});
  const certificateSPKI = createHash('sha256').update(spki).digest('base64');
  const certificateHash = [...createHash('sha256').update(new X509Certificate(certificate).raw).digest()];
  const port = await unusedTCPPort();
  const relayURL = `https://127.0.0.1:${port}`;
  const sharedClient = await readFile(join(repo, 'web-prototype/shared/netplay-client.js'));
  app = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/api/netplay/config') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({enabled: true, relayUrl: relayURL}));
    }
    if (req.url === '/netplay-client.js') {
      res.setHeader('Content-Type', 'text/javascript'); return res.end(sharedClient);
    }
    if (req.url !== '/') { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Netplay smoke</title><script type="module">window.certificateHash = ${JSON.stringify(certificateHash)}; window.api = await import("/netplay-client.js");</script>`);
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const appURL = `http://127.0.0.1:${app.address().port}`;
  const relayBinary = join(scratch, 'relay');
  await run('go', ['build', '-o', relayBinary, '.'], {
    cwd: join(repo, 'netplay/relay'),
    env: {...process.env, GOCACHE: process.env.GOCACHE || join(tmpdir(), 'opensmash-go-build'),
      GOMODCACHE: process.env.GOMODCACHE || join(tmpdir(), 'opensmash-go-mod')},
  });
  relay = spawn(relayBinary, [], {
    env: {...process.env, RELAY_ADDR: `127.0.0.1:${port}`, RELAY_TLS_CERT: certPath,
      RELAY_TLS_KEY: keyPath, RELAY_ALLOWED_ORIGINS: appURL}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.on('error', error => { relayLogs += error.message; });
  relay.stdout.on('data', data => { relayLogs = (relayLogs + data).slice(-8192); });
  relay.stderr.on('data', data => { relayLogs = (relayLogs + data).slice(-8192); });
  await waitHealthy(`${relayURL}/healthz`, certificate);
  browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? {executablePath: browserExecutable} : {}),
    // Test-only trust exception for this ephemeral certificate's exact public
    // key. Global certificate-error bypass is intentionally not enabled.
    args: [`--ignore-certificate-errors-spki-list=${certificateSPKI}`],
  });
  const browserVersion = browser.version();
  const contexts = await Promise.all(Array.from({length: 5}, () => browser.newContext()));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  await Promise.all(pages.map(async page => {
    page.on('console', message => { if (message.type() === 'error') browserLogs.push(redact(message.text()).slice(0, 1024)); });
    await page.goto(appURL); await page.waitForFunction(() => Boolean(window.api));
    assert.equal(await page.evaluate(() => typeof WebTransport), 'function');
  }));
  const roomID = await pages[0].evaluate(async () => {
    window.access = await window.api.createGame('melee', {seed: 123456789, fixture: 'four-browser-lockstep-v1'});
    return window.access.room.id;
  });
  await Promise.all(pages.slice(1, 4).map(page => page.evaluate(async id => {
    window.access = await window.api.joinGame(id);
  }, roomID)));
  const rejection = await pages[4].evaluate(async id => {
    try { await window.api.joinGame(id); return ''; } catch (error) { return error.message; }
  }, roomID);
  assert.match(rejection, /four players/i, 'fifth browser must be rejected');
  const players = pages.slice(0, 4);
  await Promise.all(players.map(page => page.evaluate(async () => {
    window.session = new window.api.NetplaySession(window.access, {
      transportFactory: url => new WebTransport(url, {serverCertificateHashes: [{
        algorithm: 'sha-256', value: new Uint8Array(window.certificateHash),
      }]}),
    });
    await window.session.connect();
  })));
  await waitState(players[0], state => state?.room.players.length === 4 && state.room.players.every(p => p.connected));
  await players[0].evaluate(() => window.session.prepare());
  await Promise.all(players.map(page => waitState(page, state => state?.room.state === 'preparing')));
  const rosters = await Promise.all(players.map(page => page.evaluate(() => window.session.room.players.map(p => p.seat))));
  for (const roster of rosters) assert.deepEqual(roster, [0, 1, 2, 3]);
  await Promise.all(players.map(page => page.evaluate(() => window.session.ready('synthetic-engine-content-and-settings-v1'))));
  await waitState(players[0], state => state?.room.players.every(p => p.ready));
  await players[0].evaluate(() => window.session.start());
  await Promise.all(players.map(page => waitState(page, state => state?.started)));
  const results = await Promise.all(players.map(page => page.evaluate(async ticks => {
    const frames = [];
    const pad = (tick, seat) => [1 << seat, ((tick * 3 + seat) % 256) - 128,
      ((tick * 7 + seat * 2) % 256) - 128, seat * 10, -seat * 10, tick % 256, seat * 50];
    for (let tick = 0; tick < ticks; tick++) {
      const pads = await window.session.nextFrame(tick, pad(tick, window.session.seat));
      const expected = Array.from({length: 4}, (_, seat) => tick < 3 ? [0, 0, 0, 0, 0, 0, 0] : pad(tick - 3, seat));
      if (JSON.stringify(pads) !== JSON.stringify(expected)) throw Error(`Incorrect confirmed pads at tick ${tick}`);
      frames.push(pads);
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    const bytes = new TextEncoder().encode(JSON.stringify(frames));
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    return {seat: window.session.seat, ticks: frames.length, hash, error: window.session.error};
  }, TICKS)));
  assert.equal(new Set(results.map(result => result.seat)).size, 4);
  for (const result of results) { assert.equal(result.ticks, TICKS); assert.equal(result.error, ''); assert.equal(result.hash, results[0].hash); }
  await players[3].evaluate(() => window.session.close('Disconnect smoke test.'));
  await Promise.all(players.slice(0, 3).map(async page => {
    await page.waitForFunction(() => window.session.closed && Boolean(window.session.error), null, {timeout: 10000});
    assert.match(await page.evaluate(() => window.session.error), /disconnected|closed|ended/i);
    const rejected = await page.evaluate(async () => {
      try { await window.session.nextFrame(180, [0, 0, 0, 0, 0, 0, 0]); return false; } catch { return true; }
    }); assert.equal(rejected, true, 'disconnected matches must stop simulation');
  }));
  console.log(JSON.stringify({ok: true, browser: browserVersion, players: 4, ticks: TICKS,
    frameHash: results[0].hash, fifthPlayerRejected: true, disconnectStoppedAll: true}, null, 2));
} catch (error) {
  console.error('Relay diagnostics:', redact(relayLogs));
  console.error('Browser diagnostics:', browserLogs.slice(-12));
  throw error;
} finally {
  await browser?.close();
  if (relay && relay.exitCode === null) {
    const exited = once(relay, 'exit');
    const forceKill = setTimeout(() => relay.kill('SIGKILL'), 6000);
    relay.kill('SIGTERM');
    await exited;
    clearTimeout(forceKill);
  }
  if (app) await new Promise(resolve => app.close(resolve));
  await rm(scratch, {recursive: true, force: true});
}
