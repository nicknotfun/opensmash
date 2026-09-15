import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOutput, createCloudflareAPI, parseArguments, provision, readToken, WIDGET_NAME, writePrivateOutput } from './provision.mjs';

const ACCOUNT = 'a'.repeat(32);
const ZONE = 'b'.repeat(32);
const SECRET = 'test-only-turnstile-secret-'.repeat(2);
const TOKEN = 'test-only-api-token-'.repeat(2);
const widget = { name: WIDGET_NAME, domains: ['smash.not.fun'], mode: 'managed', clearance_level: 'no_clearance', sitekey: '0xTestOnlySitekey', secret: SECRET };

async function fixture(t, changes = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'opensmash-cf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { accountId: ACCOUNT, output: join(directory, 'secrets.json'), relayIP: '203.0.113.7', meleeIP: '2001:db8::5' };
  const calls = [], logs = [], saved = [];
  const records = new Map();
  const state = { widgets: [], ...changes };
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const url = new URL(path, 'https://api.example');
    if (method === 'GET' && url.pathname === `/accounts/${ACCOUNT}`) return { result: { id: ACCOUNT, name: 'Selected account' } };
    if (url.pathname === '/zones') return { result: [{ id: ZONE, name: 'not.fun', account: { id: ACCOUNT }, status: state.zoneStatus || 'active' }] };
    if (url.pathname.endsWith('/challenges/widgets') && method === 'GET') return { result: state.widgets };
    if (url.pathname.endsWith('/challenges/widgets') && method === 'POST') return { result: { ...widget, ...body } };
    if (url.pathname.includes('/challenges/widgets/')) return { result: { ...widget, ...body } };
    if (url.pathname.endsWith('/dns_records') && method === 'GET') return { result: records.get(url.searchParams.get('name')) || [] };
    if (url.pathname.endsWith('/dns_records') && method === 'POST') { records.set(body.name, [body]); return { result: body }; }
    throw new Error(`Unexpected mocked API request: ${method} ${path}`);
  };
  return { options, calls, logs, saved, records, state, dependencies: {
    api, log: entry => logs.push(entry), save: async (path, value) => saved.push({ path, value }),
  } };
}

test('dry run reads account, zone, widget, and DNS metadata without mutations or secret retrieval', async t => {
  const f = await fixture(t);
  const plan = await provision({ ...f.options, dryRun: true }, f.dependencies);
  assert.equal(plan.turnstile.action, 'create');
  assert.deepEqual(plan.turnstile.configuration.domains, ['smash.not.fun']);
  assert.deepEqual(plan.dns.map(item => [item.record.name, item.record.type, item.record.proxied]), [
    ['relay.smash.not.fun', 'A', false], ['melee-service.smash.not.fun', 'AAAA', false],
  ]);
  assert(f.calls.every(call => call.method === 'GET'));
  assert.equal(f.saved.length, 0);
  assert.doesNotMatch(JSON.stringify(f.logs), new RegExp(`${SECRET}|${TOKEN}`));
});

test('creates the owned widget and DNS-only records and sends secrets only to the explicit output', async t => {
  const f = await fixture(t);
  await provision(f.options, f.dependencies);
  assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => call.body.name), [
    WIDGET_NAME, 'relay.smash.not.fun', 'melee-service.smash.not.fun',
  ]);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].path, f.options.output);
  assert.deepEqual(f.saved[0].value.turnstile, { sitekey: widget.sitekey, secret: SECRET });
  assert.doesNotMatch(JSON.stringify(f.logs), new RegExp(SECRET));
});

test('keeps exact DNS and widgets on rerun, retrieving the existing widget secret without rotation', async t => {
  const f = await fixture(t, { widgets: [widget] });
  f.records.set('relay.smash.not.fun', [{ name: 'relay.smash.not.fun', type: 'A', content: f.options.relayIP, proxied: false, ttl: 3600 }]);
  f.records.set('melee-service.smash.not.fun', [{ name: 'melee-service.smash.not.fun', type: 'AAAA', content: '2001:0db8:0:0:0:0:0:5', proxied: false }]);
  await provision(f.options, f.dependencies);
  assert(f.calls.every(call => call.method === 'GET'));
  assert.equal(f.saved[0].value.turnstile.secret, SECRET);
});

test('updates only the exact owned widget and narrows its domains without affecting another widget', async t => {
  const f = await fixture(t, { widgets: [
    { ...widget, name: 'unrelated production widget', sitekey: '0xUnrelatedSitekey' },
    { ...widget, domains: ['old.example'], clearance_level: 'managed' },
  ] });
  await provision({ ...f.options, relayIP: undefined, meleeIP: undefined }, f.dependencies);
  const mutation = f.calls.filter(call => call.method !== 'GET');
  assert.equal(mutation.length, 1);
  assert.equal(mutation[0].method, 'PUT');
  assert(mutation[0].path.endsWith(`/${widget.sitekey}`));
  assert.deepEqual(mutation[0].body, { name: WIDGET_NAME, domains: ['smash.not.fun'], mode: 'managed', clearance_level: 'no_clearance' });
});

