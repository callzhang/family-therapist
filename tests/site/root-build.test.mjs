import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyAppBuild, verifyHostingManifests, verifyMigrationJournal } from '../../scripts/build-site-root.mjs';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'site-root-build-'));
  const writeJson = (filename, value) => { mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, `${JSON.stringify(value)}\n`); };
  const app = path.join(root, 'app');
  const dist = path.join(app, 'dist');
  const drizzle = path.join(app, 'drizzle');
  const host = { project_id: 'existing-site', d1: 'DB', r2: 'BUCKET' };
  mkdirSync(path.join(dist, 'server'), { recursive: true });
  mkdirSync(path.join(dist, 'client'), { recursive: true });
  mkdirSync(drizzle, { recursive: true });
  writeFileSync(path.join(dist, 'server/index.js'), 'export default {}');
  writeFileSync(path.join(dist, 'client/index.html'), '<main>built</main>');
  writeJson(path.join(dist, '.openai/hosting.json'), host);
  writeJson(path.join(dist, 'server/wrangler.json'), { main: 'index.js', d1_databases: [{ binding: 'DB' }], r2_buckets: [{ binding: 'BUCKET' }], assets: { directory: '../client' } });
  writeFileSync(path.join(drizzle, '0000_init.sql'), 'SELECT 1;');
  mkdirSync(path.join(drizzle, 'meta'), { recursive: true });
  writeFileSync(path.join(drizzle, 'meta/0000_snapshot.json'), '{}');
  writeJson(path.join(drizzle, 'meta/_journal.json'), { entries: [{ idx: 0, tag: '0000_init' }] });
  return { root, app, dist, drizzle, host, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('root build guards reject identity/binding drift between root, app, and generated Site metadata', () => {
  const host = { project_id: 'existing-site', d1: 'DB', r2: 'BUCKET' };
  assert.throws(() => verifyHostingManifests(host, { ...host, project_id: 'different-site' }, host), /manifests differ/);
  assert.throws(() => verifyHostingManifests(host, host, { ...host, r2: 'OTHER' }), /r2/);
  assert.throws(() => verifyHostingManifests(host, host, { ...host, d1: 'DB', capabilities: ['unexpected'] }), /manifest conflicts/);
});

test('root build validates Worker entry, client assets, Site identity, generated bindings, and ordered Drizzle metadata', () => {
  const f = fixture();
  try {
    const outputs = verifyAppBuild(f.app, f.host, f.host);
    assert.equal(outputs.dist, f.dist);
    assert.equal(outputs.drizzle, f.drizzle);
    assert.doesNotThrow(() => verifyMigrationJournal(f.drizzle));
    writeFileSync(path.join(f.drizzle, '0001_unjournaled.sql'), 'SELECT 2;');
    assert.throws(() => verifyMigrationJournal(f.drizzle), /files and journal entries do not match/);
  } finally { f.cleanup(); }
});

test('root build rejects missing Worker entry or declared D1 binding metadata', () => {
  const f = fixture();
  try {
    rmSync(path.join(f.dist, 'server/index.js'));
    assert.throws(() => verifyAppBuild(f.app, f.host, f.host), /missing dist\/server\/index.js/);
    writeFileSync(path.join(f.dist, 'server/index.js'), 'export default {}');
    const workerPath = path.join(f.dist, 'server/wrangler.json');
    writeFileSync(workerPath, JSON.stringify({ main: 'index.js', d1_databases: [], r2_buckets: [{ binding: 'BUCKET' }], assets: { directory: '../client' } }));
    assert.throws(() => verifyAppBuild(f.app, f.host, f.host), /missing the declared D1 binding/);
  } finally { f.cleanup(); }
});
