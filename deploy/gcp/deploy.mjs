#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolve4, resolve6 } from 'node:dns/promises';
import { isIPv4 } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
function requireMatch(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
export function configuration(options) {
  const project = requireMatch(options.project, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'project ID');
  const zone = requireMatch(options.zone ?? 'us-central1-a', /^[a-z]+-[a-z]+[0-9]+-[a-z]$/, 'zone');
  const region = zone.slice(0, -2);
  const hostname = (value, label) => requireMatch(value, /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, label);
  const host = hostname(options.host ?? 'smash.not.fun', 'site hostname');
  const relayHost = hostname(options['relay-host'] ?? `relay.${host}`, 'relay hostname');
  const meleeHost = hostname(options['melee-host'] ?? `melee-service.${host}`, 'Melee hostname');
  if (new Set([host, relayHost, meleeHost]).size !== 3) throw new Error('Site, relay and Melee hostnames must differ');
  let assetOrigin = null;
  if (options['asset-origin']) {
    const parsed = new URL(options['asset-origin']);
    if (parsed.protocol !== 'https:' || parsed.origin !== options['asset-origin'] || parsed.username || parsed.password) throw new Error('Asset origin must be an exact HTTPS origin without a path or credentials');
    hostname(parsed.hostname, 'asset origin hostname');
    assetOrigin = parsed.origin;
  }
  const sourceOrigins = [...new Set([`https://${host}`, ...(assetOrigin ? [assetOrigin] : [])])].join(',');
  const email = requireMatch(options.email, /^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/, 'ACME email');
  const registry = `${region}-docker.pkg.dev`;
  const image = (value, name) => {
    const prefix = `${registry}/${project}/opensmash/${name}@sha256:`;
    if (typeof value !== 'string' || !value.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(value.slice(prefix.length))) {
      throw new Error(`${name} image must be a digest-pinned image in ${registry}/${project}/opensmash/${name}`);
    }
    return value;
  };
  const relayImage = image(options['relay-image'], 'relay');
  const meleeImage = options['melee-image'] ? image(options['melee-image'], 'melee') : null;
  const tokenSecret = requireMatch(options['melee-token-secret'] ?? 'opensmash-melee-token', /^[A-Za-z0-9_-]{1,255}$/, 'Melee token secret');
  return { project, zone, region, host, relayHost, meleeHost, email, registry, relayImage, meleeImage, tokenSecret, sourceOrigins };
}

export function startupScripts(config) {
  const values = {
    PROJECT_ID: config.project, RELAY_IMAGE: config.relayImage, RELAY_HOST: config.relayHost,
    SITE_ORIGIN: `https://${config.host}`, ACME_EMAIL: config.email, REGISTRY: config.registry,
    MELEE_IMAGE: config.meleeImage, MELEE_HOST: config.meleeHost, TOKEN_SECRET: config.tokenSecret, SOURCE_ORIGINS: config.sourceOrigins,
  };
  const render = name => readFileSync(join(here, `${name}-startup.sh.tmpl`), 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (values[key] == null) throw new Error(`Missing ${key}`);
    return values[key];
  });
  return { relay: render('relay'), melee: config.meleeImage ? render('melee') : null };
}

