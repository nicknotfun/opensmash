#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const API = 'https://api.cloudflare.com/client/v4';
const ZONE = 'not.fun';
const HOST = 'smash.not.fun';
const OWNER = 'opensmash-cloudflare-provision-v1';
export const WIDGET_NAME = `opensmash:${HOST}`;
const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));
const widgetConfig = { name: WIDGET_NAME, domains: [HOST], mode: 'managed', clearance_level: 'no_clearance' };

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function outside(path, root) {
  const part = relative(root, path);
  return part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part);
}

async function existingOutput(path, accountId) {
  try {
    const stat = await lstat(path);
    ensure(stat.isFile() && (stat.mode & 0o077) === 0, 'Existing output must be a private regular file.');
    const data = JSON.parse(await readFile(path, 'utf8'));
    ensure(data.managedBy === OWNER && data.accountId === accountId && data.siteOrigin === `https://${HOST}`,
      'Refusing to overwrite an unrelated output file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Existing output is unsafe or belongs to another deployment.');
  }
}

export async function checkOutput(path, accountId, repository = REPOSITORY) {
  ensure(typeof path === 'string' && isAbsolute(path), '--output must be an absolute path outside the repository.');
  const parent = await realpath(dirname(path));
  const root = await realpath(repository);
  const destination = join(parent, basename(path));
  ensure(outside(destination, root), 'Secret output must be outside the repository.');
  await access(parent, constants.W_OK);
  await existingOutput(destination, accountId);
  return destination;
}

export async function writePrivateOutput(path, data) {
  await existingOutput(path, data.accountId);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
  } finally {
    if (file) await file.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function readToken({ tokenFile, environment = process.env }) {
  let token;
  if (tokenFile) {
    ensure(isAbsolute(tokenFile), '--token-file must be an absolute path.');
    const file = await open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      ensure(stat.isFile() && (stat.mode & 0o077) === 0 && stat.size <= 16384,
        'Token file must be a small private regular file (mode 0600).');
      token = await file.readFile('utf8');
    } finally { await file.close(); }
  } else token = environment.CLOUDFLARE_API_TOKEN;
  ensure(typeof token === 'string' && /^\S{20,4096}$/.test(token.trim()),
    'Set CLOUDFLARE_API_TOKEN or provide a private --token-file.');
  return token.trim();
}

export function createCloudflareAPI(token, fetchImpl = fetch) {
  return async (method, path, body) => {
    ensure(path.startsWith('/') && !path.startsWith('//'), 'Invalid API path.');
    let response, data;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      data = await response.json();
    } catch { throw new Error(`Cloudflare ${method} request failed; no credentials or response body were logged.`); }
    ensure(response.ok && data.success === true,
      `Cloudflare ${method} request failed (HTTP ${response.status}); check token scope and account access.`);
    return data;
  };
}

async function list(api, path) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const separator = path.includes('?') ? '&' : '?';
    const data = await api('GET', `${path}${separator}page=${page}&per_page=50`);
    ensure(Array.isArray(data.result), 'Cloudflare returned an invalid resource list.');
    items.push(...data.result);
    const total = data.result_info?.total_count;
    const pages = data.result_info?.total_pages;
    if ((Number.isInteger(total) && items.length >= total) ||
        (Number.isInteger(pages) && page >= pages) ||
        (total === undefined && pages === undefined && data.result.length < 50)) return items;
    ensure(data.result.length > 0, 'Cloudflare returned incomplete resource pagination.');
  }
  throw new Error('Cloudflare resource pagination exceeded the safety limit.');
}

function ip(value) {
  const version = isIP(value);
  ensure(version > 0, 'DNS targets must be literal IPv4 or IPv6 addresses.');
  return { type: version === 4 ? 'A' : 'AAAA', content: version === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value };
}

function dnsState(records, desired) {
  if (records.length === 0) return 'create';
  const record = records[0];
  let content;
  try { content = ip(record.content).content; } catch { /* A CNAME or other record is a conflict. */ }
  ensure(records.length === 1 && record.name === desired.name && record.type === desired.type &&
    content === desired.content && record.proxied === false,
  `Conflicting DNS record at ${desired.name}; no existing record will be overwritten.`);
  return 'keep';
}

function matchingWidget(widget) {
  return widget?.name === WIDGET_NAME && widget.mode === 'managed' && widget.clearance_level === 'no_clearance' &&
    Array.isArray(widget.domains) && widget.domains.length === 1 && widget.domains[0] === HOST;
}

function widgetPath(base, widget) {
  ensure(typeof widget?.sitekey === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(widget.sitekey), 'Cloudflare returned an invalid Turnstile sitekey.');
  return `${base}/${widget.sitekey}`;
}

