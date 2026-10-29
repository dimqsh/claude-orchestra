#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { readdir, readFile, open } from 'node:fs/promises';
import { join, basename, resolve, relative, sep, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { codexHome, codexJobsDir, canonicalPath, orchestraConfig, atomicJSON } from '../lib/paths.mjs';
import { emptyTokens, addTokens, codexTokens, parseTaskId } from '../lib/collect.mjs';
import { formatTokens } from '../lib/render.mjs';
import { openKb } from '../lib/kb.mjs';

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
    // Context handed to Codex up front spares it exploration too; count it once.
    kb.recordUse(context.filter(note => !searched.has(note.id)).map(note => note.id), { cwd });
    const { formatNotes } = await import('./kb.mjs');
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
          author: `codex #${job.taskId}`, taskId: job.taskId });
        if (++count === 5) break;
      } catch { /* Skip malformed notes and unavailable/read-only memory. */ }
    }
  } catch { /* Memory errors never change the job result. */ }
  finally { try { kb?.close(); } catch { /* Best effort. */ } }
  return count;
}

function jobResult(job) {
  const seconds = Math.max(0, Math.floor((Date.parse(job.endedAt) - Date.parse(job.startedAt)) / 1000));
  const message = job.status === 'completed' ? job.finalMessage || '' : job.error;
  const hint = /not supported/i.test(job.error || '') ? '\nupdate the Codex CLI: codex update' : '';
  return { job, output: `${message}${hint}\n[codex] #${job.taskId} ${job.status === 'completed' ? 'done' : 'failed'} · ${formatTokens(job.tokens.spent)} tokens · ${Math.floor(seconds / 60)}m${seconds % 60}s · to memory: ${job.memoryCount || 0}`, exitCode: job.status === 'completed' ? 0 : 1 };
}

async function waitForJob(args) {
  const [id, ...options] = args;
  if (!id || !/^[\w-]+$/.test(id)) throw new Error('Unknown Codex job');
  let timeout = 540;
  if (options.length) {
    if (options.length !== 2 || options[0] !== '--timeout' || !options[1].trim()) throw new Error('Usage: wait <jobId> [--timeout 540]');
    timeout = Number(options[1]);
    if (!Number.isFinite(timeout) || timeout < 0) throw new Error('Timeout must be a non-negative number');
  }
  const deadline = performance.now() + timeout * 1000;
  for (;;) {
    let job;
    try { job = JSON.parse(await readFile(join(codexJobsDir(), `${id}.json`), 'utf8')); }
    catch { throw new Error(`Unknown Codex job: ${id}`); }
    if (job.status !== 'running') return jobResult(job);
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { job, output: `[codex] ${id} still running; call wait again`, exitCode: 3 };
    await new Promise(done => setTimeout(done, Math.min(250, remaining)));
  }
}