export function deploymentPlan(config, outputDirectory) {
  const steps = [];
  const command = (phase, args, exists = null) => steps.push({ phase, args: [...args, '--project', config.project, '--quiet'], exists: exists && [...exists, '--project', config.project] });
  const prepare = (args, exists) => command('prepare', args, exists);
  prepare(['services', 'enable', 'compute.googleapis.com', 'artifactregistry.googleapis.com', 'secretmanager.googleapis.com', 'iap.googleapis.com']);
  prepare(['compute', 'networks', 'create', 'opensmash', '--subnet-mode=custom'], ['compute', 'networks', 'describe', 'opensmash']);
  prepare(['compute', 'networks', 'subnets', 'create', 'opensmash', '--network=opensmash', `--region=${config.region}`, '--range=10.42.0.0/24', '--enable-private-ip-google-access'], ['compute', 'networks', 'subnets', 'describe', 'opensmash', `--region=${config.region}`]);
  prepare(['compute', 'firewall-rules', 'create', 'opensmash-relay-public', '--network=opensmash', '--direction=INGRESS', '--action=ALLOW', '--rules=tcp:80,tcp:443,udp:443', '--source-ranges=0.0.0.0/0', '--target-tags=opensmash-relay'], ['compute', 'firewall-rules', 'describe', 'opensmash-relay-public']);
  prepare(['compute', 'firewall-rules', 'create', 'opensmash-iap-ssh', '--network=opensmash', '--direction=INGRESS', '--action=ALLOW', '--rules=tcp:22', '--source-ranges=35.235.240.0/20', '--target-tags=opensmash-relay,opensmash-melee'], ['compute', 'firewall-rules', 'describe', 'opensmash-iap-ssh']);
  const serviceAccount = name => `${name}@${config.project}.iam.gserviceaccount.com`;
  const service = (name, phase, imageType) => {
    prepare(['iam', 'service-accounts', 'create', name, `--display-name=${name}`], ['iam', 'service-accounts', 'describe', serviceAccount(name)]);
    prepare(['artifacts', 'repositories', 'add-iam-policy-binding', 'opensmash', `--location=${config.region}`, `--member=serviceAccount:${serviceAccount(name)}`, '--role=roles/artifactregistry.reader']);
    prepare(['compute', 'addresses', 'create', name, `--region=${config.region}`], ['compute', 'addresses', 'describe', name, `--region=${config.region}`]);
    const args = ['compute', 'instances', 'create', name, `--zone=${config.zone}`, `--machine-type=${imageType === 'relay' ? 'e2-small' : 'e2-standard-2'}`, '--subnet=opensmash', `--address=${name}`, `--tags=${name}`, `--service-account=${serviceAccount(name)}`, '--scopes=https://www.googleapis.com/auth/cloud-platform', '--image-family=debian-12', '--image-project=debian-cloud', '--boot-disk-size=30GB', '--boot-disk-type=pd-balanced', '--shielded-secure-boot', '--labels=app=opensmash,managed-by=opensmash-deploy', '--metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE', `--metadata-from-file=startup-script=${join(outputDirectory, `${imageType}-startup.sh`)}`];
    if (imageType === 'melee') args.push('--disk=name=opensmash-melee-data,device-name=opensmash-melee-data,mode=rw,boot=no,auto-delete=no');
    command(phase, args, ['compute', 'instances', 'describe', name, `--zone=${config.zone}`]);
  };
  service('opensmash-relay', 'launch-relay', 'relay');
  if (config.meleeImage) {
    prepare(['compute', 'firewall-rules', 'create', 'opensmash-melee-public', '--network=opensmash', '--direction=INGRESS', '--action=ALLOW', '--rules=tcp:80,tcp:443', '--source-ranges=0.0.0.0/0', '--target-tags=opensmash-melee'], ['compute', 'firewall-rules', 'describe', 'opensmash-melee-public']);
    prepare(['compute', 'disks', 'create', 'opensmash-melee-data', `--zone=${config.zone}`, '--type=pd-balanced', '--size=100GB', '--labels=app=opensmash,managed-by=opensmash-deploy'], ['compute', 'disks', 'describe', 'opensmash-melee-data', `--zone=${config.zone}`]);
    service('opensmash-melee', 'launch-melee', 'melee');
    prepare(['secrets', 'add-iam-policy-binding', config.tokenSecret, `--member=serviceAccount:${serviceAccount('opensmash-melee')}`, '--role=roles/secretmanager.secretAccessor']);
  }
  return steps;
}

export function checkProject(resource, config) {
  if (resource.projectId !== config.project || resource.labels?.app !== 'opensmash' || resource.labels?.['managed-by'] !== 'opensmash-deploy') {
    throw new Error('Refusing cloud changes: project must belong to this deployment (app=opensmash, managed-by=opensmash-deploy)');
  }
}

