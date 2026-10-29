import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { realpathSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
export const orchestraHome = process.env.ORCHESTRA_HOME || join(claudeConfigDir, 'orchestra');
export const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
// Mirrors Claude Code's projects/ dir naming: names over 200 chars are cut and suffixed with
// the base36 Java-style string hash of the full path (keeps file names under the 255-byte limit).
const MAX_SLUG = 200;
function javaHash(text) {
  let hash = 0;
  for (const ch of text) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36);
}
export function projectSlug(cwd) {
  const slug = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  return slug.length <= MAX_SLUG ? slug : `${slug.slice(0, MAX_SLUG)}-${javaHash(String(cwd))}`;
}
export function canonicalPath(cwd) {
  try { return realpathSync(cwd); } catch { return resolve(cwd); }
}
export const projectDir = cwd => join(claudeConfigDir, 'projects', projectSlug(cwd));
export const boardPath = cwd => join(orchestraHome, 'boards', `${projectSlug(canonicalPath(cwd))}.json`);
export const cacheDir = () => join(orchestraHome, 'cache');
export const codexJobsDir = () => join(orchestraHome, 'codex-jobs');
export const catalogPath = () => join(orchestraHome, 'models.json');
export const limitsPath = () => join(orchestraHome, 'limits.json');
export const jobsDir = () => join(orchestraHome, 'jobs');
export const codexStateRoots = () => [join(claudeConfigDir, 'plugins/data/codex-openai-codex/state'), join(tmpdir(), 'codex-companion')];
export function orchestraConfig() {
  try {
    const value = JSON.parse(readFileSync(join(orchestraHome, 'config.json'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export async function atomicJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  // Short name in the same directory: appending to a long board name would exceed 255 bytes.
  const temp = join(dirname(path), `.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}
