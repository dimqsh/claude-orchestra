import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { entryId, readCatalog, updateCatalog } from './catalog.mjs';
import { maxUsedPercent, readLimits } from './limits.mjs';
import { orchestraConfig, orchestraHome } from './paths.mjs';

const TYPES = ['bug', 'logic', 'refactor', 'tests', 'docs', 'multi'];
const CAP = 150000;
const fixtures = fileURLToPath(new URL('../bench/', import.meta.url));
const codexScript = fileURLToPath(new URL('../scripts/codex-task.mjs', import.meta.url));

/** Injectable model-command runner: ({ command, args, cwd, input }) -> { code, stdout, stderr }. */
function commandRunner({ command, args, cwd, input = '', timeout }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('error', reject);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
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

function selectModels(catalog, models, auto) {
  const entries = Object.values(catalog.models);
  if (auto && orchestraConfig().benchAuto !== true) return [];
  const selected = models === undefined && auto ? entries : (models ?? []).map(name => {
    const exact = catalog.models[name];
    if (exact) return exact;
    const matches = entries.filter(entry => entry.model === name);
    if (!matches.length) throw new Error(`Unknown model: ${name}`);
    if (matches.length > 1) throw new Error(`Ambiguous model: ${name}; use provider:model`);
    return matches[0];
  });
  return [...new Map(selected.filter(entry => !auto || entry.own == null)
    .map(entry => [entryId(entry.provider, entry.model), entry])).values()];
}

function requestFor(entry, cwd, input) {
  if (entry.provider === 'claude') {
    const alias = entry.alias ?? entry.model.match(/(?:^|-)(haiku|sonnet|fable)(?:-|$)/)?.[1] ?? entry.model;
    return { command: 'claude', args: ['-p', '--model', alias, '--output-format', 'json'], cwd, input };
  }
  if (entry.provider === 'codex') {
    const args = [codexScript, '--cwd', cwd, '--model', entry.model];
    if (entry.effort) args.push('--effort', entry.effort);
    args.push('--write');
    return { command: process.execPath, args, cwd, input };
  }
  throw new Error(`Unsupported benchmark provider: ${entry.provider}`);
}

function measuredUsage(entry, response, type, elapsed) {
  if (entry.provider === 'claude') {
    let value;
    try { value = JSON.parse(response.stdout); } catch { throw new Error('Missing or invalid Claude usage'); }
    const counts = ['input_tokens', 'cache_creation_input_tokens', 'output_tokens'].map(key => value.usage?.[key] ?? 0);
    if (!value.usage || value.usage.input_tokens == null || value.usage.output_tokens == null ||
        !counts.every(n => Number.isFinite(n) && n >= 0)) throw new Error('Missing or invalid Claude usage');
    return { tokens: counts.reduce((sum, n) => sum + n, 0), seconds: elapsed, ok: response.code === 0 && !value.is_error };
  }
  // The last nonempty line is the runner footer; earlier text can contain examples of footers.
  const footer = String(response.stdout).trim().split(/\r?\n/).at(-1);
  const match = footer.match(/^\[codex\] #([\w.-]+) (done|failed) · (\d+(?:\.\d+)?)([kM]?) tokens · (\d+)m(\d+)s(?: · to memory: \d+)?$/);
  if (!match || match[1] !== `B-${type}`) throw new Error('Missing or invalid Codex usage footer');
  const multiplier = { '': 1, k: 1000, M: 1000000 }[match[4]];
  return { tokens: Math.round(Number(match[3]) * multiplier), seconds: Number(match[5]) * 60 + Number(match[6]),
    ok: response.code === 0 && match[2] === 'done' };
}

async function runTask(entry, type, runner) {
  const fixture = join(fixtures, type);
  const cwd = await mkdtemp(join(tmpdir(), 'orchestra-bench-'));
  try {
    await cp(join(fixture, 'repo'), cwd, { recursive: true });
    const input = await readFile(join(fixture, 'brief.md'), 'utf8');
    const request = requestFor(entry, cwd, input);
    const initialized = await commandRunner({ command: 'git', args: ['init', '--quiet'], cwd });
    if (initialized.code !== 0) throw new Error('Cannot initialize benchmark repository');
    const started = performance.now();
    const response = await runner(request);
    const usage = measuredUsage(entry, response, type, (performance.now() - started) / 1000);
    const check = await commandRunner({ command: process.execPath, args: [join(fixture, 'check.mjs'), cwd], cwd, timeout: 10000 });
    return { passed: usage.ok && check.code === 0 ? 1 : 0, total: 1, tokens: usage.tokens, seconds: usage.seconds };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

/**
 * Run strictly sequentially, with a fresh temporary repo for every task. The cap is per model.
 * CLI usage is reported at completion, so no next task starts after the measured cap is reached.
 * @param {{models?: string[], auto?: boolean, cap?: number, runner?: Function}} options
 */
export async function runBench({ models, auto = false, cap = CAP, runner = commandRunner } = {}) {
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error('Benchmark cap must be a positive integer');
  const entries = selectModels(await readCatalog(), models, auto);
  const results = {};
  for (const entry of entries) {
    const id = entryId(entry.provider, entry.model);
    const result = { done: false, byType: {} };
    results[id] = result;
    let tokens = 0, attempted = false;
    for (const type of TYPES) {
      if (tokens >= cap) { result.reason = 'token cap'; break; }
      if (auto) {
        const reason = await benchPostponeReason(entry.provider);
        if (reason) { result.reason = reason; break; }
      }
      attempted = true;
      try {
        const score = await runTask(entry, type, runner);
        result.byType[type] = score;
        tokens += score.tokens;
      } catch (error) {
        // Unknown usage cannot be treated as zero: stop rather than silently bypassing the cap.
        result.reason = error.message;
        break;
      }
    }
    result.done = Object.keys(result.byType).length === TYPES.length;
    if (attempted) {
      const own = { date: new Date().toISOString().slice(0, 10), partial: !result.done,
        ...(result.reason ? { reason: result.reason } : {}), byType: result.byType };
      // All commands and fixture I/O are complete before taking the catalog lock.
      await updateCatalog(catalog => {
        if (catalog.models[id]) catalog.models[id].own = own;
      });
    }
  }
  return results;
}

/** Called by scripts/models.mjs with the arguments following `bench`. Returns an exit code. */
export async function runBenchCli(argv) {
  try {
    let models, auto = false, estimate = false;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--models' && models === undefined) {
        const value = argv[++i];
        if (!value || value.startsWith('--') || value.split(',').some(name => !name.trim())) throw new Error('--models requires a comma-separated model list');
        models = value.split(',').map(name => name.trim());
      } else if (arg === '--new' && !auto) auto = true;
      else if (arg === '--estimate' && !estimate) estimate = true;
      else throw new Error(`Unknown benchmark option: ${arg}`);
    }
    if (auto && models) throw new Error('Use either --models or --new');
    if (!estimate && !auto && !models) throw new Error('Usage: bench --models a,b | --new | --estimate');
    if (estimate) {
      const catalog = await readCatalog();
      const names = models ?? (auto ? undefined : Object.keys(catalog.models));
      for (const entry of selectModels(catalog, names, auto)) {
        console.log(`${entryId(entry.provider, entry.model)}: ${CAP} tokens per model (budget estimate)`);
      }
      return 0;
    }
    const results = await runBench({ models, auto });
    for (const [id, result] of Object.entries(results)) {
      console.log(`${id}: ${result.done ? 'done' : `partial (${result.reason})`}`);
    }
    return Object.values(results).some(result => !result.done && !['board active', 'low limit'].includes(result.reason)) ? 1 : 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return 1;
  }
}