export function checkExisting(step, resource, config, scripts) {
  const args = step.exists;
  const fail = () => { throw new Error(`Existing resource differs from this deployment: ${args.slice(0, -2).join(' ')}. Inspect it before continuing.`); };
  const same = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  const owned = () => resource.labels?.app === 'opensmash' && resource.labels?.['managed-by'] === 'opensmash-deploy';
  const link = (value, suffix) => typeof value === 'string' && value.endsWith(`/projects/${config.project}/${suffix}`);
  const flag = name => step.args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
  if (args[0] === 'iam') {
    if (resource.email !== args[3] || resource.disabled) fail();
  } else if (args[1] === 'networks' && args[2] === 'describe') {
    if (!link(resource.selfLink, 'global/networks/opensmash') || resource.autoCreateSubnetworks !== false) fail();
  } else if (args[1] === 'networks' && args[2] === 'subnets') {
    if (!link(resource.selfLink, `regions/${config.region}/subnetworks/opensmash`) || !link(resource.network, 'global/networks/opensmash') || resource.ipCidrRange !== '10.42.0.0/24' || resource.privateIpGoogleAccess !== true) fail();
  } else if (args[1] === 'firewall-rules') {
    const allowed = (resource.allowed ?? []).flatMap(rule => (rule.ports ?? ['*']).map(port => `${rule.IPProtocol}:${port}`));
    if (!link(resource.network, 'global/networks/opensmash') || resource.direction !== 'INGRESS' || resource.priority !== 1000 || resource.disabled || (resource.denied ?? []).length || !same(allowed, flag('--rules').split(',')) || !same(resource.sourceRanges ?? [], flag('--source-ranges').split(',')) || !same(resource.targetTags ?? [], flag('--target-tags').split(',')) || (resource.sourceTags ?? []).length || (resource.sourceServiceAccounts ?? []).length || (resource.targetServiceAccounts ?? []).length) fail();
  } else if (args[1] === 'addresses') {
    if (!link(resource.selfLink, `regions/${config.region}/addresses/${args[3]}`) || resource.addressType !== 'EXTERNAL' || (resource.ipVersion && resource.ipVersion !== 'IPV4') || resource.networkTier !== 'PREMIUM' || !isIPv4(resource.address) || (resource.users ?? []).some(user => !link(user, `zones/${config.zone}/instances/${args[3]}`))) fail();
  } else if (args[1] === 'disks') {
    if (!owned() || !link(resource.selfLink, `zones/${config.zone}/disks/opensmash-melee-data`) || !link(resource.type, `zones/${config.zone}/diskTypes/pd-balanced`) || Number(resource.sizeGb) !== 100 || (resource.users ?? []).some(user => !link(user, `zones/${config.zone}/instances/opensmash-melee`))) fail();
  } else if (args[1] === 'instances') {
    const kind = args[3] === 'opensmash-relay' ? 'relay' : 'melee';
    const metadata = Object.fromEntries((resource.metadata?.items ?? []).map(item => [item.key, item.value]));
    const nic = resource.networkInterfaces?.[0];
    const accounts = resource.serviceAccounts ?? [];
    if (!owned() || !link(resource.machineType, `zones/${config.zone}/machineTypes/${flag('--machine-type')}`) || !same(resource.tags?.items ?? [], [args[3]]) || resource.networkInterfaces?.length !== 1 || !link(nic?.network, 'global/networks/opensmash') || !link(nic?.subnetwork, `regions/${config.region}/subnetworks/opensmash`) || nic?.accessConfigs?.length !== 1 || nic.accessConfigs[0].natIP !== config.expectedAddress || accounts.length !== 1 || accounts[0].email !== flag('--service-account') || !same(accounts[0].scopes ?? [], ['https://www.googleapis.com/auth/cloud-platform']) || metadata['enable-oslogin'] !== 'TRUE' || metadata['block-project-ssh-keys'] !== 'TRUE' || metadata['startup-script'] !== scripts[kind] || resource.shieldedInstanceConfig?.enableSecureBoot !== true) fail();
    if (kind === 'melee' && !(resource.disks ?? []).some(disk => disk.deviceName === 'opensmash-melee-data' && disk.autoDelete === false && disk.mode === 'READ_WRITE' && !disk.boot && link(disk.source, `zones/${config.zone}/disks/opensmash-melee-data`))) fail();
  } else fail();
}

