import assert from 'node:assert/strict';
import test from 'node:test';
import { proxyRequest } from './worker.mjs';

const env = {
  SITE_ORIGIN: 'https://smash.not.fun',
  CLOUD_RUN_ORIGIN: 'https://opensmash-123456789.us-central1.run.app',
};

const request = (path = '/', options) => new Request(`${env.SITE_ORIGIN}${path}`, options);

test('streams POST body and preserves path, query, credentials, and browser origin', async () => {
  let calls = 0;
  const response = await proxyRequest(request('/api/melee/prepare?game=a%2Fb', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'session=secret',
      Authorization: 'Bearer another-secret',
      Origin: env.SITE_ORIGIN,
    },
    body: '{"fighters":["fox"]}',
  }), env, async (upstream) => {
    calls++;
    assert.equal(upstream.url, `${env.CLOUD_RUN_ORIGIN}/api/melee/prepare?game=a%2Fb`);
    assert.equal(upstream.method, 'POST');
    assert.equal(await upstream.text(), '{"fighters":["fox"]}');
    assert.equal(upstream.headers.get('cookie'), 'session=secret');
    assert.equal(upstream.headers.get('authorization'), 'Bearer another-secret');
    assert.equal(upstream.headers.get('origin'), env.SITE_ORIGIN);
    assert.equal(upstream.redirect, 'manual');
    assert.equal(upstream.cache, 'no-store');
    return new Response('prepared', { status: 202 });
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 202);
  assert.equal(await response.text(), 'prepared');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('overwrites spoofed proxy headers with configured hostname and Cloudflare client IP', async () => {
  await proxyRequest(request('/', { headers: {
    Host: 'attacker.example',
    Forwarded: 'host=attacker.example;proto=http',
    'X-Forwarded-Host': 'attacker.example',
    'X-Forwarded-Proto': 'http',
    'X-Forwarded-Port': '80',
    'X-Forwarded-For': 'spoofed, 127.0.0.1',
    'CF-Connecting-IP': '2001:db8::1',
  } }), env, async (upstream) => {
    assert.equal(upstream.headers.get('host'), null);
    assert.equal(upstream.headers.get('forwarded'), null);
    assert.equal(upstream.headers.get('x-forwarded-host'), 'smash.not.fun');
    assert.equal(upstream.headers.get('x-forwarded-proto'), 'https');
    assert.equal(upstream.headers.get('x-forwarded-port'), '443');
    assert.equal(upstream.headers.get('x-forwarded-for'), '2001:db8::1');
    return new Response('ok');
  });
  await proxyRequest(request('/', { headers: { 'X-Forwarded-For': 'spoofed' } }), env, async (upstream) => {
    assert.equal(upstream.headers.get('x-forwarded-for'), null);
    return new Response('ok');
  });
});

test('keeps isolation headers, range response metadata, and separate Set-Cookie values', async () => {
  const headers = new Headers({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Range': 'bytes 0-3/100',
    'Cache-Control': 'public, max-age=86400',
  });
  headers.append('Set-Cookie', 'session=one; Path=/; HttpOnly; Secure; SameSite=Lax');
  headers.append('Set-Cookie', 'nonce=two; Path=/; HttpOnly; Secure; SameSite=Lax');
  const response = await proxyRequest(request('/engine/game.wasm', {
    headers: { Range: 'bytes=0-3' },
  }), env, async (upstream) => {
    assert.equal(upstream.headers.get('range'), 'bytes=0-3');
    return new Response('wasm', { status: 206, headers });
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('content-range'), 'bytes 0-3/100');
  assert.deepEqual(response.headers.getSetCookie(), headers.getSetCookie());
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('does not share API or authenticated responses but preserves public browser asset caching', async () => {
  for (const input of [request('/api'), request('/api/me'), request('/engine/asset', {
    headers: { Cookie: 'session=secret' },
  }), request('/', { headers: { Authorization: 'Bearer secret' } })]) {
    const response = await proxyRequest(input, env, async () => new Response('private', {
      headers: { 'Cache-Control': 'public, max-age=600' },
    }));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
    assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  }
  const publicAsset = await proxyRequest(request('/engine/game.wasm'), env, async () => new Response('wasm', {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  }));
  assert.equal(publicAsset.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(publicAsset.headers.get('cloudflare-cdn-cache-control'), 'no-store');
});

test('returns redirects to the browser without following them or exposing the run.app hostname', async () => {
  for (const [location, expected] of [
    ['/login?next=%2F', `${env.SITE_ORIGIN}/login?next=%2F`],
    [`${env.CLOUD_RUN_ORIGIN}/login`, `${env.SITE_ORIGIN}/login`],
    ['https://accounts.example/login', 'https://accounts.example/login'],
  ]) {
    let calls = 0;
    const response = await proxyRequest(request('/api/me', { headers: { Cookie: 'session=secret' } }), env,
      async (upstream) => {
        calls++;
        assert.equal(upstream.redirect, 'manual');
        return new Response(null, { status: 302, headers: { Location: location } });
      });
    assert.equal(calls, 1);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), expected);
  }
});

test('fails closed for missing, insecure, credentialed, non-origin, and non-Cloud-Run configuration', async () => {
  for (const bad of ['', undefined, 'http://service.run.app', 'https://other.example',
    'https://service.run.app.attacker.example', 'https://user:pass@service.run.app',
    'https://service.run.app:8443', 'https://service.run.app/path',
    'https://service.run.app/?key=secret', 'https://service.run.app/#fragment']) {
    const response = await proxyRequest(request(), { ...env, CLOUD_RUN_ORIGIN: bad },
      () => { throw new Error('must not call origin'); });
    assert.equal(response.status, 503, String(bad));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const bad of ['', 'http://smash.not.fun', `${env.SITE_ORIGIN}/path`, env.CLOUD_RUN_ORIGIN]) {
    const response = await proxyRequest(request(), { ...env, SITE_ORIGIN: bad },
      () => { throw new Error('must not call origin'); });
    assert.equal(response.status, 503);
  }
});

test('rejects an unexpected public hostname and cannot be used as an open proxy', async () => {
  const response = await proxyRequest(new Request('https://other.example/'), env,
    () => { throw new Error('must not call origin'); });
  assert.equal(response.status, 421);
  await proxyRequest(request('//attacker.example/somewhere?origin=https://evil.example'), env,
    async (upstream) => {
      assert.equal(new URL(upstream.url).origin, env.CLOUD_RUN_ORIGIN);
      assert.equal(new URL(upstream.url).pathname, '//attacker.example/somewhere');
      return new Response('ok');
    });
});

test('handles a HEAD response and reports network failures without origin details', async () => {
  const head = await proxyRequest(request('/engine/game.wasm', { method: 'HEAD' }), env,
    async (upstream) => {
      assert.equal(upstream.method, 'HEAD');
      assert.equal(upstream.body, null);
      return new Response(null, { status: 200, headers: { 'Content-Length': '1024' } });
    });
  assert.equal(head.body, null);
  assert.equal(head.headers.get('content-length'), '1024');
  const failed = await proxyRequest(request(), env, async () => {
    throw new Error('internal origin and credential details');
  });
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /credential|run\.app/);
});

test('redirects the public HTTP hostname to HTTPS without proxying credentials', async () => {
  const response = await proxyRequest(new Request('http://smash.not.fun/?game=abc'), env,
    () => { throw new Error('must not call origin'); });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://smash.not.fun/?game=abc');
});
