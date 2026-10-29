import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { allowFable, entryId, readCatalog, updateCatalog } from './catalog.mjs';
import { claudeConfigDir } from './paths.mjs';

const DAY = 24 * 60 * 60 * 1000;
const recent = value => Number.isFinite(Date.parse(value)) && Date.now() - Date.parse(value) < DAY;
const errorText = error => String(error.stderr?.trim() || error.stdout?.trim() || error.message || error);
const runOptions = { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 };
const noSandbox = { ok: false, error: 'disabled: no sandbox' };
function execute(runner, command, args) {
  return new Promise((resolve, reject) => {
    const child = runner(command, args, runOptions, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child?.stdin?.end();
  });
}

/** Agent aliases stay stable; resolved versions come only from recent assistant events. */
export async function listClaude() {
  const aliases = ['haiku', 'sonnet', ...(allowFable() ? ['fable'] : [])];
  const latest = new Map();
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const info = await stat(path).catch(() => null);
      if (!info || Date.now() - info.mtimeMs > 7 * DAY) continue;
      const input = createReadStream(path);
      // Transcripts can be removed or partially written while discovery reads them.
      input.on('error', () => {});
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          const model = row?.message?.model;
          if (row?.type !== 'assistant' || typeof model !== 'string' || !/^claude-.*\d/.test(model)) continue;
          const alias = aliases.find(name => model.split('-').includes(name));
          if (!alias) continue;
          const time = Date.parse(row.timestamp) || info.mtimeMs;
          if (!latest.has(alias) || time >= latest.get(alias).time) latest.set(alias, { model, time });
        }
      } catch { /* An unreadable transcript does not prevent listing the Agent aliases. */ }
      finally { lines.close(); input.destroy(); }
    }
  }
  await walk(join(claudeConfigDir, 'projects'));
  return aliases.map(model => ({ provider: 'claude', model, resolved: latest.get(model)?.model || null, runner: 'Agent', efforts: [] }));
}

export async function listCodex({ runner = execFile } = {}) {
  const { stdout } = await execute(runner, 'codex', ['debug', 'models']);
  const data = JSON.parse(stdout);
  if (!Array.isArray(data.models)) throw new Error('Invalid codex debug models response: missing models');
  return data.models.filter(item => item.visibility === 'list' && typeof item.slug === 'string' && item.slug)
    .map(item => ({ provider: 'codex', model: item.slug, runner: 'codex-task.mjs',
      efforts: [...new Set((item.supported_reasoning_levels || []).map(level => level.effort).filter(effort => typeof effort === 'string'))],
      ...(typeof item.description === 'string' ? { description: item.description } : {}) }));
}

/** Public data may be empty on the first run; the CLI default is always a candidate. */
export function listGemini(catalog) {
  const known = Object.values(catalog.models).filter(entry =>
    ['gemini', 'google'].includes(entry.provider) && entry.model?.startsWith('gemini-') && entry.public?.source);
  known.sort((a, b) => (Date.parse(b.public.date) || 0) - (Date.parse(a.public.date) || 0) ||
    b.model.localeCompare(a.model, 'en', { numeric: true }));
  return ['default', ...new Set(known.map(entry => entry.model))].slice(0, 4)
    .map(model => ({ provider: 'gemini', model, runner: 'gemini-task.mjs', efforts: [] }));
}

export function listKimi() {
  return [{ provider: 'kimi', model: 'default', runner: 'kimi-task.mjs', efforts: [] }];
}

