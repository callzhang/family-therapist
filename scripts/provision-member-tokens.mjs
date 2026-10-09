import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORY_NAME = '.local-members';
const MEMBERS = [
  { actor_id: 'partner-husband', filename: 'partner-husband.json', role: 'husband' },
  { actor_id: 'partner-wife', filename: 'partner-wife.json', role: 'wife' },
];
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function seedSql(spaceId, configs) {
  const rows = configs.map((config) => `('${spaceId}', '${config.actor_id}', '${config.role}')`).join(',\n');
  const tokenRows = configs.map((config) => `('${hashToken(config.member_token)}', '${spaceId}', '${config.actor_id}', NULL)`).join(',\n');
  return `INSERT INTO members (space_id, user_id, role) VALUES\n${rows};\n\nINSERT INTO member_tokens (token_sha256, space_id, user_id, revoked_at) VALUES\n${tokenRows};\n`;
}

function assertPrivateRegularFile(stat, filepath) {
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(`Refusing unsafe local member file: ${filepath}`);
}

async function readExisting(directory) {
  const dirInfo = await lstat(directory);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || (dirInfo.mode & 0o077) !== 0) {
    throw new Error(`Refusing unsafe local member directory: ${directory}`);
  }
  const paths = [...MEMBERS.map(({ filename }) => path.join(directory, filename)), path.join(directory, 'seed.sql')];
  const present = [];
  for (const filepath of paths) {
    try {
      const stat = await lstat(filepath);
      assertPrivateRegularFile(stat, filepath);
      present.push(filepath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (present.length === 0) return null;
  if (present.length !== paths.length) throw new Error('Local member configuration is partial; inspect it manually before provisioning.');

  const configs = [];
  for (const member of MEMBERS) {
    const filepath = path.join(directory, member.filename);
    const config = JSON.parse(await readFile(filepath, 'utf8'));
    if (Object.keys(config).sort().join(',') !== 'actor_id,member_token,role,space_id' ||
      config.actor_id !== member.actor_id || config.role !== member.role ||
      typeof config.space_id !== 'string' || !UUID_PATTERN.test(config.space_id) || !TOKEN_PATTERN.test(config.member_token)) {
      throw new Error(`Local member configuration is inconsistent: ${member.filename}`);
    }
    configs.push(config);
  }
  if (configs[0].space_id !== configs[1].space_id || configs[0].member_token === configs[1].member_token) {
    throw new Error('Local member configurations do not describe two distinct members of one space.');
  }
  const expectedSeed = seedSql(configs[0].space_id, configs);
  if (await readFile(path.join(directory, 'seed.sql'), 'utf8') !== expectedSeed) {
    throw new Error('Local member seed SQL does not match the existing configurations.');
  }
  return configs;
}

async function writePrivateFile(filepath, content) {
  const handle = await open(filepath, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function provisionMemberTokens({ rootDir = ROOT } = {}) {
  const directory = path.join(rootDir, DIRECTORY_NAME);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const current = await readExisting(directory);
  if (current) return { directory, created: false, files: MEMBERS.map(({ filename }) => path.join(directory, filename)).concat(path.join(directory, 'seed.sql')) };

  const spaceId = randomUUID();
  const configs = MEMBERS.map(({ actor_id, filename, role }) => ({
    actor_id,
    filename,
    role,
    space_id: spaceId,
    member_token: randomBytes(32).toString('base64url'),
  }));
  for (const config of configs) {
    await writePrivateFile(path.join(directory, config.filename), `${JSON.stringify({
      actor_id: config.actor_id,
      role: config.role,
      space_id: config.space_id,
      member_token: config.member_token,
    }, null, 2)}\n`);
  }
  await writePrivateFile(path.join(directory, 'seed.sql'), seedSql(spaceId, configs));
  return { directory, created: true, files: MEMBERS.map(({ filename }) => path.join(directory, filename)).concat(path.join(directory, 'seed.sql')) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await provisionMemberTokens();
  process.stdout.write(`${result.created ? 'Created' : 'Validated'} private member configuration in ${result.directory}\n`);
}
