#!/usr/bin/env node
import { readdir, open } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codexHome, codexJobsDir } from '../lib/paths.mjs';
import { addTokens, codexTokens } from '../lib/collect.mjs';
import { runTask, runTaskResult } from '../lib/runner.mjs';

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
  return { threadStarted: event.type === 'thread.started', completed: event.type === 'turn.completed', failed: event.type === 'turn.failed' };
}

const provider = {
  name: 'codex', displayName: 'Codex', command: 'codex', idPrefix: 'cx', defaultModel: 'gpt-6.1-sol',
  entrypoint: import.meta.url, legacyJobsDirs: [codexJobsDir()],
  createTokenReader: threadId => new RolloutReader(threadId), tokenDelta,
  errorHint: error => /not supported/i.test(error) ? '\nupdate the Codex CLI: codex update' : '',
};
function buildArgs({ cwd, model, effort, write, resume, threadId }) {
  const sandbox = write ? 'workspace-write' : 'read-only';
  const args = resume
    ? ['exec', 'resume', threadId, '-m', model, '-c', `sandbox_mode="${sandbox}"`, '--json', '--skip-git-repo-check']
    : ['exec', '--json', '--skip-git-repo-check', '-m', model];
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  if (!resume) args.push('-s', sandbox, '-C', cwd);
  return [...args, '-'];
}
export function runCodexTask(argv = process.argv.slice(2), prompt) {
  return runTaskResult({ provider, buildArgs, parseEvent: applyCodexEvent, argv, prompt });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runTask({ provider, buildArgs, parseEvent: applyCodexEvent });
}