function commandActivity(command) {
  let text = String(command || '').trim();
  const wrapper = text.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+([\s\S]+)$/);
  if (wrapper) {
    const argument = wrapper[1];
    // Decode one shell word, without evaluating substitutions or executing a shell.
    let inner = '', quote = null, valid = true;
    for (let i = 0; i < argument.length; i++) {
      const char = argument[i];
      if (quote === "'") {
        if (char === "'") quote = null;
        else inner += char;
      } else if (quote === '"') {
        if (char === '"') quote = null;
        else if (char === '\\' && /[\$`"\\\n]/.test(argument[i + 1] || '')) inner += argument[++i];
        else inner += char;
      } else if (char === "'" || char === '"') quote = char;
      else if (char === '\\' && i + 1 < argument.length) inner += argument[++i];
      else if (/[;&|<>()]/.test(char)) { valid = false; break; }
      else if (/\s/.test(char)) {
        if (argument.slice(i).trim()) valid = false; // Extra shell arguments: preserve the original.
        break;
      } else inner += char;
    }
    if (valid && !quote && inner) text = inner;
  }
  return `Bash ${text.replace(/\s+/g, ' ').trim().slice(0, 40)}`;
}

async function findRollout(threadId) {
  if (!/^[\w-]+$/.test(threadId)) return null;
  const root = join(codexHome, 'sessions'), suffix = `-${threadId}.jsonl`;
  const entries = async path => readdir(path, { withFileTypes: true }).catch(() => []);
  const visited = new Set();
  for (const daysAgo of [0, 1]) {
    const date = new Date(); date.setDate(date.getDate() - daysAgo);
    const dir = join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    visited.add(dir);
    const match = (await entries(dir)).find(entry => entry.isFile() && entry.name.endsWith(suffix));
    if (match) return join(dir, match.name);
  }
  // Old resumed threads can be elsewhere. Bound both the depth and traversal work.
  let directories = 256, remaining = 8192;
  async function walk(dir, depth) {
    if (visited.has(dir) || depth > 3 || directories-- <= 0 || remaining <= 0) return null;
    visited.add(dir);
    const items = (await entries(dir)).sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of items) {
      if (remaining-- <= 0) return null;
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(suffix)) return path;
      if (entry.isDirectory()) { const found = await walk(path, depth + 1); if (found) return found; }
    }
    return null;
  }
  return walk(root, 0);
}

class RolloutReader {
  constructor(threadId) {
    this.threadId = threadId; this.path = null; this.offset = 0;
    this.partial = Buffer.alloc(0); this.identity = null; this.total = null;
  }
  parse(line) {
    try {
      const event = JSON.parse(line.toString('utf8'));
      const usage = event.type === 'event_msg' && event.payload?.type === 'token_count' && event.payload.info?.total_token_usage;
      if (usage && typeof usage === 'object') this.total = usage;
    } catch { /* Incomplete final lines and non-JSON diagnostics are harmless. */ }
  }
  async read() {
    this.path ||= await findRollout(this.threadId);
    if (!this.path) return null;
    const file = await open(this.path, 'r');
    try {
      const info = await file.stat(), identity = `${info.dev}:${info.ino}`;
      if (this.identity !== identity || info.size < this.offset) { this.offset = 0; this.partial = Buffer.alloc(0); }
      this.identity = identity;
      const buffer = Buffer.allocUnsafe(256 * 1024);
      while (this.offset < info.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const data = Buffer.concat([this.partial, buffer.subarray(0, bytesRead)]);
        let start = 0, end;
        while ((end = data.indexOf(10, start)) !== -1) { this.parse(data.subarray(start, end)); start = end + 1; }
        this.partial = Buffer.from(data.subarray(start));
      }
      // Keep the tail for the next append, even if it is already valid JSON without a newline.
      if (this.partial.length) this.parse(this.partial);
      return this.total;
    } finally { await file.close(); }
  }
}
const tokenDelta = (total, baseline) => codexTokens(Object.fromEntries(['input_tokens', 'cached_input_tokens', 'output_tokens'].map(key => [key, Math.max(0, (Number(total[key]) || 0) - (Number(baseline?.[key]) || 0))])));
function raiseTokens(target, ...sources) {
  for (const key of Object.keys(target)) target[key] = Math.max(target[key], ...sources.map(source => source[key]));
  target.spent = target.input + target.output;
}

export function applyCodexEvent(job, event, completedTokens = job.tokens) {
  if (event.type === 'thread.started') job.threadId = event.thread_id;
  if (event.type === 'turn.started') job.activity = 'codex: running';
  if (event.type === 'turn.completed') {
    addTokens(completedTokens, codexTokens(event.usage));
    raiseTokens(job.tokens, completedTokens);
  }
  if (event.type === 'turn.failed') job.error = event.error?.message || String(event.error || 'Codex error');
  if (event.type === 'error') job.error = event.message || 'Codex error';
  if (['item.started', 'item.updated', 'item.completed'].includes(event.type) && event.item) {
    const item = event.item;
    if (item.type === 'command_execution') job.activity = commandActivity(item.command);
    else if (item.type === 'file_change') job.activity = `editing ${basename(item.changes?.[0]?.path || '')}`;
    else if (item.type === 'agent_message') {
      job.activity = 'answering';
      if (event.type === 'item.completed') job.finalMessage = item.text || '';
    } else if (item.type === 'reasoning') job.activity = 'thinking';
    else job.activity = item.type || 'codex: running';
  }
}
export async function runCodexTask(argv = process.argv.slice(2), prompt) {
  if (argv[0] === 'wait') return waitForJob(argv.slice(1));
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
    const model = option('--model') || orchestraConfig().codexModel || process.env.ORCHESTRA_CODEX_MODEL || 'gpt-6.1-sol';
    const effort = option('--effort'), write = args.includes('--write'), resume = args.includes('--resume-last'), detach = args.includes('--detach');
    if (args.some(arg => !['--write', '--resume-last', '--detach'].includes(arg))) throw new Error('Unknown Codex option');
    if (prompt === undefined) { prompt = ''; for await (const chunk of process.stdin) prompt += chunk; }
    const label = prompt.split(/\r?\n/).find(line => line.trim())?.trimEnd() || '', taskId = parseTaskId(label);
    if (!taskId) throw new Error('The first line of the prompt must start with #<id>');
    if (detach) {
      // Keep the runner alive, with its own process group and no inherited output pipes.
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv.filter(arg => arg !== '--detach')],
        { detached: true, stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
      child.stdin.on('error', () => {});
      const ready = new Promise((accept, reject) => {
        const failed = error => { if (child.connected) child.disconnect(); reject(error); };
        child.once('error', failed);
        child.once('exit', code => failed(new Error(`Could not start the Codex job (${code})`)));
        child.once('message', message => {
          if (child.connected) child.disconnect();
          if (!message.id) { reject(new Error(message.error || 'Could not start the Codex job')); return; }
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
      for (const file of await readdir(codexJobsDir()).catch(() => [])) {
        if (!file.endsWith('.json')) continue;
        try {
          const job = JSON.parse(await readFile(join(codexJobsDir(), file), 'utf8'));
          if (job.cwd && canonicalPath(job.cwd) === cwd && job.threadId) jobs.push(job);
        } catch { /* unrelated or incomplete job */ }
      }
      jobs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      threadId = jobs[0]?.threadId || null;
      if (!threadId) throw new Error('No previous Codex session for this project');
    }
    const started = Date.now(), id = `cx-${started.toString(36)}-${randomInt(36 ** 4).toString(36).padStart(4, '0')}`;
    job = { version: 1, id, taskId, label, cwd, model, effort, write, pid: process.pid, status: 'running', startedAt: new Date(started).toISOString(),
      endedAt: null, threadId, activity: 'codex: running', tokens: emptyTokens(), finalMessage: null, error: null, memoryCount: 0 };
    const path = join(codexJobsDir(), `${id}.json`);
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
    let reader = threadId ? new RolloutReader(threadId) : null, baseline = null, baselineKnown = !resume;
    if (resume && !stopped) {
      try { baseline = await reader.read(); baselineKnown = baseline !== null; }
      catch { /* Without a baseline, publish authoritative turn usage only. */ }
    }
    const completedTokens = emptyTokens();
    function refreshLive() {
      if (pollingClosed || liveRead || !reader || !baselineKnown) return;
      liveRead = reader.read().then(total => {
        if (!total || pollingClosed) return;
        const previous = JSON.stringify(job.tokens);
        raiseTokens(job.tokens, tokenDelta(total, baseline), completedTokens);
        if (JSON.stringify(job.tokens) !== previous) schedule();
      }).catch(() => { /* Rollouts may not exist yet, or be temporarily unavailable. */ }).finally(() => { liveRead = null; });
    }
    liveTimer = setInterval(refreshLive, 2000);
    liveTimer.unref();
    const sandbox = write ? 'workspace-write' : 'read-only';
    const childArgs = resume
      ? ['exec', 'resume', threadId, '-m', model, '-c', `sandbox_mode="${sandbox}"`, '--json', '--skip-git-repo-check']
      : ['exec', '--json', '--skip-git-repo-check', '-m', model];
    if (effort) childArgs.push('-c', `model_reasoning_effort=${effort}`);
    if (!resume) childArgs.push('-s', sandbox, '-C', cwd);
    childArgs.push('-');
    let completed = false, failed = false, stderr = '', buffer = '', spawnError = null;
    const handle = line => {
      try {
        const event = JSON.parse(line);
        applyCodexEvent(job, event, completedTokens);
        if (event.type === 'thread.started') {
          if (reader?.threadId !== job.threadId) { reader = new RolloutReader(job.threadId); baseline = null; baselineKnown = true; }
          refreshLive();
        }
        if (event.type === 'turn.completed') { completed = true; failed = false; job.error = null; }
        if (event.type === 'turn.failed') failed = true;
        schedule();
      } catch { /* non-JSON diagnostics are not protocol events */ }
    };
    let code;
    try {
      if (!stopped) {
        child = spawn('codex', childArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
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
      if (job.status === 'failed') job.error = stopped ? 'stopped' : spawnError?.message || job.error || stderr.trim() || `Codex exited with code ${code}`;
      else job.error = null;
      job.endedAt = new Date().toISOString();
      await persist();
    } while (finalizedStop !== stopped);
    if (persistenceError) throw persistenceError;
    return jobResult(job);
  } finally {
    pollingClosed = true;
    clearInterval(liveTimer);
    await liveRead;
    clearTimeout(timer); clearTimeout(killTimer);
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await runCodexTask(); console.log(result.output); process.exitCode = result.exitCode; }
  catch (error) {
    if (process.send) process.send({ error: error.message }, () => {});
    console.error(`Error: ${String(error.message).replace(/[\r\n]/g, ' ')}`); process.exitCode = 1;
  }
}