test('conflicting DNS, duplicate owned widgets, and wrong zones fail before any mutation', async t => {
  for (const conflicting of [
    { name: 'relay.smash.not.fun', type: 'A', content: '203.0.113.8', proxied: false },
    { name: 'relay.smash.not.fun', type: 'A', content: '203.0.113.7', proxied: true },
    { name: 'relay.smash.not.fun', type: 'CNAME', content: 'another.example', proxied: false },
  ]) {
    const f = await fixture(t);
    f.records.set('relay.smash.not.fun', [conflicting]);
    await assert.rejects(provision(f.options, f.dependencies), /Conflicting DNS/);
    assert(f.calls.every(call => call.method === 'GET'));
    assert.equal(f.saved.length, 0);
  }
  for (const state of [{ widgets: [widget, widget] }, { zoneStatus: 'pending' }]) {
    const f = await fixture(t, state);
    await assert.rejects(provision(f.options, f.dependencies));
    assert(f.calls.every(call => call.method === 'GET'));
  }
});

test('private outputs are mode 0600 and cannot overwrite unrelated files or enter the repository', async t => {
  const f = await fixture(t);
  const data = { managedBy: 'opensmash-cloudflare-provision-v1', accountId: ACCOUNT, siteOrigin: 'https://smash.not.fun', turnstile: { sitekey: widget.sitekey, secret: SECRET } };
  await writePrivateOutput(f.options.output, data);
  assert.equal((await stat(f.options.output)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(f.options.output, 'utf8')), data);
  await writePrivateOutput(f.options.output, data);
  await assert.rejects(checkOutput(new URL('./secret.json', import.meta.url).pathname, ACCOUNT), /outside/);
  const unrelated = join(f.options.output, '..', 'unrelated.json');
  await writeFile(unrelated, '{"another":"deployment"}', { mode: 0o600 });
  await assert.rejects(checkOutput(unrelated, ACCOUNT), /unsafe|another/);
  const link = join(f.options.output, '..', 'link.json');
  await symlink(f.options.output, link);
  await assert.rejects(checkOutput(link, ACCOUNT), /unsafe/);
});

test('token input accepts private files or environment and rejects publicly readable files and inline arguments', async t => {
  const f = await fixture(t);
  const tokenFile = join(f.options.output, '..', 'token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  assert.equal(await readToken({ tokenFile }), TOKEN);
  assert.equal(await readToken({ environment: { CLOUDFLARE_API_TOKEN: TOKEN } }), TOKEN);
  await chmod(tokenFile, 0o644);
  await assert.rejects(readToken({ tokenFile }), /private/);
  assert.throws(() => parseArguments(['--token', TOKEN], {}), /Invalid/);
  await assert.rejects(readToken({ environment: {} }), /CLOUDFLARE_API_TOKEN/);
});

test('API errors never log or repeat response content, tokens, or redirect to another host', async () => {
  const api = createCloudflareAPI(TOKEN, async (url, options) => {
    assert(url.startsWith('https://api.cloudflare.com/client/v4/'));
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    return new Response(JSON.stringify({ success: false, errors: [{ message: SECRET }] }), { status: 403 });
  });
  await assert.rejects(api('GET', '/accounts/example'), error => {
    assert.match(error.message, /HTTP 403/);
    assert(!error.message.includes(SECRET));
    assert(!error.message.includes(TOKEN));
    return true;
  });
  const redirected = createCloudflareAPI(TOKEN, async () => { throw new Error(`${SECRET} ${TOKEN}`); });
  await assert.rejects(redirected('GET', '/accounts/example'), error => !error.message.includes(SECRET) && !error.message.includes(TOKEN));
});


test('rechecks DNS immediately before creation and refuses a concurrent conflicting record', async t => {
  const f = await fixture(t);
  const save = f.dependencies.save;
  f.dependencies.save = async (...args) => {
    await save(...args);
    f.records.set('relay.smash.not.fun', [{ name: 'relay.smash.not.fun', type: 'A', content: '203.0.113.99', proxied: false }]);
  };
  await assert.rejects(provision(f.options, f.dependencies), /Conflicting DNS/);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/dns_records')).length, 0);
  assert.equal(f.saved.length, 1, 'new widget credentials remain available after a later DNS conflict');
});

test('follows widget pagination before deciding whether an owned widget exists', async t => {
  const f = await fixture(t);
  const api = f.dependencies.api;
  const seenPages = [];
  f.dependencies.api = async (method, path, body) => {
    const url = new URL(path, 'https://api.example');
    if (url.pathname.endsWith('/challenges/widgets')) {
      const page = Number(url.searchParams.get('page'));
      seenPages.push(page);
      return { result: page === 1 ? Array.from({ length: 50 }, (_, index) => ({ name: `Unrelated ${index}` })) : [widget], result_info: { total_count: 51 } };
    }
    return api(method, path, body);
  };
  const plan = await provision({ ...f.options, dryRun: true }, f.dependencies);
  assert.deepEqual(seenPages, [1, 2]);
  assert.equal(plan.turnstile.action, 'keep');
});
