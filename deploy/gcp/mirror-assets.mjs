#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BAKED_ASSET_KINDS, BAKED_ASSET_CACHE_CONTROL, bakedAssetFiles, bakedAssetObjectKey, validateBakedAssetManifest } from '../../web-prototype/shared/baked-assets.js';
import { bakedRosterSlugs } from '../../web-prototype/shared/baked-roster.js';
import { checkProject } from './deploy.mjs';

const configRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web-prototype/config');
export function mirrorCommand(stageRoot, bucket, project) {
  if (!/^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/.test(bucket)) throw Error('Use a plain GCS bucket name (3–63 characters)');
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw Error('Invalid project ID');
  return ['storage', 'rsync', join(stageRoot, 'baked'), `gs://${bucket}/baked`, '--recursive', '--checksums-only', `--cache-control=${BAKED_ASSET_CACHE_CONTROL}`, '--project', project];
}

export async function stageAssets({ sourceRoot, manifest, slugs, tempParent = tmpdir() }) {
  validateBakedAssetManifest(manifest, slugs);
  sourceRoot = resolve(sourceRoot);
  if (await realpath(sourceRoot) !== sourceRoot) throw Error('Source root must not use symlinks');
  const assets = manifest.characters.flatMap(({ slug, assets }) => BAKED_ASSET_KINDS.map(kind => {
    const relative = bakedAssetFiles(slug)[kind];
    return { relative, size: assets[kind].size, sha256: assets[kind].sha256, key: bakedAssetObjectKey(relative, assets[kind].sha256) };
  }));
  const files = new Set(assets.map(asset => asset.relative));
  const directories = new Set(['']);
  for (const file of files) for (let parent = posix.dirname(file); parent !== '.'; parent = posix.dirname(parent)) directories.add(parent);
  async function inspect(relative = '') {
    for (const entry of await readdir(join(sourceRoot, relative), { withFileTypes: true })) {
      const path = posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw Error(`Refusing symlink: ${path}`);
      if (entry.isDirectory() && directories.has(path)) await inspect(path);
      else if (!entry.isFile() || !files.has(path)) throw Error(`Unlisted source entry: ${path}`);
    }
  }
  await inspect();
  const stageRoot = await mkdtemp(join(tempParent, 'opensmash-baked-mirror-'));
  let bytes = 0;
  const objects = new Set();
  try {
    for (const asset of assets) {
      const source = join(sourceRoot, asset.relative);
      if (await realpath(source) !== source) throw Error(`Source path escaped through a symlink: ${asset.relative}`);
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      let data;
      try { data = await handle.readFile(); } finally { await handle.close(); }
      if (data.length !== asset.size || createHash('sha256').update(data).digest('hex') !== asset.sha256) throw Error(`Checksum/size mismatch: ${asset.relative}`);
      if (!objects.has(asset.key)) {
        const destination = join(stageRoot, asset.key);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, data, { flag: 'wx', mode: 0o600 });
        objects.add(asset.key); bytes += data.length;
      }
    }
    return { stageRoot, assets: assets.length, objects: objects.size, bytes };
  } catch (error) { await rm(stageRoot, { recursive: true, force: true }); throw error; }
}

async function main() {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i];
    if (name === '--apply') options.apply = true;
    else if (['--source-root', '--bucket', '--project'].includes(name) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options[name.slice(2)] = process.argv[++i];
    else throw Error(`Unknown or incomplete argument: ${name}`);
  }
  if (!options['source-root']) throw Error('--source-root is required');
  mirrorCommand('/tmp/preflight', options.bucket, options.project);
  const manifest = JSON.parse(await readFile(join(configRoot, 'baked-assets.json'), 'utf8'));
  const slugs = bakedRosterSlugs(JSON.parse(await readFile(join(configRoot, 'characters.json'), 'utf8')));
  const staged = await stageAssets({ sourceRoot: options['source-root'], manifest, slugs });
  try {
    const args = mirrorCommand(staged.stageRoot, options.bucket, options.project);
    console.log(`Verified ${staged.assets} assets; staged ${staged.objects} unique objects (${staged.bytes} bytes).`);
    if (!options.apply) { console.log(`Preflight complete. No cloud calls made. Add --apply to mirror to gs://${options.bucket}/baked.`); return; }
    const metadata = args => {
      const result = spawnSync('gcloud', [...args, '--format=json'], { encoding: 'utf8' });
      if (result.error || result.status !== 0) throw Error(`Could not verify cloud ownership: ${args.join(' ')}`);
      return JSON.parse(result.stdout);
    };
    const project = metadata(['projects', 'describe', options.project]);
    checkProject(project, { project: options.project });
    const bucket = metadata(['storage', 'buckets', 'describe', `gs://${options.bucket}`, '--project', options.project]);
    if (!/^[0-9]+$/.test(String(project.projectNumber)) || String(bucket.project_number ?? bucket.projectNumber) !== String(project.projectNumber)) throw Error('Target bucket belongs to another project');
    const result = spawnSync('gcloud', args, { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw Error('Asset upload failed; rerun to resume safely');
  } finally { await rm(staged.stageRoot, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
