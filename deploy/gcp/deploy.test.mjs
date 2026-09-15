import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { configuration, deploymentPlan, startupScripts, checkDns, checkProject, checkExisting } from './deploy.mjs';

const options = {
  project: 'opensmash-test-123', email: 'operator@example.com',
  'relay-image': `us-central1-docker.pkg.dev/opensmash-test-123/opensmash/relay@sha256:${'a'.repeat(64)}`,
};
const config = configuration(options);

test('rejects unpinned images, another project registry, unsafe hosts, and command injection', () => {
  for (const change of [
    { 'relay-image': 'us-central1-docker.pkg.dev/opensmash-test-123/opensmash/relay:latest' },
    { 'relay-image': options['relay-image'].replace('opensmash-test-123/', 'other-project/') },
    { host: "smash.not.fun'; touch /tmp/injected; #" },
    { email: 'a@example.com\nmalicious' },
    { project: 'test;cat /etc/passwd' },
    { 'relay-host': 'smash.not.fun' },
  ]) assert.throws(() => configuration({ ...options, ...change }));
});

test('generated shell is syntactically valid and contains no unresolved placeholders', () => {
  const both = configuration({ ...options, 'melee-image': options['relay-image'].replace('/relay@', '/melee@') });
  for (const script of Object.values(startupScripts(both))) {
    assert.doesNotMatch(script, /\{\{[A-Z_]+\}\}/);
    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.doesNotMatch(script, /set -[a-z]*x/);
  }
});

test('relay firewall preserves direct QUIC and limits SSH to IAP', () => {
  const steps = deploymentPlan(config, '/tmp/opensmash-deploy');
  const firewalls = steps.filter(step => step.args.includes('firewall-rules'));
  assert.equal(firewalls.length, 2);
  assert.ok(firewalls.some(step => step.args.includes('--rules=tcp:80,tcp:443,udp:443') && step.args.includes('--target-tags=opensmash-relay')));
  assert.ok(firewalls.some(step => step.args.includes('--rules=tcp:22') && step.args.includes('--source-ranges=35.235.240.0/20')));
  assert.ok(steps.every(step => step.args.includes(config.project)));
  assert.ok(steps.every(step => !step.args.includes('delete')));
  assert.ok(!steps.some(step => step.args.some(arg => arg.includes('secretAccessor'))));
  assert.equal(steps.filter(step => step.phase === 'launch-relay').length, 1);
});

test('Melee has an independent durable disk and secret access scoped to its named secret', () => {
  const both = configuration({ ...options, 'melee-image': options['relay-image'].replace('/relay@', '/melee@') });
  const steps = deploymentPlan(both, '/tmp/opensmash-deploy');
  const launch = steps.find(step => step.phase === 'launch-melee');
  assert.ok(launch.args.includes('--disk=name=opensmash-melee-data,device-name=opensmash-melee-data,mode=rw,boot=no,auto-delete=no'));
  const grant = steps.find(step => step.args.includes('--role=roles/secretmanager.secretAccessor'));
  assert.deepEqual(grant.args.slice(0, 3), ['secrets', 'add-iam-policy-binding', 'opensmash-melee-token']);
  const script = startupScripts(both).melee;
  assert.match(script, /ConditionPathExists=\/srv\/opensmash-melee\/data\/build\/web-game\/verified.json/);
  assert.match(script, /-p 127\.0\.0\.1:8782:8782/);
  assert.match(script, /Melee game assets are not provisioned/);
});

test('launch DNS check rejects proxied, mixed, absent, and IPv6 records', () => {
  assert.doesNotThrow(() => checkDns('34.10.20.30', ['34.10.20.30']));
  for (const [expected, ipv4, ipv6] of [
    ['34.10.20.30', ['104.16.1.1'], []],
    ['34.10.20.30', ['34.10.20.30', '104.16.1.1'], []],
    ['34.10.20.30', [], []],
    ['34.10.20.30', ['34.10.20.30'], ['2606:4700::1']],
    ['', ['34.10.20.30'], []],
  ]) assert.throws(() => checkDns(expected, ipv4, ipv6));
});


