import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = [
  'skills/local-therapist-assistant/SKILL.md',
  'skills/local-therapist-assistant/references/method.md',
  'skills/local-therapist-assistant/references/initialization.md',
];
const versionData = JSON.parse(await readFile(path.join(root, 'skills/local-therapist-assistant/release-version.json'), 'utf8'));
if (!versionData || Object.keys(versionData).join() !== 'version' || typeof versionData.version !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[1-9][0-9]*$/.test(versionData.version)) throw new Error('Invalid Skill release version');
const files = [];
for (const name of names) {
  const content = await readFile(path.join(root, name), 'utf8');
  if (!content.endsWith('\n')) throw new Error(`Canonical Skill file must end with newline: ${name}`);
  files.push({ path: name, content });
}
const canonical = JSON.stringify({ version: versionData.version, files });
const sha256 = createHash('sha256').update(canonical, 'utf8').digest('hex');
const releaseIdHex = sha256.slice(0, 32).split('');
releaseIdHex[12] = '5';
releaseIdHex[16] = ((Number.parseInt(releaseIdHex[16], 16) & 3) | 8).toString(16);
const release_id = `${releaseIdHex.join('').slice(0, 8)}-${releaseIdHex.join('').slice(8, 12)}-${releaseIdHex.join('').slice(12, 16)}-${releaseIdHex.join('').slice(16, 20)}-${releaseIdHex.join('').slice(20)}`;
const release = { version: versionData.version, release_id, sha256 };
const bundle = `${JSON.stringify({ ...release, files }, null, 2)}\n`;
await writeFile(path.join(root, 'skills/local-therapist-assistant/release-bundle.json'), bundle, 'utf8');
await writeFile(path.join(root, 'sites/family-therapist/src/server/skill-release-metadata.mjs'), `export const skillRelease = Object.freeze(${JSON.stringify(release)});\n`, 'utf8');
await writeFile(path.join(root, 'sites/family-therapist/src/server/skill-release-bundle.mjs'), `export const skillReleaseBundle = Object.freeze(${JSON.stringify({ ...release, files })});\n`, 'utf8');
