import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'sites/family-therapist');

function readJsonObject(filename) {
  if (!existsSync(filename) || !lstatSync(filename).isFile()) throw new Error(`Missing regular JSON file: ${filename}`);
  let value;
  try { value = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new Error(`Invalid JSON: ${filename}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected JSON object: ${filename}`);
  return value;
}

function assertRegularTree(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory()) throw new Error(`Expected a regular directory: ${directory}`);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const childStat = lstatSync(child);
    if (childStat.isSymbolicLink() || (!childStat.isDirectory() && !childStat.isFile())) throw new Error(`Generated output contains a symlink or special file: ${child}`);
    if (childStat.isDirectory()) assertRegularTree(child);
  }
}

export function verifyHostingManifests(rootManifest, appManifest, builtManifest) {
  if (!isDeepStrictEqual(rootManifest, appManifest)) throw new Error('Root and app .openai/hosting.json manifests differ; reconcile identity and bindings before building.');
  for (const key of ['project_id', 'd1', 'r2']) {
    if ((rootManifest[key] ?? null) !== (builtManifest[key] ?? null)) throw new Error(`Built Site hosting ${key} does not match the source manifest.`);
  }
  const withoutArtifactMetadata = ({ artifact_metadata: _artifactMetadata, ...manifest }) => manifest;
  if (!isDeepStrictEqual(withoutArtifactMetadata(rootManifest), withoutArtifactMetadata(builtManifest))) throw new Error('Built Site hosting manifest conflicts with the source manifest.');
  if (rootManifest.artifact_metadata != null && builtManifest.artifact_metadata != null && !isDeepStrictEqual(rootManifest.artifact_metadata, builtManifest.artifact_metadata)) throw new Error('Built and source artifact_metadata differ; rebuild with consistent attribution.');
  if (builtManifest.static != null) throw new Error('The generated app output unexpectedly declares a static Site.');
}

export function verifyMigrationJournal(directory) {
  assertRegularTree(directory);
  const journal = readJsonObject(path.join(directory, 'meta/_journal.json'));
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) throw new Error('Drizzle migration journal has no entries.');
  const expectedFiles = new Set();
  for (const [index, entry] of journal.entries.entries()) {
    if (entry?.idx !== index || typeof entry.tag !== 'string' || !entry.tag) throw new Error(`Invalid Drizzle journal entry at index ${index}.`);
    const migration = `${entry.tag}.sql`;
    if (!existsSync(path.join(directory, migration))) throw new Error(`Journal migration is missing: ${migration}`);
    const snapshot = `${String(index).padStart(4, '0')}_snapshot.json`;
    if (!existsSync(path.join(directory, 'meta', snapshot))) throw new Error(`Journal snapshot is missing: ${snapshot}`);
    expectedFiles.add(migration);
  }
  const sqlFiles = readdirSync(directory).filter((filename) => filename.endsWith('.sql'));
  if (sqlFiles.length !== expectedFiles.size || sqlFiles.some((filename) => !expectedFiles.has(filename))) throw new Error('Drizzle SQL files and journal entries do not match.');
}

export function verifyAppBuild(appDirectory, rootManifest, appManifest) {
  const dist = path.join(appDirectory, 'dist');
  assertRegularTree(dist);
  const entry = path.join(dist, 'server/index.js');
  const client = path.join(dist, 'client');
  if (!existsSync(entry) || !lstatSync(entry).isFile()) throw new Error('App build is missing dist/server/index.js.');
  if (!existsSync(client) || !lstatSync(client).isDirectory()) throw new Error('App build is missing dist/client assets.');
  const builtManifest = readJsonObject(path.join(dist, '.openai/hosting.json'));
  verifyHostingManifests(rootManifest, appManifest, builtManifest);
  const worker = readJsonObject(path.join(dist, 'server/wrangler.json'));
  if (worker.main !== 'index.js') throw new Error('Generated Worker metadata does not point at the built entry.');
  const databaseBindings = Array.isArray(worker.d1_databases) ? worker.d1_databases.map((binding) => binding.binding) : [];
  const bucketBindings = Array.isArray(worker.r2_buckets) ? worker.r2_buckets.map((binding) => binding.binding) : [];
  if (rootManifest.d1 && !databaseBindings.includes(rootManifest.d1)) throw new Error('Generated Worker metadata is missing the declared D1 binding.');
  if (rootManifest.r2 && !bucketBindings.includes(rootManifest.r2)) throw new Error('Generated Worker metadata is missing the declared R2 binding.');
  if (worker.assets?.directory && !existsSync(path.resolve(path.dirname(path.join(dist, 'server/wrangler.json')), worker.assets.directory))) throw new Error('Generated Worker asset directory is missing.');
  const drizzle = path.join(appDirectory, 'drizzle');
  verifyMigrationJournal(drizzle);
  return { dist, drizzle, worker };
}

function replaceGeneratedDirectory(staged, destination) {
  if (existsSync(destination)) {
    const stat = lstatSync(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing to replace non-directory generated output: ${destination}`);
    rmSync(destination, { recursive: true, force: true });
  }
  renameSync(staged, destination);
}

function assertReplaceableGeneratedDirectory(destination) {
  if (!existsSync(destination)) return;
  const stat = lstatSync(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing to replace non-directory generated output: ${destination}`);
}

function build() {
  const rootManifest = readJsonObject(path.join(ROOT, '.openai/hosting.json'));
  const appManifest = readJsonObject(path.join(APP, '.openai/hosting.json'));
  if (!isDeepStrictEqual(rootManifest, appManifest)) throw new Error('Root and app Site manifests differ; refusing a build that could package another Site identity.');
  const packageManifest = readJsonObject(path.join(APP, 'package.json'));
  if (typeof packageManifest.scripts?.build !== 'string' || !packageManifest.scripts.build.trim()) throw new Error('The Site app has no build script.');

  const result = spawnSync('npm', ['run', 'build'], { cwd: APP, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  if (process.exitCode) return;

  const { dist, drizzle } = verifyAppBuild(APP, rootManifest, appManifest);
  const rootDist = path.join(ROOT, 'dist');
  const rootDrizzle = path.join(ROOT, 'drizzle');
  assertReplaceableGeneratedDirectory(rootDist);
  assertReplaceableGeneratedDirectory(rootDrizzle);
  const stageRoot = mkdtempSync(path.join(ROOT, '.site-root-build-'));
  try {
    const stagedDist = path.join(stageRoot, 'dist');
    const stagedDrizzle = path.join(stageRoot, 'drizzle');
    cpSync(dist, stagedDist, { recursive: true, dereference: false });
    cpSync(drizzle, stagedDrizzle, { recursive: true, dereference: false });
    replaceGeneratedDirectory(stagedDist, rootDist);
    replaceGeneratedDirectory(stagedDrizzle, rootDrizzle);
    verifyMigrationJournal(rootDrizzle);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
  console.log('Prepared repository-root dist/ and drizzle/ from the verified family-therapist Site build.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { build(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Root Site build failed.');
    process.exitCode = 1;
  }
}