async function probeAccess(candidate, { runner = execFile } = {}) {
  if (candidate.provider === 'claude') return { ok: true, probed: false };
  if (candidate.provider === 'kimi') return { ...noSandbox, probed: false };
  let command, args;
  if (candidate.provider === 'codex') {
    command = 'codex'; args = ['exec', '-m', candidate.model, '-s', 'read-only', '--skip-git-repo-check', 'Reply OK'];
  } else if (candidate.provider === 'gemini') {
    try { await access(join(homedir(), '.gemini/oauth_creds.json')); }
    catch { return { ok: false, error: 'missing ~/.gemini/oauth_creds.json', probed: false }; }
    command = 'gemini'; args = [...(candidate.model === 'default' ? [] : ['-m', candidate.model]), '-p', 'Reply OK'];
  } else return { ok: false, error: `unknown provider: ${candidate.provider}`, probed: false };
  try { await execute(runner, command, args); return { ok: true, probed: true }; }
  catch (error) { return { ok: false, error: errorText(error), probed: !['ENOENT', 'EACCES'].includes(error.code) }; }
}

export async function probe(candidate, options) {
  const { probed, ...result } = await probeAccess(candidate, options);
  return result;
}

const identity = entry => ({ provider: entry.provider, model: entry.model, runner: entry.runner, efforts: entry.efforts,
  ...(entry.provider === 'claude' ? { resolved: entry.resolved } : {}), description: entry.description });
const differs = (a, b) => JSON.stringify(identity(a)) !== JSON.stringify(identity(b));
const accessDiffers = (a, b) => a?.ok !== b?.ok || a?.error !== b?.error;

/** Discover candidates and check access serially, then merge only discovery-owned fields. */
export async function discover({ force = false, runner = execFile } = {}) {
  const catalog = await readCatalog();
  const result = { added: [], changed: [], unavailable: [] };
  if (!force && recent(catalog.discoveredAt)) return result;
  const candidates = await listClaude();
  const updates = new Map();
  let codex;
  try { codex = await listCodex({ runner }); candidates.push(...codex); }
  catch (error) {
    for (const entry of Object.values(catalog.models).filter(entry => entry.provider === 'codex')) {
      updates.set(entry.id || entryId(entry.provider, entry.model), { available: { ok: false, error: errorText(error), probed: false, checkedAt: new Date().toISOString() } });
    }
  }
  candidates.push(...listGemini(catalog), ...listKimi());
  for (const candidate of candidates) {
    const id = entryId(candidate.provider, candidate.model), previous = catalog.models[id];
    // Only actual model probes spend the daily budget, including forced discovery.
    // Successful unchanged Codex checks also survive later daily refreshes.
    const reuse = ['codex', 'gemini'].includes(candidate.provider) && previous && !differs(previous, candidate) &&
      previous.available?.probed === true &&
      ((candidate.provider === 'codex' && previous.available.ok) || recent(previous.available.checkedAt));
    const available = reuse ? previous.available : { ...await probeAccess(candidate, { runner }), checkedAt: new Date().toISOString() };
    updates.set(id, { ...candidate, id, description: candidate.description, available });
  }
  // A formerly visible model must not remain routable after it disappears from the CLI.
  if (codex) {
    const visible = new Set(codex.map(entry => entryId(entry.provider, entry.model)));
    for (const [id, entry] of Object.entries(catalog.models)) {
      if (entry.provider === 'codex' && !visible.has(id)) updates.set(id, {
        available: { ok: false, error: 'not listed by codex debug models', probed: false, checkedAt: new Date().toISOString() },
      });
    }
  }
  if (!allowFable() && catalog.models['claude:fable']) updates.set('claude:fable', {
    available: { ok: false, error: 'disabled: allowFable is false', probed: false, checkedAt: new Date().toISOString() },
  });
  await updateCatalog(current => {
    for (const [id, update] of updates) {
      const previous = current.models[id];
      if (!previous) result.added.push(id);
      else if (('provider' in update && differs(previous, update)) || accessDiffers(previous.available, update.available)) result.changed.push(id);
      if (!update.available.ok) result.unavailable.push(id);
      current.models[id] = { ...(!previous ? { public: null, own: null, access: '', notes: `first seen ${new Date().toISOString().slice(0, 10)}` } : previous), ...update };
    }
    current.discoveredAt = new Date().toISOString();
  });
  return result;
}
