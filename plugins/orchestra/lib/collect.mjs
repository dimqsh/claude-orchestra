import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, basename, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claudeConfigDir, codexHome, orchestraHome, projectSlug, projectDir, boardPath, cacheDir, jobsDir, codexJobsDir, codexStateRoots, canonicalPath, atomicJSON } from './paths.mjs';

const execFileAsync = promisify(execFile);
const number = value => Math.max(0, Number(value) || 0);
export const emptyTokens = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, spent: 0 });
export function addTokens(target, tokens) {
  for (const key of Object.keys(emptyTokens())) target[key] += number(tokens?.[key]);
  return target;
}
export function claudeTokens(usage = {}) {
  const input = number(usage.input_tokens), cacheWrite = number(usage.cache_creation_input_tokens);
  const cacheRead = number(usage.cache_read_input_tokens), output = number(usage.output_tokens);
  return { input, cacheWrite, cacheRead, output, spent: input + cacheWrite + output };
}
export function codexTokens(usage = {}) {
  const cacheRead = number(usage.cached_input_tokens), input = Math.max(0, number(usage.input_tokens) - cacheRead);
  const output = number(usage.output_tokens);
  return { input, cacheWrite: 0, cacheRead, output, spent: input + output };
}
export const parseTaskId = label => String(label || '').match(/^#([\w.-]+)\b/)?.[1] || null;
const realModel = model => typeof model === 'string' && model && !/^<.*>$/.test(model.trim()) ? model : null;
export function executorFor(model = '') {
  return ['opus', 'sonnet', 'haiku', 'fable'].find(name => String(realModel(model) || '').toLowerCase().includes(name)) || 'other';
}
export async function readJSON(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
async function entries(path) { try { return await readdir(path, { withFileTypes: true }); } catch { return []; } }
const textContent = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(c => c.text || '').join('\n') : '';
const statusFor = value => /fail|error/i.test(value) ? 'failed' : /stop|cancel|kill|interrupt/i.test(value) ? 'stopped' : /complet|done|success/i.test(value) ? 'completed' : 'running';
const activityFor = (status, activity) => ({ completed: 'finished', failed: 'failed', stopped: 'stopped' })[status] || activity;
export function toolActivity(name, input = {}) {
  if (name === 'Bash') return `Bash ${String(input.command || '').slice(0, 80)}`;
  if (['Edit', 'Write', 'Read'].includes(name)) return `${name} ${basename(input.file_path || input.path || '')}`;
  return name || '';
}
function initialState() {
  return { tokens: emptyTokens(), ids: {}, model: null, requestedModel: null, cwd: null, first: null, last: null, activity: '', launches: {}, results: {}, notifications: {}, turnDone: false };
}
function reduceRecord(state, row, mode) {
  if (mode === 'codex') {
    if (row.type === 'turn_context') state.model = row.payload?.model || state.model;
    if (row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.info) {
      state.tokens = codexTokens(row.payload.info.total_token_usage);
    }
    return;
  }
  // Request blobs contain copies of messages and prompts, not transcript events.
  if (!['assistant', 'user', 'system', 'queue-operation', 'attachment', 'progress'].includes(row.type)) return;
  if (mode === 'main' && row.isSidechain === true) return;
  state.cwd = row.cwd || state.cwd;
  state.requestedModel = realModel(row.requestedModel) || state.requestedModel;
  if (row.timestamp) { state.first ||= row.timestamp; state.last = row.timestamp; }
  const message = row.message || {};
  const content = Array.isArray(message.content) ? message.content : [];
  if (row.type === 'assistant') {
    state.model = realModel(message.model) || state.model;
    if (message.usage && (!message.id || !Object.hasOwn(state.ids, message.id))) {
      addTokens(state.tokens, claudeTokens(message.usage));
      if (message.id) state.ids[message.id] = true;
    }
    for (const item of content) {
      if (item.type === 'tool_use') {
        state.activity = toolActivity(item.name, item.input);
        state.turnDone = false;
        if (['Agent', 'Task'].includes(item.name)) state.launches[item.id] = {
          toolUseId: item.id, description: item.input?.description || '', type: item.input?.subagent_type || 'general-purpose',
          model: item.input?.model || null, startedAt: row.timestamp, background: !!item.input?.run_in_background,
        };
      } else if (item.type === 'text') state.activity = 'answering';
      else if (item.type === 'thinking') state.activity = 'thinking';
    }
    if (message.stop_reason === 'end_turn') state.turnDone = true;
  }
  for (const item of content) {
    if (item.type !== 'tool_result') continue;
    const text = textContent(item.content), meta = row.toolUseResult || {};
    const agentId = meta.agentId || text.match(/agentId:\s*([\w.-]+)/)?.[1];
    if (agentId || state.launches[item.tool_use_id]) state.results[item.tool_use_id] = {
      agentId: agentId || null, endedAt: row.timestamp, failed: !!item.is_error,
      background: meta.isAsync === true || meta.status === 'async_launched' || !!state.launches[item.tool_use_id]?.background || /Async agent launched|working in (?:the )?background/i.test(text),
      model: meta.resolvedModel || null,
    };
  }
  const texts = [textContent(message.content), typeof row.content === 'string' ? row.content : '', row.attachment?.type === 'queued_command' ? row.attachment.prompt : ''];
  for (const text of texts) {
    for (const match of (text || '').matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const id = match[1].match(/<task-id>\s*([^<]+?)\s*<\/task-id>/)?.[1];
      const status = match[1].match(/<status>\s*([^<]+?)\s*<\/status>/)?.[1];
      const toolId = match[1].match(/<tool-use-id>\s*([^<]+?)\s*<\/tool-use-id>/)?.[1];
      if (id && status) {
        const notification = { status: statusFor(status), endedAt: row.timestamp || state.last };
        state.notifications[id] = notification;
        if (toolId) state.notifications[toolId] = notification;
      }
    }
  }
}

// On-disk aggregates make a fresh statusline process as cheap as an in-process refresh.
async function parseFile(path, mode = 'main') {
  const info = await stat(path);
  const key = createHash('sha256').update(`${resolve(path)}:${info.dev}:${info.ino}:${mode}`).digest('hex');
  const cachePath = join(cacheDir(), `${key}.json`);
  let cached = await readJSON(cachePath);
  if (!cached || cached.version !== 2 || cached.offset > info.size || (cached.offset === info.size && cached.mtime !== info.mtimeMs)) cached = { version: 2, offset: 0, partial: '', state: initialState() };
  if (cached.offset < info.size) {
    const state = cached.state;
    let partial = Buffer.from(cached.partial, 'base64');
    for await (const chunk of createReadStream(path, { start: cached.offset, end: info.size - 1 })) {
      const data = partial.length ? Buffer.concat([partial, chunk]) : chunk;
      let start = 0, end;
      while ((end = data.indexOf(10, start)) !== -1) {
        try { reduceRecord(state, JSON.parse(data.subarray(start, end).toString('utf8')), mode); } catch { /* torn or unknown records */ }
        start = end + 1;
      }
      partial = Buffer.from(data.subarray(start));
    }
    cached.offset = info.size;
    cached.partial = partial.toString('base64');
    cached.mtime = info.mtimeMs;
    await atomicJSON(cachePath, cached).catch(() => {});
  }
  // A complete final JSON object without a newline is usable, but never committed twice.
  const state = structuredClone(cached.state);
  if (cached.partial) {
    try { reduceRecord(state, JSON.parse(Buffer.from(cached.partial, 'base64').toString('utf8')), mode); } catch { /* incomplete final record */ }
  }
  return { state, info };
}
const gitMemory = new Map();
async function projectInfo(cwd) {
  const key = canonicalPath(cwd), path = join(cacheDir(), `git-${createHash('sha256').update(key).digest('hex')}.json`);
  const saved = gitMemory.get(key) || await readJSON(path);
  if (saved?.version === 2 && Date.now() - saved.time < 5000) return saved.value;
  let root = key, branch = null;
  try {
    const [identity, currentBranch] = await Promise.all([
      execFileAsync('git', ['-C', key, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 500, maxBuffer: 4096 }),
      execFileAsync('git', ['-C', key, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 500, maxBuffer: 4096 }).catch(() => null),
    ]);
    root = canonicalPath(dirname(identity.stdout.trim()));
    branch = currentBranch?.stdout.trim() || null;
  } catch { /* not a git repository */ }
  const value = { name: basename(root), cwd: root, branch }, cache = { version: 2, time: Date.now(), value };
  gitMemory.set(key, cache);
  await atomicJSON(path, cache).catch(() => {});
  return value;
}
export async function projectRoot(cwd) { return (await projectInfo(cwd)).cwd; }
const kbMemory = new Map();
async function memoryStats(root) {
  const path = join(cacheDir(), `kb-${createHash('sha256').update(root).digest('hex')}.json`);
  const saved = kbMemory.get(root) || await readJSON(path);
  if (saved?.version === 1 && Date.now() - saved.time < 5000) return saved.value;
  let value = null, db;
  try {
    // Guard the read-only API as well: a HUD refresh must never create a database.
    const info = await stat(join(orchestraHome, 'kb', `${projectSlug(root)}.sqlite`));
    if (info.isFile()) {
      const kb = await import('./kb.mjs');
      db = await kb.openKb(root, { readOnly: true });
      if (db) value = await db.stats();
    }
  } catch { /* Optional module, absent/locked database, or unsupported SQLite runtime. */ }
  finally { try { await db?.close(); } catch { /* best-effort close */ } }
  const cached = { version: 1, time: Date.now(), value };
  kbMemory.set(root, cached);
  await atomicJSON(path, cached).catch(() => {});
  return value;
}
async function belongsToProject(cwd, root) {
  const candidate = canonicalPath(cwd), path = relative(root, candidate);
  if (!path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))) return true;
  // Linked worktrees may also be outside the main checkout's directory.
  return await projectRoot(candidate) === root;
}
async function rolloutFor(threadId, date) {
  if (!threadId || !/^[\w-]+$/.test(threadId)) return null;
  const root = join(codexHome, 'sessions');
  const day = String(date || '').slice(0, 10).replaceAll('-', '/');
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(day)) {
    const match = (await entries(join(root, day))).find(e => e.name.endsWith(`${threadId}.jsonl`));
    if (match) return join(root, day, match.name);
  }
  async function walk(dir, depth) {
    if (depth > 3) return null;
    for (const entry of await entries(dir)) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) return path;
      if (entry.isDirectory()) { const found = await walk(path, depth + 1); if (found) return found; }
    }
    return null;
  }
  return walk(root, 0);
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export async function collectCodexJobs(cwd) {
  const workspace = await projectRoot(cwd), jobs = new Map();
  for (const directory of [jobsDir(), codexJobsDir()]) {
    for (const entry of await entries(directory)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const job = await readJSON(join(directory, entry.name));
      if (!job?.id || !job.cwd || jobs.has(job.id) || !await belongsToProject(job.cwd, workspace)) continue;
      const provider = job.provider || 'codex';
      jobs.set(job.id, {
        id: job.id, kind: provider, type: provider, executor: provider, model: job.model || null,
        description: job.label || '', taskId: parseTaskId(job.label), status: job.status === 'running' && !alive(job.pid) ? 'stopped' : statusFor(job.status),
        startedAt: job.startedAt, endedAt: job.endedAt || null, activity: job.activity || `${provider}: running`, tokens: addTokens(emptyTokens(), job.tokens),
      });
    }
  }
  for (const root of codexStateRoots()) {
    for (const entry of await entries(root)) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name), index = await readJSON(join(dir, 'state.json'));
      for (const item of Array.isArray(index?.jobs) ? index.jobs : []) {
        const job = { ...item, ...await readJSON(join(dir, 'jobs', `${item.id}.json`), {}) };
        if (!job.id || !job.workspaceRoot || !await belongsToProject(job.workspaceRoot, workspace) || jobs.has(job.id)) continue;
        let tokens = emptyTokens(), model = job.model || null;
        const rollout = await rolloutFor(job.threadId, job.createdAt);
        if (rollout) {
          const parsed = await parseFile(rollout, 'codex').catch(() => null);
          if (parsed) { tokens = parsed.state.tokens; model = parsed.state.model || model; }
        }
        const description = job.summary || '';
        jobs.set(job.id, { id: job.id, kind: 'codex', type: 'codex', executor: 'codex', model, description, taskId: parseTaskId(description),
          status: statusFor(job.status), startedAt: job.createdAt, endedAt: job.completedAt || null, activity: `codex: ${job.phase || job.status}`, tokens });
      }
    }
  }
  return [...jobs.values()].map(agent => ({ ...agent, activity: activityFor(agent.status, agent.activity) }));
}
const time = value => Date.parse(value) || 0;
export function mergeForwarders(agents, jobs) {
  return [...agents.filter(agent => !(/codex/i.test(agent.type) && jobs.some(job =>
    time(job.startedAt) <= (agent.endedAt ? time(agent.endedAt) : Infinity) &&
    time(agent.startedAt) <= (job.endedAt ? time(job.endedAt) : Infinity)))), ...jobs];
}
export async function collectSession({ transcriptPath, cwd, sessionId }) {
  if (!transcriptPath) {
    const latest = await findLatestTranscript(cwd || process.cwd());
    if (!latest) throw new Error('Transcript not found');
    ({ transcriptPath, sessionId } = latest);
  }
  sessionId ||= basename(transcriptPath, '.jsonl');
  const { state: main, info } = await parseFile(transcriptPath);
  cwd ||= main.cwd || process.cwd();
  const project = await projectInfo(cwd), root = project.cwd;
  const updatedAt = info.mtime.toISOString(), agents = [], seenTools = new Set(), directory = join(dirname(transcriptPath), sessionId, 'subagents');
  const files = (await entries(directory)).filter(e => e.name.startsWith('agent-') && e.name.endsWith('.jsonl'));
  await Promise.all(files.map(async entry => {
    const id = entry.name.slice(6, -6), path = join(directory, entry.name);
    const [{ state, info: agentInfo }, meta] = await Promise.all([parseFile(path, 'agent'), readJSON(path.replace(/\.jsonl$/, '.meta.json'), {})]);
    const resultEntry = Object.entries(main.results).find(([, result]) => result.agentId === id);
    const toolId = meta.toolUseId || resultEntry?.[0];
    if (toolId) seenTools.add(toolId);
    const launch = main.launches[toolId] || {}, result = main.results[toolId];
    const notification = main.notifications[id] || main.notifications[toolId];
    const type = meta.agentType || launch.type || 'general-purpose';
    const model = [state.model, meta.model, state.requestedModel, result?.model, launch.model].map(realModel).find(Boolean) || null;
    const description = meta.description || launch.description || id;
    let status = notification?.status || (result && !result.background ? result.failed ? 'failed' : 'completed' : 'running');
    // With no parent launch evidence, end_turn is the best available completion signal.
    if (!notification && !result && !launch.background && state.turnDone) status = 'completed';
    // An agent resumed via SendMessage keeps writing after its last notification.
    if (notification && status !== 'running' && time(state.last) > time(notification.endedAt) + 2000) status = 'running';
    agents.push({ id, kind: 'claude', type, executor: /codex/i.test(type) ? 'codex' : executorFor(model), model, description, taskId: parseTaskId(description), status,
      startedAt: launch.startedAt || state.first || agentInfo.birthtime.toISOString(),
      endedAt: status === 'running' ? null : notification?.endedAt || result?.endedAt || state.last || agentInfo.mtime.toISOString(), activity: activityFor(status, state.activity || 'working'), tokens: state.tokens });
  }));
  // A launch can already be visible before its transcript is created.
  for (const [toolId, launch] of Object.entries(main.launches)) {
    const result = main.results[toolId], id = result?.agentId || toolId;
    if (seenTools.has(toolId) || agents.some(a => a.id === id)) continue;
    const notification = main.notifications[id] || main.notifications[toolId];
    const status = notification?.status || (result && !result.background ? result.failed ? 'failed' : 'completed' : 'running');
    const model = realModel(result?.model) || realModel(launch.model);
    agents.push({ id, kind: 'claude', type: launch.type, executor: /codex/i.test(launch.type) ? 'codex' : executorFor(model), model,
      description: launch.description, taskId: parseTaskId(launch.description), status, startedAt: launch.startedAt || main.first || updatedAt,
      endedAt: status === 'running' ? null : notification?.endedAt || result?.endedAt || updatedAt, activity: activityFor(status, 'working'), tokens: emptyTokens() });
  }
  const end = Date.now() - info.mtimeMs < 120 * 60000 ? Date.now() : info.mtimeMs;
  const jobs = (await collectCodexJobs(root)).filter(job => time(job.startedAt) <= end && (!job.endedAt || time(job.endedAt) >= time(main.first)));
  const merged = mergeForwarders(agents, jobs).sort((a, b) => time(b.startedAt) - time(a.startedAt));
  const rawBoard = await readJSON(boardPath(root));
  let board = null;
  if (rawBoard && (!rawBoard.sessionId || rawBoard.sessionId === sessionId)) {
    board = { title: rawBoard.title, createdAt: rawBoard.createdAt, finishedAt: rawBoard.finishedAt || null, integration: rawBoard.integration || null, tasks: (rawBoard.tasks || []).map(task => {
      const linked = merged.filter(agent => agent.taskId === task.id);
      return { ...task, parentId: task.parent || (String(task.id).includes('.') ? String(task.id).split('.')[0] : null), branch: task.branch || null, merged: task.merged === true,
        tokens: linked.reduce((sum, agent) => addTokens(sum, agent.tokens), emptyTokens()), agentIds: linked.map(agent => agent.id) };
    }) };
  }
  const byExecutor = {}, mainExecutor = executorFor(main.model);
  byExecutor[mainExecutor] = main.tokens.spent;
  for (const agent of merged) byExecutor[agent.executor] = (byExecutor[agent.executor] || 0) + agent.tokens.spent;
  const tasks = { done: 0, running: 0, review: 0, queued: 0, failed: 0 };
  for (const task of board?.tasks || []) { const key = task.status === 'rework' ? 'running' : task.status; if (key in tasks) tasks[key]++; }
  return { sessionId, project, updatedAt, orchestrator: { model: main.model, tokens: main.tokens }, agents: merged, board, kb: await memoryStats(root),
    totals: { byExecutor, spent: Object.values(byExecutor).reduce((a, b) => a + b, 0), tasks } };
}
export async function findLatestTranscript(cwd) {
  const dir = projectDir(cwd), files = [];
  for (const entry of await entries(dir)) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const path = join(dir, entry.name), info = await stat(path).catch(() => null);
      if (info) files.push({ transcriptPath: path, sessionId: basename(path, '.jsonl'), mtime: info.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.length ? { transcriptPath: files[0].transcriptPath, sessionId: files[0].sessionId } : null;
}
export async function collectActive({ sinceMinutes = 120 } = {}) {
  const files = [], root = join(claudeConfigDir, 'projects'), cutoff = Date.now() - sinceMinutes * 60000;
  for (const directory of await entries(root)) {
    if (!directory.isDirectory()) continue;
    const dir = join(root, directory.name);
    for (const entry of await entries(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(dir, entry.name), info = await stat(path).catch(() => null);
      if (info && info.mtimeMs >= cutoff) files.push({ path, mtime: info.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const sessions = [];
  for (const { path } of files) {
    try { sessions.push(await collectSession({ transcriptPath: path })); } catch { /* file removed or replaced during scan */ }
  }
  return { version: 1, generatedAt: new Date().toISOString(), sessions };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), cwdIndex = args.indexOf('--cwd');
    const result = args.includes('--active') ? await collectActive() : await collectSession({ cwd: cwdIndex < 0 ? process.cwd() : args[cwdIndex + 1] });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(`Could not collect data: ${error.message}`); process.exitCode = 1; }
}
