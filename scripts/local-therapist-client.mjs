#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createAgentClient, validateConnection, validateMember } from '../packages/local-client/client.mjs';
import { syncFormalMessages } from '../packages/local-client/sync.mjs';
import { summarizeResult } from '../packages/local-client/summary.mjs';
import { updateSkillRelease } from '../packages/local-client/skill-updater.mjs';

async function privateJson(filepath) {
  const absolute = path.resolve(filepath);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Configuration must be a private regular file with mode 0600 or stricter');
  const parsed = JSON.parse(await readFile(absolute, 'utf8'));
  return { absolute, parsed };
}
function usage() {
  throw new Error('Usage: node scripts/local-therapist-client.mjs sync <member.json> <connection.json> <private-state-dir> | sync-and-update <member.json> <connection.json> <private-state-dir> <skill-install-dir> [--consultation-busy] | read <member.json> <connection.json> discussion | read <member.json> <connection.json> query <tool-name> <json-args>');
}
try {
  const [command, memberPath, connectionPath, ...rest] = process.argv.slice(2);
  if (!command || !memberPath || !connectionPath) usage();
  const { parsed: member } = await privateJson(memberPath);
  const { parsed: connection } = await privateJson(connectionPath);
  validateMember(member); validateConnection(connection);
  const client = createAgentClient({ member, connection });
  if (command === 'sync' || command === 'sync-and-update') {
    const [stateDirectory, installDirectory, busyFlag] = rest;
    if (!stateDirectory || (command === 'sync' && rest.length !== 1) || (command === 'sync-and-update' && (!installDirectory || ![2, 3].includes(rest.length) || (rest.length === 3 && busyFlag !== '--consultation-busy')))) usage();
    const result = await syncFormalMessages({ client, member, stateDirectory: path.resolve(stateDirectory) });
    if (command === 'sync-and-update') {
      result.skill_update = await updateSkillRelease({ client, notice: result.skill_release, installDirectory: path.resolve(installDirectory), consultationBusy: busyFlag === '--consultation-busy' });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === 'read' && rest[0] === 'discussion' && rest.length === 1) {
    process.stdout.write(`${JSON.stringify(summarizeResult(await client.getDiscussion()))}\n`);
  } else if (command === 'read' && rest[0] === 'query' && rest.length === 3) {
    const args = JSON.parse(rest[2]);
    process.stdout.write(`${JSON.stringify(summarizeResult(await client.query(rest[1], args)))}\n`);
  } else usage();
} catch (error) {
  process.stderr.write(`Local Therapist client stopped: ${error instanceof SyntaxError ? 'invalid JSON configuration or arguments' : error.message}\n`);
  process.exitCode = 1;
}
