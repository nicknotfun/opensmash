import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { stageAssets, mirrorCommand } from './mirror-assets.mjs';
import { bakedAssetFiles, bakedAssetObjectKey } from '../../web-prototype/shared/baked-assets.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'opensmash-mirror-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const assets = {};
  for (const [kind, path] of Object.entries(bakedAssetFiles('mario'))) {
    const data = Buffer.from(`verified ${kind}`);
    assets[kind] = { size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    await writeFile(join(sourceRoot, path), data);
  }
  return { sourceRoot, tempParent: root, slugs: ['mario'], manifest: { schemaVersion: 2, characters: [{ slug: 'mario', variants: ['mario'], metadata: {}, assets }] } };
}

test('stages exact verified bytes at manifest content-addressed keys', async t => {
  const options = await fixture(t);
  options.manifest.characters[0].assets.bundle.relative = '../../credentials.env';
  const result = await stageAssets(options);
  assert.equal(result.assets, 7); assert.equal(result.objects, 7);
  for (const [kind, path] of Object.entries(bakedAssetFiles('mario'))) {
    const key = bakedAssetObjectKey(path, options.manifest.characters[0].assets[kind].sha256);
    assert.deepEqual(await readFile(join(result.stageRoot, key)), await readFile(join(options.sourceRoot, path)));
  }
});

test('rejects changed bytes and cleans up only its temporary staging directory', async t => {
  const options = await fixture(t);
  await writeFile(join(options.sourceRoot, 'play/mario.osb6'), Buffer.alloc(options.manifest.characters[0].assets.bundle.size));
  await assert.rejects(stageAssets(options), /Checksum\/size mismatch/);
  assert.deepEqual(await readdir(options.tempParent), ['source']);
});

test('rejects unlisted files, symlinks, and escaping manifest slugs', async t => {
  const options = await fixture(t);
  const extra = join(options.sourceRoot, 'credentials.env');
  await writeFile(extra, 'not for upload');
  await assert.rejects(stageAssets(options), /Unlisted/);
  await rm(extra);
  const expected = join(options.sourceRoot, 'play/mario.osb6');
  await rm(expected);
  await symlink('/etc/hosts', expected);
  await assert.rejects(stageAssets(options), /symlink/);
  const alias = join(options.tempParent, 'alias');
  await symlink(options.sourceRoot, alias);
  await assert.rejects(stageAssets({ ...options, sourceRoot: alias }), /symlinks/);
  options.manifest.characters[0].slug = '../secret';
  await assert.rejects(stageAssets(options), /Invalid baked fighter/);
});

test('upload command is recursive and immutable, without deletion or an incorrect gzip encoding', () => {
  const args = mirrorCommand('/tmp/stage', 'opensmash-test-assets', 'opensmash-test');
  assert.deepEqual(args.slice(0, 4), ['storage', 'rsync', '/tmp/stage/baked', 'gs://opensmash-test-assets/baked']);
  assert.ok(args.includes('--recursive'));
  assert.ok(args.includes('--checksums-only'));
  assert.ok(args.includes('--cache-control=public, max-age=31536000, immutable'));
  assert.ok(!args.some(arg => /delete|content-encoding|content-type/.test(arg)));
  for (const bucket of ['gs://bucket', 'bucket/path', '--delete-unmatched-destination-objects']) assert.throws(() => mirrorCommand('/tmp/stage', bucket, 'opensmash-test'));
});
