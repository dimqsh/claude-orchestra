import { spawn, execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { jobsDir, canonicalPath, orchestraConfig, atomicJSON } from './paths.mjs';
import { emptyTokens, parseTaskId } from './collect.mjs';
import { formatTokens } from './render.mjs';
import { openKb } from './kb.mjs';

const findingKinds = 'context|file|symbol|fact|command|gotcha|decision';
const findingsInstruction = `\n\nEnd your final answer with a line "## Findings", followed by 0 to 5 lines. List only findings that would help other agents.\nFormat: - [kind] title | path1,path2 | text\nkind is one of: ${findingKinds.replaceAll('|', ', ')}. Paths are relative to the repo root; leave the field empty when there are none. Text is at most 2000 characters. With no findings, leave the section empty.`;

async function memoryPrefix(cwd, title) {
  let kb;
  try {
    // Probe read-only so a missing memory is never created here, then reopen writable:
    // search() counts hits and saved tokens only on a writable handle.
    kb = openKb(cwd, { readOnly: true });
    if (!kb) return '';
    kb.close();
    kb = openKb(cwd);
    const found = kb.search(title, { limit: 5, cwd });   // counts its own fresh hits
    const context = kb.context({ cwd });
    const searched = new Set(found.map(note => note.id));
    const notes = [...new Map([...context, ...found].map(note => [note.id, note])).values()];
    if (!notes.length) return '';
    // Context handed to the provider up front spares it exploration too; count it once.
    kb.recordUse(context.filter(note => !searched.has(note.id)).map(note => note.id), { cwd });
    const { formatNotes } = await import('../scripts/kb.mjs');
    // A UTF-8 byte budget is conservative for Russian as well as English (~1500 tokens).
    let compact = '## Project memory\n', bytes = Buffer.byteLength(compact);
    for (const char of formatNotes(notes)) {
      bytes += Buffer.byteLength(char);
      if (bytes > 6000) break;
      compact += char;
    }
    return `${compact}\n\n`;
  } catch { return ''; }
  finally { try { kb?.close(); } catch { /* Memory must never prevent a run. */ } }
}

function saveFindings(job) {
  let kb, count = 0;
  try {
    const lines = String(job.finalMessage || '').split(/\r?\n/);
    // Models vary the heading: "## Findings", "## Findings:", "**Findings:**", "Findings:".
    // The legacy Russian heading still parses so older runs keep working.
    const heading = lines.findIndex(line => /^\s*(?:#{1,4}\s*)?\**\s*(?:Findings|Находки)\s*:?\s*\**\s*:?\s*$/i.test(line));
    if (heading < 0) return 0;
    // projectRoot identifies shared memory, whereas paths must use this checkout's root.
    let root = job.cwd;
    try { root = canonicalPath(execFileSync('git', ['-C', job.cwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim()); } catch { /* Not a git repo. */ }
    const pattern = new RegExp(`^\\s*-\\s+\\[(${findingKinds})\\]\\s+([^|]+)\\|([^|]*)\\|(.+)$`);
    for (const line of lines.slice(heading + 1)) {
      if (/^#{1,6}\s/.test(line)) break;
      const match = line.match(pattern);
      if (!match || !match[2].trim() || !match[4].trim() || [...match[4].trim()].length > 2000) continue;
      try {
        const paths = match[3].trim() ? match[3].split(',').map(path => {
          if (!path.trim() || path.includes('\0')) throw new Error('Invalid path');
          const normalized = relative(root, canonicalPath(resolve(root, path.trim())));
          if (!normalized || isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${sep}`)) throw new Error('Path outside the project');
          return normalized.split(sep).join('/');
        }) : [];
        kb ||= openKb(job.cwd);
        kb.add({ kind: match[1], title: match[2].trim(), body: match[4].trim(), paths,
          author: `${job.provider} #${job.taskId}`, taskId: job.taskId });
        if (++count === 5) break;
      } catch { /* Skip malformed notes and unavailable/read-only memory. */ }
    }
  } catch { /* Memory errors never change the job result. */ }
  finally { try { kb?.close(); } catch { /* Best effort. */ } }
  return count;
}

function jobResult(job, provider) {
  const seconds = Math.max(0, Math.floor((Date.parse(job.endedAt) - Date.parse(job.startedAt)) / 1000));
  const message = job.status === 'completed' ? job.finalMessage || '' : job.error;
  const hint = provider.errorHint?.(job.error || '') || '';
  return { job, output: `${message}${hint}\n[${provider.name}] #${job.taskId} ${job.status === 'completed' ? 'done' : 'failed'} · ${formatTokens(job.tokens.spent)} tokens · ${Math.floor(seconds / 60)}m${seconds % 60}s · to memory: ${job.memoryCount || 0}`, exitCode: job.status === 'completed' ? 0 : 1 };
}

// Provider definitions own the CLI protocol, defaults, entrypoint and optional live usage.
// buildArgs receives the parsed options/job; parseEvent mutates job/tokens and returns
// { threadStarted, completed, failed } for lifecycle events.
function jobDirectories(provider) {
  return [jobsDir(), ...(provider.legacyJobsDirs || [])];
}
function matchesProvider(job, provider, directory) {
  return job.provider === provider.name || (!job.provider && provider.legacyJobsDirs?.includes(directory));
}
async function readJob(id, provider) {
  for (const directory of jobDirectories(provider)) {
    try {
      const job = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'));
      if (matchesProvider(job, provider, directory)) return job;
    } catch { /* Try the legacy directory when a job is absent or incomplete. */ }
  }
  throw new Error(`Unknown ${provider.displayName} job: ${id}`);
}
async function waitForJob(args, provider) {
  const [id, ...options] = args;
  if (!id || !/^[\w-]+$/.test(id)) throw new Error(`Unknown ${provider.displayName} job`);
  let timeout = 540;
  if (options.length) {
    if (options.length !== 2 || options[0] !== '--timeout' || !options[1].trim()) throw new Error('Usage: wait <jobId> [--timeout 540]');
    timeout = Number(options[1]);
    if (!Number.isFinite(timeout) || timeout < 0) throw new Error('Timeout must be a non-negative number');
  }
  const deadline = performance.now() + timeout * 1000;
  for (;;) {
    const job = await readJob(id, provider);
    if (job.status !== 'running') return jobResult(job, provider);
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { job, output: `[${provider.name}] ${id} still running; call wait again`, exitCode: 3 };
    await new Promise(done => setTimeout(done, Math.min(250, remaining)));
  }
}

export async function runTaskResult({ provider, buildArgs, parseEvent, argv = process.argv.slice(2), prompt }) {
  if (argv[0] === 'wait') return waitForJob(argv.slice(1), provider);
  let child, job, timer, killTimer, liveTimer, liveRead, stopSignal, stopped = false, pollingClosed = false;
  function forwardStop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill(stopSignal);
    killTimer ||= setTimeout(() => child.kill('SIGKILL'), 2000);
    killTimer.unref();
  }
  function stop(signal) {
    stopped = true; stopSignal = signal;
    if (job) job.error = 'stopped';
    forwardStop();
  }
  const onInt = () => stop('SIGINT'), onTerm = () => stop('SIGTERM');
  // Latch cancellation before the first await, including the initial atomic job write.
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  try {
    const args = [...argv];
    function option(name) {
      const index = args.indexOf(name);
      if (index < 0) return null;
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value`);
      return args.splice(index, 2)[1];
    }
    const cwd = canonicalPath(option('--cwd') || process.cwd());
    const model = option('--model') || orchestraConfig()[`${provider.name}Model`] || process.env[`ORCHESTRA_${provider.name.toUpperCase()}_MODEL`] || provider.defaultModel;
    const effort = option('--effort'), write = args.includes('--write'), resume = args.includes('--resume-last'), detach = args.includes('--detach');
    if (args.some(arg => !['--write', '--resume-last', '--detach'].includes(arg))) throw new Error(`Unknown ${provider.displayName} option`);
    if (prompt === undefined) { prompt = ''; for await (const chunk of process.stdin) prompt += chunk; }
    const label = prompt.split(/\r?\n/).find(line => line.trim())?.trimEnd() || '', taskId = parseTaskId(label);
    if (!taskId) throw new Error('The first line of the prompt must start with #<id>');
    if (detach) {
      // Keep the runner alive, with its own process group and no inherited output pipes.
      child = spawn(process.execPath, [fileURLToPath(provider.entrypoint), ...argv.filter(arg => arg !== '--detach')],
        { detached: true, stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
      child.stdin.on('error', () => {});
      const ready = new Promise((accept, reject) => {
        const failed = error => { if (child.connected) child.disconnect(); reject(error); };
        child.once('error', failed);
        child.once('exit', code => failed(new Error(`Could not start the ${provider.displayName} job (${code})`)));
        child.once('message', message => {
          if (child.connected) child.disconnect();
          if (!message.id) { reject(new Error(message.error || `Could not start the ${provider.displayName} job`)); return; }
          child.unref();
          accept({ output: message.id, exitCode: 0 });
        });
      });
      child.stdin.end(prompt);
      return await ready;
    }
    let threadId = null;
    if (resume) {
      const jobs = [];
      const seen = new Set();
      for (const directory of jobDirectories(provider)) {
        for (const file of await readdir(directory).catch(() => [])) {
          if (!file.endsWith('.json') || seen.has(file)) continue;
          try {
            const previous = JSON.parse(await readFile(join(directory, file), 'utf8'));
            if (!matchesProvider(previous, provider, directory)) continue;
            seen.add(file);
            if (previous.cwd && canonicalPath(previous.cwd) === cwd && previous.threadId) jobs.push(previous);
          } catch { /* Unrelated or incomplete job. */ }
        }
      }
      jobs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      threadId = jobs[0]?.threadId || null;
      if (!threadId) throw new Error(`No previous ${provider.displayName} session for this project`);
    }
    const started = Date.now(), id = `${provider.idPrefix}-${started.toString(36)}-${randomInt(36 ** 4).toString(36).padStart(4, '0')}`;
    job = { version: 1, provider: provider.name, id, taskId, label, cwd, model, effort, write, pid: process.pid, status: 'running', startedAt: new Date(started).toISOString(),
      endedAt: null, threadId, activity: `${provider.name}: running`, tokens: emptyTokens(), finalMessage: null, error: null, memoryCount: 0 };
    const path = join(jobsDir(), `${id}.json`);
    let pending = Promise.resolve(), lastWrite = 0, persistenceError;
    function persist() {
      lastWrite = Date.now();
      const copy = structuredClone(job);
      pending = pending.then(() => atomicJSON(path, copy)).catch(error => { persistenceError = error; });
      return pending;
    }
    function schedule() {
      if (timer) return;
      timer = setTimeout(() => { timer = null; void persist(); }, Math.max(0, 1000 - (Date.now() - lastWrite)));
      timer.unref();
    }
    await persist();
    if (persistenceError) throw persistenceError;
    if (process.send) process.send({ id }, () => {});
    const title = label.trim().slice(taskId.length + 1).trim();
    prompt = await memoryPrefix(cwd, title) + prompt + findingsInstruction;
    let reader = threadId ? provider.createTokenReader?.(threadId) : null, baseline = null, baselineKnown = !resume;
    if (resume && reader && !stopped) {
      try { baseline = await reader.read(); baselineKnown = baseline !== null; }
      catch { /* Without a baseline, publish authoritative turn usage only. */ }
    }
    const completedTokens = emptyTokens();
    function refreshLive() {
      if (pollingClosed || liveRead || !reader || !baselineKnown) return;
      liveRead = reader.read().then(total => {
        if (!total || pollingClosed) return;
        const previous = JSON.stringify(job.tokens);
        const liveTokens = provider.tokenDelta(total, baseline);
        for (const key of Object.keys(job.tokens)) job.tokens[key] = Math.max(job.tokens[key], liveTokens[key], completedTokens[key]);
        job.tokens.spent = job.tokens.input + job.tokens.output;
        if (JSON.stringify(job.tokens) !== previous) schedule();
      }).catch(() => { /* Rollouts may not exist yet, or be temporarily unavailable. */ }).finally(() => { liveRead = null; });
    }
    liveTimer = setInterval(refreshLive, 2000);
    liveTimer.unref();
    const childArgs = buildArgs({ ...job, resume });
    let completed = false, failed = false, stderr = '', buffer = '', spawnError = null;
    const handle = line => {
      try {
        const event = JSON.parse(line);
        const previousThread = job.threadId;
        const outcome = parseEvent(job, event, completedTokens) || {};
        if (job.threadId && job.threadId !== previousThread) {
          reader = provider.createTokenReader?.(job.threadId);
          baseline = null; baselineKnown = true;
        }
        if (outcome.threadStarted || job.threadId !== previousThread) refreshLive();
        if (outcome.completed) { completed = true; failed = false; job.error = null; }
        if (outcome.failed) failed = true;
        schedule();
      } catch { /* non-JSON diagnostics are not protocol events */ }
    };
    let code;
    try {
      if (!stopped) {
        child = spawn(provider.command, childArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', data => {
          buffer += data;
          let end;
          while ((end = buffer.indexOf('\n')) !== -1) { handle(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
        });
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-16384); });
        child.stdin.on('error', () => {});
        code = await new Promise(resolveExit => {
          child.on('error', error => { spawnError = error; });
          child.on('close', value => resolveExit(value));
          // A signal may have arrived inside spawn(), before child was assigned, or before
          // the native process was ready to receive it. Replay the latched signal in both cases.
          child.once('spawn', () => { if (stopped) forwardStop(); });
          if (stopped) forwardStop();
          else child.stdin.end(prompt);
        });
        if (buffer.trim()) handle(buffer);
      }
    } catch (error) {
      spawnError = error;
    }
    pollingClosed = true;
    clearInterval(liveTimer);
    await liveRead;
    clearTimeout(timer);
    job.memoryCount = saveFindings(job);
    let finalizedStop;
    do {
      finalizedStop = stopped;
      job.status = code === 0 && completed && !failed && !stopped ? 'completed' : 'failed';
      if (job.status === 'completed') job.tokens = { ...completedTokens };
      if (job.status === 'failed') job.error = stopped ? 'stopped' : spawnError?.message || job.error || stderr.trim() || `${provider.displayName} exited with code ${code}`;
      else job.error = null;
      job.endedAt = new Date().toISOString();
      await persist();
    } while (finalizedStop !== stopped);
    if (persistenceError) throw persistenceError;
    return jobResult(job, provider);
  } finally {
    pollingClosed = true;
    clearInterval(liveTimer);
    await liveRead;
    clearTimeout(timer); clearTimeout(killTimer);
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
  }
}
// Preserve the structured result API used by the Codex wrapper's existing callers.
// CLI providers use runTask: it prints exactly one result and resolves to an exit code.
export async function runTask(options) {
  try {
    const result = await runTaskResult(options);
    console.log(result.output);
    return result.exitCode;
  } catch (error) {
    if (process.send) process.send({ error: error.message }, () => {});
    console.error(`Error: ${String(error.message).replace(/[\r\n]/g, ' ')}`);
    return 1;
  }
}