export function checkDns(expectedAddress, ipv4Addresses, ipv6Addresses = []) {
  if (!isIPv4(expectedAddress) || !ipv4Addresses.length || ipv4Addresses.some(address => address !== expectedAddress) || ipv6Addresses.length) {
    throw new Error('DNS must contain only the VM static IPv4 address, with Cloudflare proxy disabled and no AAAA record');
  }
}

async function main() {
  const options = {};
  const allowed = new Set(['project', 'zone', 'host', 'relay-host', 'melee-host', 'email', 'relay-image', 'melee-image', 'melee-token-secret', 'asset-origin', 'output', 'apply']);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || !allowed.has(args[i].slice(2)) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument: ${args[i]}`);
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.output) throw new Error('--output is required (use a directory outside the repository)');
  const config = configuration(options);
  if (options.apply && !['prepare', 'launch-relay', 'launch-melee'].includes(options.apply)) throw new Error('Unknown --apply phase');
  if (options.apply === 'launch-melee' && !config.meleeImage) throw new Error('--melee-image is required for launch-melee');
  const output = resolve(options.output);
  const scripts = startupScripts(config);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const [name, script] of Object.entries(scripts)) if (script) writeFileSync(join(output, `${name}-startup.sh`), script, { mode: 0o700 });
  const plan = deploymentPlan(config, output);
  writeFileSync(join(output, 'plan.json'), JSON.stringify({ config, steps: plan }, null, 2) + '\n', { mode: 0o600 });
  console.log(`Wrote deployment plan and startup scripts to ${output}`);
  if (!options.apply) { console.log('No cloud resources changed. Add --apply prepare, launch-relay, or launch-melee to run one phase.'); return; }
  const run = (args, quiet = false) => spawnSync('gcloud', args, { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  const projectCheck = run(['projects', 'describe', config.project, '--format=json'], true);
  if (projectCheck.error || projectCheck.status !== 0) throw new Error('Could not verify project ownership');
  checkProject(JSON.parse(projectCheck.stdout), config);
  const inspect = (step, required = false) => {
    const result = run([...step.exists, '--format=json'], true);
    if (result.error) throw result.error;
    if (result.status === 0) { checkExisting(step, JSON.parse(result.stdout), config, scripts); return true; }
    if (required || !/not[_ ]found|does not exist|could not be found/i.test(result.stderr)) throw new Error(`Could not verify required resource: ${step.exists.join(' ')}`);
    return false;
  };
  if (options.apply.startsWith('launch-')) {
    // Recheck ownership and disk/firewall shape immediately before attachment.
    for (const step of plan.filter(step => step.phase === 'prepare' && step.exists)) inspect(step, true);
    const kind = options.apply.slice('launch-'.length);
    const address = run(['compute', 'addresses', 'describe', `opensmash-${kind}`, `--region=${config.region}`, `--project=${config.project}`, '--format=value(address)'], true);
    if (address.error || address.status !== 0) throw new Error('Could not read the static address; run the prepare phase first');
    config.expectedAddress = address.stdout.trim();
    const hostname = kind === 'relay' ? config.relayHost : config.meleeHost;
    const ipv4 = await resolve4(hostname);
    const ipv6 = await resolve6(hostname).catch(error => { if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return []; throw error; });
    checkDns(address.stdout.trim(), ipv4, ipv6);
  }
  for (const step of plan.filter(step => step.phase === options.apply)) {
    if (step.exists && inspect(step)) { console.log(`Exists: ${step.exists.slice(0, 4).join(' ')}`); continue; }
    console.log(`gcloud ${step.args.join(' ')}`);
    const result = run(step.args);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`gcloud command failed (${result.status}); resolve it before retrying this phase`);
  }
  if (options.apply === 'prepare') {
    for (const name of ['opensmash-relay', ...(config.meleeImage ? ['opensmash-melee'] : [])]) {
      run(['compute', 'addresses', 'describe', name, `--region=${config.region}`, `--project=${config.project}`, '--format=value(address)']);
    }
    console.log(`Create DNS-only A records for ${config.relayHost}${config.meleeImage ? ` and ${config.meleeHost}` : ''} using those IPs. Then launch the corresponding VMs.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