test('project ownership is required even when the requested project ID matches', () => {
  const resource = { projectId: config.project, labels: { app: 'opensmash', 'managed-by': 'opensmash-deploy' } };
  assert.doesNotThrow(() => checkProject(resource, config));
  assert.throws(() => checkProject({ ...resource, labels: {} }, config));
  assert.throws(() => checkProject({ ...resource, projectId: 'unrelated-project' }, config));
});

test('existing firewalls cannot silently widen ingress or change their target network', () => {
  const step = deploymentPlan(config, '/tmp/deploy').find(step => step.args.includes('opensmash-relay-public'));
  const resource = {
    network: `https://www.googleapis.com/compute/v1/projects/${config.project}/global/networks/opensmash`,
    direction: 'INGRESS', priority: 1000, sourceRanges: ['0.0.0.0/0'], targetTags: ['opensmash-relay'],
    allowed: [{ IPProtocol: 'tcp', ports: ['80', '443'] }, { IPProtocol: 'udp', ports: ['443'] }],
  };
  assert.doesNotThrow(() => checkExisting(step, resource, config));
  assert.throws(() => checkExisting(step, { ...resource, allowed: [{ IPProtocol: 'all' }] }, config));
  assert.throws(() => checkExisting(step, { ...resource, network: resource.network.replace('/opensmash', '/default') }, config));
  assert.throws(() => checkExisting(step, { ...resource, targetTags: [] }, config));
});

test('existing data disks must be owned, correctly sized, and attached only to their service', () => {
  const both = configuration({ ...options, 'melee-image': options['relay-image'].replace('/relay@', '/melee@') });
  const step = deploymentPlan(both, '/tmp/deploy').find(step => step.exists?.[1] === 'disks');
  const root = `https://www.googleapis.com/compute/v1/projects/${config.project}/zones/${config.zone}`;
  const resource = { labels: { app: 'opensmash', 'managed-by': 'opensmash-deploy' }, selfLink: `${root}/disks/opensmash-melee-data`, type: `${root}/diskTypes/pd-balanced`, sizeGb: '100', users: [] };
  assert.doesNotThrow(() => checkExisting(step, resource, both));
  assert.throws(() => checkExisting(step, { ...resource, labels: {} }, both));
  assert.throws(() => checkExisting(step, { ...resource, sizeGb: '500' }, both));
  assert.throws(() => checkExisting(step, { ...resource, users: [`${root}/instances/unrelated`] }, both));
});

test('additional source origins are explicit HTTPS origins and do not replace the website', () => {
  assert.equal(configuration(options).sourceOrigins, 'https://smash.not.fun');
  assert.equal(configuration({ ...options, 'asset-origin': 'https://assets.smash.not.fun' }).sourceOrigins, 'https://smash.not.fun,https://assets.smash.not.fun');
  for (const origin of ['http://assets.smash.not.fun', 'https://user:pass@assets.smash.not.fun', 'https://assets.smash.not.fun/path', 'https://assets.smash.not.fun/']) {
    assert.throws(() => configuration({ ...options, 'asset-origin': origin }));
  }
});


test('regional IPv4 addresses may omit ipVersion in the real Compute API response', () => {
  const step = deploymentPlan(config, '/tmp/deploy').find(step => step.exists?.[1] === 'addresses');
  const resource = {
    selfLink: `https://www.googleapis.com/compute/v1/projects/${config.project}/regions/${config.region}/addresses/opensmash-relay`,
    addressType: 'EXTERNAL', networkTier: 'PREMIUM', address: '136.64.109.100', status: 'RESERVED',
  };
  assert.doesNotThrow(() => checkExisting(step, resource, config));
  assert.doesNotThrow(() => checkExisting(step, {...resource, ipVersion: 'IPV4'}, config));
  assert.throws(() => checkExisting(step, {...resource, address: '2001:db8::1'}, config));
  assert.throws(() => checkExisting(step, {...resource, ipVersion: 'IPV6'}, config));
  assert.throws(() => checkExisting(step, {...resource, addressType: 'INTERNAL'}, config));
});
