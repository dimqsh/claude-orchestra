import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { atomicJSON, codexHome, limitsPath } from './paths.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
async function readSaved() {
  try { return JSON.parse(await readFile(limitsPath(), 'utf8')); } catch { return null; }
}

/** Persist raw statusline limits at most once a minute, including across HUD processes. */
export async function recordClaudeLimits(rateLimits) {
  if (!isObject(rateLimits)) return;
  const path = limitsPath(), lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  try { await (await open(lock, 'wx')).close(); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A crashed HUD must not prevent all future recordings. Let the next call retry.
    const age = await stat(lock).then(info => Date.now() - info.mtimeMs, () => 0);
    if (age > 10_000) await rm(lock, { force: true });
    return;
  }
  try {
    const saved = await readSaved(), now = Date.now();
    if (now - Date.parse(saved?.recordedAt) < 60_000) return;
    await atomicJSON(path, { claude: rateLimits, recordedAt: new Date(now).toISOString() });
  } finally { await rm(lock, { force: true }); }
}

function resetTime(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function window(name, value, percentKeys) {
  if (!name || !isObject(value)) return null;
  const usedPercent = percentKeys.map(key => value[key]).find(Number.isFinite);
  return usedPercent === undefined ? null : { name, usedPercent, resetsAt: resetTime(value.resets_at) };
}

function claudeWindows(limits) {
  const windows = [['five_hour', '5h'], ['seven_day', '7d']].map(([key, name]) =>
    window(name, limits?.[key], ['used_percentage', 'used_percent', 'utilization'])).filter(Boolean);
  return windows.length ? windows : null;
}

async function newestRollout() {
  let newest = null, newestTime = -Infinity;
  async function walk(dir, depth = 0) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (depth < 3 && entry.isDirectory() && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
        await walk(path, depth + 1);
      } else if (depth === 3 && entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const time = await stat(path).then(info => info.mtimeMs, () => -Infinity);
        if (time > newestTime || (time === newestTime && path > newest)) {
          newest = path; newestTime = time;
        }
      }
    }
  }
  await walk(join(codexHome, 'sessions'));
  return newest;
}

async function codexWindows() {
  const path = await newestRollout();
  if (!path) return null;
  let limits = null;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'event_msg' && event.payload?.type === 'token_count' && event.payload.rate_limits != null) {
      limits = event.payload.rate_limits;
    }
  }
  const names = new Map([[300, '5h'], [10080, 'week']]);
  const windows = [limits?.primary, limits?.secondary].map(value =>
    window(names.get(value?.window_minutes), value, ['used_percent'])).filter(Boolean);
  return windows.length ? windows : null;
}

/** Unknown or unreadable provider data stays null rather than being treated as zero usage. */
export async function readLimits() {
  const [saved, codex] = await Promise.all([readSaved(), codexWindows().catch(() => null)]);
  return { claude: claudeWindows(saved?.claude), codex, gemini: null, kimi: null };
}

export function maxUsedPercent(limits, provider) {
  const windows = limits?.[provider];
  if (!Array.isArray(windows)) return null;
  const values = windows.map(value => value?.usedPercent).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}
