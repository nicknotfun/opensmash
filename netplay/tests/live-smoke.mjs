// Synthetic input/presentation test against an explicitly selected LIVE site.
// Uses the production client, REST endpoints and WebTransport with normal TLS.
// Does not load a ROM or prove that either game engine is deterministic.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

function httpsOrigin(value, label) {
  if (!value) throw Error(`Usage: node live-smoke.mjs <https-site-origin> <https-relay-origin> (${label} missing)`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error(`${label} must be a plain HTTPS origin.`);
  }
  return url.origin;
}
const siteURL = httpsOrigin(process.argv[2], 'Site URL');
const relayURL = httpsOrigin(process.argv[3], 'Relay URL');
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [sharedClient, presentation] = await Promise.all([
  readFile(join(repo, 'web-prototype/shared/netplay-client.js')),
  readFile(join(repo, 'engines/melee/runtime/web/presentation.mjs')),
]);
const harnessPath = `/__opensmash-live-smoke-${randomUUID()}`;
const TICKS = 180;
const browserExecutable = process.env.CHROME_BIN || process.env.CHROMIUM_EXECUTABLE;
const browserLogs = [];
const redact = value => String(value).replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]');
let browser;
let pages = [];
let roomID;
let stage = 'launch';

async function waitState(page, predicate) {
  await page.waitForFunction(source => {
    if (window.session?.error) throw Error(window.session.error);
    return new Function('state', `return (${source})(state)`)(window.session?.getSnapshot());
  }, predicate.toString(), {timeout: 20000});
}