export async function provision(options, { api, save = writePrivateOutput, log = value => console.log(JSON.stringify(value, null, 2)) }) {
  ensure(/^[a-f0-9]{32}$/.test(options.accountId || ''), '--account-id must be a Cloudflare account ID.');
  const output = await checkOutput(options.output, options.accountId);
  const desiredDNS = [];
  for (const [name, value] of [[`relay.${HOST}`, options.relayIP], [`melee-service.${HOST}`, options.meleeIP]]) {
    if (value !== undefined) desiredDNS.push({ name, ...ip(value), proxied: false, ttl: 300, comment: 'Managed by OpenSmash deployment' });
  }
  const account = (await api('GET', `/accounts/${options.accountId}`)).result;
  ensure(account?.id === options.accountId, 'Cloudflare returned an unexpected account.');
  const zones = await list(api, `/zones?name=${ZONE}&account.id=${options.accountId}`);
  ensure(zones.length === 1 && zones[0].name === ZONE && zones[0].account?.id === options.accountId &&
    zones[0].status === 'active' && /^[a-f0-9]{32}$/.test(zones[0].id),
  'The selected account must own exactly one active not.fun zone.');
  const zone = zones[0];
  const base = `/accounts/${options.accountId}/challenges/widgets`;
  const widgets = (await list(api, base)).filter(widget => widget.name === WIDGET_NAME);
  ensure(widgets.length <= 1, 'Multiple owned Turnstile widgets exist; select the intended widget manually.');
  const existing = widgets[0];
  if (existing) widgetPath(base, existing);
  const action = !existing ? 'create' : matchingWidget(existing) ? 'keep' : 'update';
  const dnsPlans = [];
  // Complete conflict checks before making the first mutation.
  for (const desired of desiredDNS) {
    const records = await list(api, `/zones/${zone.id}/dns_records?name=${encodeURIComponent(desired.name)}`);
    dnsPlans.push({ action: dnsState(records, desired), record: desired });
  }
  const plan = { dryRun: Boolean(options.dryRun), accountId: account.id, zone: ZONE,
    turnstile: { action, configuration: widgetConfig }, dns: dnsPlans, secretOutput: output };
  log(plan);
  if (options.dryRun) return plan;

  let widget;
  if (action === 'create') widget = (await api('POST', base, widgetConfig)).result;
  else if (action === 'update') widget = (await api('PUT', widgetPath(base, existing), widgetConfig)).result;
  else widget = (await api('GET', widgetPath(base, existing))).result;
  ensure(matchingWidget(widget), 'Cloudflare returned unexpected Turnstile configuration.');
  widgetPath(base, widget);
  ensure(typeof widget.secret === 'string' && /^\S{20,4096}$/.test(widget.secret), 'Cloudflare did not return a valid widget secret.');
  await save(output, { managedBy: OWNER, accountId: account.id, zoneId: zone.id, siteOrigin: `https://${HOST}`,
    turnstile: { sitekey: widget.sitekey, secret: widget.secret } });

  for (const { action: dnsAction, record } of dnsPlans) {
    if (dnsAction === 'keep') continue;
    // A concurrent DNS change is a conflict, never permission to overwrite it.
    const current = await list(api, `/zones/${zone.id}/dns_records?name=${encodeURIComponent(record.name)}`);
    if (dnsState(current, record) === 'create') await api('POST', `/zones/${zone.id}/dns_records`, record);
  }
  log({ complete: true, sitekey: widget.sitekey, secretOutput: output });
  return plan;
}

export function parseArguments(args, environment = process.env) {
  const options = { accountId: environment.CLOUDFLARE_ACCOUNT_ID };
  const names = { '--account-id': 'accountId', '--token-file': 'tokenFile', '--output': 'output', '--relay-ip': 'relayIP', '--melee-ip': 'meleeIP' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') { options.dryRun = true; continue; }
    if (args[i] === '--help') { options.help = true; continue; }
    const key = names[args[i]];
    ensure(key && args[i + 1] && !args[i + 1].startsWith('--'), 'Invalid or incomplete command argument; use --help.');
    options[key] = args[++i];
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: provision.mjs --account-id ID --output /private/path/cloudflare.json [--token-file /private/token] [--relay-ip IP] [--melee-ip IP] [--dry-run]\nToken: CLOUDFLARE_API_TOKEN or private token file. Output directory must already exist outside the repository.');
    return;
  }
  const token = await readToken(options);
  await provision(options, { api: createCloudflareAPI(token) });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
