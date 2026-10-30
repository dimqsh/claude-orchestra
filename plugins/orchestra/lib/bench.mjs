import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { entryId, readCatalog, updateCatalog } from './catalog.mjs';
import { maxUsedPercent, readLimits } from './limits.mjs';
import { orchestraConfig, orchestraHome } from './paths.mjs';

const TYPES = ['bug', 'logic', 'refactor', 'tests', 'docs', 'multi'];
const CAP = 150000;
const MODEL_TIMEOUT = 10 * 60_000;
// Must exceed the fixture checks' own bounds: the tests check runs up to five 10 s `node --test` runs.
export const CHECK_TIMEOUT = 120_000;
const fixtures = fileURLToPath(new URL('../bench/', import.meta.url));
const codexScript = fileURLToPath(new URL('../scripts/codex-task.mjs', import.meta.url));

/** Injectable runner: ({ command, args, cwd, input, timeout }) -> { code, stdout, stderr }. */
function commandRunner({ command, args, cwd, input = '', timeout }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = timeout == null ? null : setTimeout(() => child.kill(), timeout);
    const failed = error => { clearTimeout(timer); reject(error); };
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('error', failed);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') failed(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, stdout, stderr, signal }); });
    child.stdin.end(input);
  });
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

// Check identity as well as contents so cleanup cannot remove a replacement owner's lock.
async function removeOwnedLock(path, contents, identity) {
  try {
    const [current, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    if (current === contents && info.ino === identity.ino && info.dev === identity.dev) await rm(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function withBenchLock(work) {
  const path = join(orchestraHome, 'bench.lock');
  await mkdir(orchestraHome, { recursive: true });
  let handle;
  for (let retry = 0; !handle; retry++) {
    try { handle = await open(path, 'wx'); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let contents, identity, owner;
      try {
        const existing = await open(path, 'r');
        try { identity = await existing.stat(); contents = await existing.readFile('utf8'); }
        finally { await existing.close(); }
        owner = JSON.parse(contents);
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        // Another process can observe the file between exclusive creation and its first write.
        if (readError instanceof SyntaxError && retry < 100) { await sleep(10); continue; }
        throw readError;
      }
      if (pidAlive(owner.pid)) {
        const busy = new Error(`bench already running (pid ${owner.pid})`);
        busy.code = 'BENCH_BUSY';
        throw busy;
      }
      await removeOwnedLock(path, contents, identity);
    }
  }
  const contents = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  const identity = await handle.stat();
  try {
    await handle.writeFile(contents);
    return await work();
  } finally {
    try { await removeOwnedLock(path, contents, identity); } finally { await handle.close(); }
  }
}

/** Automatic runs yield to any recently updated unfinished board, then to provider limits. */
export async function benchPostponeReason(provider) {
  const boards = join(orchestraHome, 'boards');
  let entries;
  try { entries = await readdir(boards, { withFileTypes: true }); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let board;
    try { board = JSON.parse(await readFile(join(boards, entry.name), 'utf8')); } catch { continue; }
    const age = Date.now() - Date.parse(board?.updatedAt);
    if (board && !board.finishedAt && age >= 0 && age < 30 * 60_000) return 'board active';
  }
  return maxUsedPercent(await readLimits(), provider) > 70 ? 'low limit' : null;
}

function retryable(own) {
  if (!own || own.skipped || !own.partial) return false;
  const reason = own.partial.reason ?? own.reason ?? '';
  return ['board active', 'low limit', 'postponed'].includes(reason) || /^(?:runner error|postponed):/.test(reason);
}

function resolveModels(catalog, models) {
  const entries = Object.values(catalog.models);
  const selected = models === undefined ? entries : models.map(name => {
    if (catalog.models[name]) return catalog.models[name];
    const matches = entries.filter(entry => entry.model === name);
    if (!matches.length) throw new Error(`Unknown model: ${name}`);
    if (matches.length > 1) throw new Error(`Ambiguous model: ${name}; use provider:model`);
    return matches[0];
  });
  return [...new Map(selected.map(entry => [entryId(entry.provider, entry.model), entry])).values()];
}

function selectModels(catalog, models, auto) {
  if (auto && orchestraConfig().benchAuto !== true) return [];
  return resolveModels(catalog, models ?? (auto ? undefined : [])).filter(entry =>
    entry.available?.ok === true && ['codex', 'claude'].includes(entry.provider) &&
    (!auto || (entry.own == null || retryable(entry.own))));
}

function requestFor(entry, cwd, input) {
  const timeout = MODEL_TIMEOUT;
  if (entry.provider === 'claude') {
    const alias = entry.alias ?? entry.model.match(/(?:^|-)(haiku|sonnet|fable)(?:-|$)/)?.[1] ?? entry.model;
    return { command: 'claude', args: ['-p', '--model', alias, '--output-format', 'json',
      '--permission-mode', 'acceptEdits', '--allowedTools', 'Read Edit Write Glob Grep Bash(node:*)'], cwd, input, timeout };
  }
  const args = [codexScript, '--cwd', cwd, '--model', entry.model];
  if (entry.effort) args.push('--effort', entry.effort);
  args.push('--write');
  return { command: process.execPath, args, cwd, input, timeout };
}

function runnerFailure(text, spentTokens = 0) {
  return Object.assign(new Error(String(text).trim().replace(/\s+/g, ' ').slice(0, 500)), { spentTokens });
}

function measuredUsage(entry, response, type, elapsed) {
  let tokens, seconds = elapsed, failed, detail;
  if (entry.provider === 'claude') {
    let value;
    try { value = JSON.parse(response.stdout); } catch { throw runnerFailure(response.stderr || 'Missing or invalid Claude usage'); }
    detail = value?.result || (Array.isArray(value?.errors) ? value.errors.join('; ') : '');
    const counts = ['input_tokens', 'cache_creation_input_tokens', 'output_tokens'].map(key => value?.usage?.[key] ?? 0);
    if (!value?.usage || value.usage.input_tokens == null || value.usage.output_tokens == null ||
        !counts.every(n => Number.isFinite(n) && n >= 0)) throw runnerFailure(response.stderr || detail || 'Missing or invalid Claude usage');
    tokens = counts.reduce((sum, n) => sum + n, 0);
    failed = value.is_error;
  } else {
    // The final nonempty line is authoritative, even if earlier text contains footer examples.
    const footer = String(response.stdout).trim().split(/\r?\n/).at(-1);
    const match = footer.match(/^\[codex\] #([\w.-]+) (done|failed) · (\d+(?:\.\d+)?)([kM]?) tokens · (\d+)m(\d+)s(?: · to memory: \d+)?$/);
    if (!match || match[1] !== `B-${type}`) throw runnerFailure(response.stderr || 'Missing or invalid Codex usage footer');
    tokens = Math.round(Number(match[3]) * { '': 1, k: 1000, M: 1000000 }[match[4]]);
    seconds = Number(match[5]) * 60 + Number(match[6]);
    failed = match[2] === 'failed';
    detail = String(response.stdout).trim().split(/\r?\n/).slice(0, -1).join(' ');
  }
  if (response.code !== 0 || failed || tokens === 0) {
    throw runnerFailure(response.stderr || detail || (tokens === 0 ? 'No token usage reported' : `Command failed (${response.signal || response.code})`), tokens);
  }
  return { tokens, seconds };
}

async function runTask(entry, type, runner, checkTimeout) {
  const fixture = join(fixtures, type);
  const cwd = await mkdtemp(join(tmpdir(), 'orchestra-bench-'));
  try {
    await cp(join(fixture, 'repo'), cwd, { recursive: true });
    const input = await readFile(join(fixture, 'brief.md'), 'utf8');
    const initialized = await commandRunner({ command: 'git', args: ['init', '--quiet'], cwd });
    if (initialized.code !== 0) throw new Error('Cannot initialize benchmark repository');
    const started = performance.now();
    const response = await runner(requestFor(entry, cwd, input));
    const usage = measuredUsage(entry, response, type, (performance.now() - started) / 1000);
    const check = await commandRunner({ command: process.execPath, args: [join(fixture, 'check.mjs'), cwd], cwd, timeout: checkTimeout });
    if (check.signal || check.code === null) throw runnerFailure('check timed out', usage.tokens);
    return { passed: check.code === 0 ? 1 : 0, total: 1, ...usage };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

function addScore(byType, fixture, score) {
  const type = fixture === 'multi' ? 'refactor' : fixture;
  const previous = byType[type] ?? { passed: 0, total: 0, tokens: 0, seconds: 0 };
  byType[type] = Object.fromEntries(['passed', 'total', 'tokens', 'seconds'].map(key => [key, previous[key] + score[key]]));
}

function progress(own) {
  const byType = {};
  for (const [type, score] of Object.entries(own?.byType ?? {})) addScore(byType, type, score);
  // Older partials predate completion IDs and stored multi as a separate type.
  const completed = new Set(own?.completed ?? Object.keys(own?.byType ?? {}));
  if (!own?.completed && byType.refactor?.total >= 2) completed.add('multi');
  return { byType, completed };
}

async function runBenchUnlocked({ models, auto = false, cap = CAP, runner = commandRunner, checkTimeout = CHECK_TIMEOUT } = {}) {
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error('Benchmark cap must be a positive integer');
  const entries = selectModels(await readCatalog(), models, auto);
  const results = {};
  for (const entry of entries) {
    const id = entryId(entry.provider, entry.model);
    const previous = auto && retryable(entry.own) ? entry.own : null;
    const { byType, completed } = progress(previous);
    const result = { done: false, byType };
    results[id] = result;
    let runnerTokens = previous?.runnerTokens ?? 0;
    let tokens = Object.values(byType).reduce((sum, score) => sum + score.tokens, runnerTokens);
    let attempted = false;
    for (const type of TYPES) {
      if (completed.has(type)) continue;
      if (tokens >= cap) { result.reason = 'token cap'; break; }
      if (auto) {
        const reason = await benchPostponeReason(entry.provider);
        if (reason) { result.reason = reason; break; }
      }
      attempted = true;
      try {
        const score = await runTask(entry, type, runner, checkTimeout);
        addScore(byType, type, score);
        completed.add(type);
        tokens += score.tokens;
      } catch (error) {
        const spent = Number.isFinite(error.spentTokens) ? error.spentTokens : 0;
        tokens += spent;
        runnerTokens += spent;
        result.reason = `runner error: ${error.message}`;
        break;
      }
    }
    result.done = TYPES.every(type => completed.has(type));
    if (attempted || previous) {
      const own = { date: new Date().toISOString().slice(0, 10), partial: result.done ? false : { reason: result.reason },
        overCap: tokens > CAP, byType, completed: [...completed], ...(runnerTokens ? { runnerTokens } : {}) };
      // Finish all runner/check I/O before entering the synchronous catalog mutation.
      await updateCatalog(catalog => { if (catalog.models[id]) catalog.models[id].own = own; });
    }
  }
  return results;
}

/** Sequential, globally locked benchmark; the cap is checked between tasks, each timed at 10 min. */
export async function runBench(options = {}) {
  return withBenchLock(() => runBenchUnlocked(options));
}

/** Called by scripts/models.mjs with arguments following `bench`. Returns an exit code. */
export async function runBenchCli(argv) {
  try {
    let models, skip, auto = false, estimate = false;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if ((arg === '--models' && models === undefined) || (arg === '--skip' && skip === undefined)) {
        const value = argv[++i];
        if (!value || value.startsWith('--') || value.split(',').some(name => !name.trim())) throw new Error(`${arg} requires a comma-separated model list`);
        const names = value.split(',').map(name => name.trim());
        if (arg === '--models') models = names; else skip = names;
      } else if (arg === '--new' && !auto) auto = true;
      else if (arg === '--estimate' && !estimate) estimate = true;
      else throw new Error(`Unknown benchmark option: ${arg}`);
    }
    if (auto && models) throw new Error('Use either --models or --new');
    if (estimate && skip) throw new Error('Use --skip separately from --estimate');
    if (!estimate && !auto && !models && !skip) throw new Error('Usage: bench --models a,b | --new | --estimate | --skip a,b');
    if (estimate) {
      const catalog = await readCatalog();
      const names = models ?? (auto ? undefined : Object.keys(catalog.models));
      for (const entry of selectModels(catalog, names, auto)) {
        console.log(`${entryId(entry.provider, entry.model)}: ${CAP} tokens per model (budget estimate)`);
      }
      return 0;
    }
    const results = await withBenchLock(async () => {
      if (skip) {
        const catalog = await readCatalog();
        const skipped = resolveModels(catalog, skip);
        const selected = models ? resolveModels(catalog, models) : [];
        if (selected.some(entry => skipped.some(other => other.id === entry.id))) throw new Error('A model cannot be both selected and skipped');
        const own = { skipped: 'not picked', date: new Date().toISOString().slice(0, 10) };
        const kept = new Set();
        await updateCatalog(current => {
          for (const entry of skipped) {
            const model = current.models[entry.id];
            if (!model) continue;
            if (Object.keys(model.own?.byType ?? {}).length > 0) kept.add(entry.id);
            else model.own = own;
          }
        });
        for (const entry of skipped) console.log(`${entry.id}: ${kept.has(entry.id) ? 'kept (already benchmarked)' : 'skipped (not picked)'}`);
      }
      return models || auto ? runBenchUnlocked({ models, auto }) : {};
    });
    for (const [id, result] of Object.entries(results)) console.log(`${id}: ${result.done ? 'done' : `partial (${result.reason})`}`);
    return Object.values(results).some(result => !result.done && !['board active', 'low limit'].includes(result.reason)) ? 1 : 0;
  } catch (error) {
    if (error.code === 'BENCH_BUSY') { console.log(error.message); return 0; }
    console.error(`Error: ${error.message}`);
    return 1;
  }
}