try {
  browser = await chromium.launch({headless: true,
    ...(browserExecutable ? {executablePath: browserExecutable} : {}),
  });
  const browserVersion = browser.version();
  const contexts = await Promise.all(Array.from({length: 5}, () => browser.newContext({serviceWorkers: 'block'})));
  // Only these three random test-harness URLs are fulfilled from the checkout.
  // The website config, relay REST, CORS preflights and QUIC remain real requests.
  await Promise.all(contexts.map(context => context.route(url => url.origin === siteURL && [
    harnessPath, `${harnessPath}/netplay-client.js`, `${harnessPath}/presentation.mjs`,
  ].includes(url.pathname) && !url.search, async route => {
    const path = new URL(route.request().url()).pathname;
    const headers = {'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless'};
    if (path === `${harnessPath}/netplay-client.js`) {
      return route.fulfill({status: 200, headers, contentType: 'text/javascript', body: sharedClient});
    }
    if (path === `${harnessPath}/presentation.mjs`) {
      return route.fulfill({status: 200, headers, contentType: 'text/javascript', body: presentation});
    }
    return route.fulfill({status: 200, headers, contentType: 'text/html',
      body: `<!doctype html><title>OpenSmash live synthetic smoke</title><script type="module">window.presentationURL = ${JSON.stringify(`${harnessPath}/presentation.mjs`)}; window.api = await import(${JSON.stringify(`${harnessPath}/netplay-client.js`)});</script>`});
  })));
  pages = await Promise.all(contexts.map(context => context.newPage()));
  for (const page of pages) {
    page.setDefaultTimeout(30000);
    page.on('console', message => {
      if (message.type() === 'error') browserLogs.push(redact(message.text()).slice(0, 1024));
    });
    page.on('pageerror', error => browserLogs.push(redact(error.message).slice(0, 1024)));
  }
  stage = 'production configuration and TLS';
  // First navigate to the real production endpoint to verify the website's TLS
  // and published configuration before introducing the local test harness.
  const configResponse = await pages[0].goto(`${siteURL}/api/netplay/config`);
  assert.equal(configResponse.status(), 200, 'production config must respond successfully');
  assert.equal(configResponse.url(), `${siteURL}/api/netplay/config`, 'config must not redirect to another origin');
  const config = await configResponse.json();
  assert.equal(config.enabled, true, 'online play must be enabled on the production website');
  assert.equal(config.relayUrl, relayURL, 'production config must name the expected relay');
  await Promise.all(pages.map(async page => {
    await page.goto(`${siteURL}${harnessPath}`);
    await page.waitForFunction(() => Boolean(window.api));
    assert.equal(await page.evaluate(() => typeof WebTransport), 'function');
    assert.equal(await page.evaluate(() => isSecureContext), true);
  }));
  stage = 'room creation and admission';
  roomID = await pages[0].evaluate(async expectedRelay => {
    window.access = await window.api.createGame('melee', {
      seed: 123456789, fixture: 'live-four-browser-synthetic-lockstep-v1',
    });
    if (window.access.relayUrl !== expectedRelay) throw Error('Unexpected relay in game access.');
    return window.access.room.id;
  }, relayURL);
  assert.match(roomID, /^[a-f0-9]{32}$/, 'new games must receive a unique-format room ID');
  await Promise.all(pages.slice(1, 4).map(page => page.evaluate(async id => {
    window.access = await window.api.joinGame(id);
  }, roomID)));
  const rejection = await pages[4].evaluate(async id => {
    try { await window.api.joinGame(id); return ''; } catch (error) { return error.message; }
  }, roomID);
  assert.match(rejection, /four players/i, 'fifth browser must be rejected');
  const players = pages.slice(0, 4);
  stage = 'publicly trusted WebTransport connections';
  await Promise.all(players.map(page => page.evaluate(async () => {
    // The unchanged production constructor uses standard certificate validation.
    window.session = new window.api.NetplaySession(window.access);
    await window.session.connect();
  })));
  await waitState(players[0], state => state?.room.players.length === 4 && state.room.players.every(p => p.connected));
  stage = 'prepare, ready and start';
  await players[0].evaluate(() => window.session.prepare());
  await Promise.all(players.map(page => waitState(page, state => state?.room.state === 'preparing')));
  const rosters = await Promise.all(players.map(page => page.evaluate(() => window.session.room.players.map(p => p.seat))));
  for (const roster of rosters) assert.deepEqual(roster, [0, 1, 2, 3]);
  await Promise.all(players.map(page => page.evaluate(() => window.session.ready('synthetic-engine-content-and-settings-v1'))));
  await waitState(players[0], state => state?.room.players.every(p => p.ready));
  await players[0].evaluate(() => window.session.start());
  await Promise.all(players.map(page => waitState(page, state => state?.started)));
  stage = '180 confirmed ticks and independent presentation';
  const presentationRates = [30, 60, 144, null];
  const results = await Promise.all(players.map((page, index) => page.evaluate(async ({ticks, renderHz}) => {
    const {createBitmapPresenter} = await import(window.presentationURL);
    const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
    document.body.append(canvas);
    const context = canvas.getContext('bitmaprenderer');
    const source = new OffscreenCanvas(8, 8), drawing = source.getContext('2d');
    const presented = [];
    let disposed = 0;
    // Exercise the actual presentation mailbox at independently scheduled
    // display rates. The fourth browser never gets a display callback at all.
    // Input waits and synthetic simulation ticks do not call this scheduler.
    const presenter = createBitmapPresenter({
      requestFrame: callback => renderHz === null ? 1 : setTimeout(callback, 1000 / renderHz),
      cancelFrame: handle => { if (renderHz !== null) clearTimeout(handle); },
      present: snapshot => {
        context.transferFromImageBitmap(snapshot.bitmap);
        presented.push(snapshot.tick);
      },
    });
    const frames = [];
    const pad = (tick, seat) => [1 << seat, ((tick * 3 + seat) % 256) - 128,
      ((tick * 7 + seat * 2) % 256) - 128, seat * 10, -seat * 10, tick % 256, seat * 50];
    try {
      for (let tick = 0; tick < ticks; tick++) {
        const pads = await window.session.nextFrame(tick, pad(tick, window.session.seat));
        const expected = Array.from({length: 4}, (_, seat) => tick < 3 ? [0, 0, 0, 0, 0, 0, 0] : pad(tick - 3, seat));
        if (JSON.stringify(pads) !== JSON.stringify(expected)) throw Error(`Incorrect confirmed pads at tick ${tick}`);
        frames.push(pads);
        drawing.fillStyle = `rgb(${tick % 256}, ${pads[0][0] % 256}, 100)`;
        drawing.fillRect(0, 0, 8, 8);
        const bitmap = source.transferToImageBitmap();
        presenter.offer({tick, bitmap, close() { disposed++; bitmap.close(); }});
        await new Promise(resolve => setTimeout(resolve, 16));
      }
    } finally { presenter.dispose(); }
    const bytes = new TextEncoder().encode(JSON.stringify(frames));
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    return {seat: window.session.seat, ticks: frames.length, hash, error: window.session.error,
      renderHz, presented, disposed};
  }, {ticks: TICKS, renderHz: presentationRates[index]})));
  assert.equal(new Set(results.map(result => result.seat)).size, 4);
  for (const result of results) {
    assert.equal(result.ticks, TICKS); assert.equal(result.error, ''); assert.equal(result.hash, results[0].hash);
    assert.equal(result.disposed, TICKS, 'every completed image must be released exactly once');
    assert.ok(result.presented.every((tick, index, values) => index === 0 || tick > values[index - 1]), 'presentation must never go backwards');
    if (result.renderHz === null) assert.equal(result.presented.length, 0, 'simulation must finish without any display callbacks');
    else assert.ok(result.presented.length > 0 && result.presented.length <= TICKS);
  }
  stage = 'disconnect termination';
  await players[3].evaluate(() => window.session.close('Live smoke test completed.'));
  await Promise.all(players.slice(0, 3).map(async page => {
    await page.waitForFunction(() => window.session.closed && Boolean(window.session.error), null, {timeout: 15000});
    assert.match(await page.evaluate(() => window.session.error), /disconnected|closed|ended/i);
    const rejected = await page.evaluate(async () => {
      try { await window.session.nextFrame(180, [0, 0, 0, 0, 0, 0, 0]); return false; } catch { return true; }
    });
    assert.equal(rejected, true, 'disconnected matches must stop simulation');
  }));
  const endedRoom = await players[0].evaluate(async ({relayURL, roomID}) => {
    return window.api.readJson(await fetch(`${relayURL}/v1/rooms/${roomID}`, {
      cache: 'no-store', credentials: 'omit',
    }));
  }, {relayURL, roomID});
  assert.equal(endedRoom.state, 'ended', 'the smoke test must end its own room');
  console.log(JSON.stringify({ok: true, synthetic: true, site: siteURL, relay: relayURL,
    browser: browserVersion, certificateValidation: 'normal-public-trust', players: 4, ticks: TICKS,
    frameHash: results[0].hash,
    presentation: results.map(({renderHz, presented, disposed}) => ({renderHz, images: presented.length, released: disposed})),
    simulationIndependentOfPresentation: true, fifthPlayerRejected: true,
    disconnectStoppedAll: true, testRoomEnded: true}, null, 2));
} catch (error) {
  console.error(`Live smoke failed during ${stage}.`);
  console.error('Browser diagnostics:', browserLogs.slice(-12));
  throw error;
} finally {
  await Promise.allSettled(pages.map(page => page.evaluate(() => {
    window.session?.close('Live smoke cleanup.');
    if (window.access?.room?.id) window.api?.forgetAccess(window.access.room.id);
  })));
  await browser?.close();
}
