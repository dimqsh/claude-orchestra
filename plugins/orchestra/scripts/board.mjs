#!/usr/bin/env node
import { readFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardPath, projectDir, canonicalPath, atomicJSON } from '../lib/paths.mjs';
import { collectSession, emptyTokens, projectRoot } from '../lib/collect.mjs';
import { renderBoard } from '../lib/render.mjs';

const executors = ['codex', 'claude', 'gemini', 'kimi', 'sonnet', 'opus', 'haiku', 'fable'];
const statuses = ['queued', 'running', 'review', 'rework', 'done', 'failed'];
async function attemptTokens(board, task, attempt, cwd) {
  const earlier = task.attempts.filter(previous => previous.n < attempt.n);
  if (earlier.some(previous => previous.tokens == null)) return null;
  try {
    const session = await collectSession({ cwd, ...(board.sessionId ? {
      sessionId: board.sessionId, transcriptPath: join(projectDir(cwd), `${board.sessionId}.jsonl`),
    } : {}) });
    const linked = session.agents.filter(agent => agent.taskId === task.id);
    if (!linked.length) return null;
    // SendMessage resumes the same agent, so startedAt cannot delimit its new work.
    return linked.reduce((sum, agent) => sum + agent.tokens.spent, 0) - earlier.reduce((sum, previous) => sum + previous.tokens, 0);
  } catch { return null; } // A board can be used before its session transcript exists.
}
function fields(args, allowed) {
  if (!args.length) throw new Error('Provide key=value parameters');
  const result = {};
  for (const arg of args) {
    const index = arg.indexOf('='), key = arg.slice(0, index), value = arg.slice(index + 1);
    if (index < 1 || !allowed.includes(key)) throw new Error(`Unknown parameter: ${arg}`);
    if (key === 'merged' && !['true', 'false'].includes(value)) throw new Error('merged must be true or false');
    result[key] = key === 'merged' ? value === 'true' : value;
  }
  return result;
}
export async function runBoard(argv = process.argv.slice(2)) {
  const args = [...argv];
  function option(name) {
    const index = args.indexOf(name);
    if (index < 0) return null;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value`);
    return args.splice(index, 2)[1];
  }
  const cwd = await projectRoot(canonicalPath(option('--cwd') || process.cwd())), sessionId = option('--session'), executor = option('--exec');
  const deps = option('--deps'), note = option('--note'), widthArg = option('--width');
  const model = option('--model'), effort = option('--effort'), type = option('--type');
  const color = args.includes('--color');
  if (color) args.splice(args.indexOf('--color'), 1);
  if (args.some(value => value.startsWith('--'))) throw new Error('Unknown parameter');
  const [command, id, value] = args, path = boardPath(cwd), now = new Date().toISOString();
  if (command === 'init') {
    if (!id || args.length !== 2) throw new Error('Provide a board title');
    let exists = false;
    try { await readFile(path); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) {
      const archive = join(dirname(path), 'archive');
      await mkdir(archive, { recursive: true });
      await rename(path, join(archive, `${basename(path, '.json')}-${Date.now()}-${process.pid}.json`));
    }
    await atomicJSON(path, { version: 1, title: id, cwd, sessionId, createdAt: now, updatedAt: now, finishedAt: null, integration: null, tasks: [] });
    return;
  }
  let board;
  try { board = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Board not found: run init'); }
  if (!Array.isArray(board.tasks)) throw new Error('Board is corrupted');
  if (command === 'json') return JSON.stringify(board);
  if (command === 'show') {
    let session;
    try { session = await collectSession({ cwd }); } catch { /* a board can exist before a transcript */ }
    if (!session || !session.board) {
      const byExecutor = session?.totals?.byExecutor || {};
      session = { sessionId: board.sessionId, project: session?.project || { name: basename(cwd), cwd, branch: null },
        orchestrator: session?.orchestrator || { model: null, tokens: emptyTokens() }, agents: session?.agents || [], kb: session?.kb || null,
        board: { ...board, tasks: board.tasks.map(({ attempts, ...task }) => ({ ...task,
          attemptCount: Array.isArray(attempts) ? attempts.length : Number(attempts) || 0,
          attemptList: Array.isArray(attempts) ? attempts : [], tokens: emptyTokens(), agentIds: [] })) },
        totals: { byExecutor, spent: Object.values(byExecutor).reduce((a, b) => a + b, 0), tasks: { done: 0, running: 0, review: 0, queued: 0, failed: 0 } } };
      for (const task of board.tasks) { const key = task.status === 'rework' ? 'running' : task.status; session.totals.tasks[key]++; }
    }
    const width = widthArg === null ? 100 : Number(widthArg);
    if (!Number.isFinite(width) || width < 1) throw new Error('Width must be a positive number');
    return renderBoard(session, { width, color });
  }
  if (command === 'add') {
    if (!id || !/^[\w-]+(?:\.[\w-]+)?$/.test(id) || !value || args.length !== 3) throw new Error('Provide an id and a task title (at most one level of nesting)');
    if (!executors.includes(executor)) throw new Error('Unknown executor');
    if (type !== null && !(await import('../lib/catalog.mjs')).TASK_TYPES.includes(type)) throw new Error('Unknown task type');
    if (board.tasks.some(task => task.id === id)) throw new Error(`Task #${id} already exists`);
    const parent = id.includes('.') ? id.split('.')[0] : null;
    if (parent && !board.tasks.some(task => task.id === parent)) throw new Error(`Parent task #${parent} not found`);
    const dependsOn = deps ? deps.split(',').filter(Boolean) : [];
    if (dependsOn.includes(id)) throw new Error('A task cannot depend on itself');
    board.tasks.push({ id, parent, title: value, executor, model, effort, type, status: 'queued', attempts: [], dependsOn, note: '', branch: null, worktree: null, merged: false, updatedAt: now });
  } else if (command === 'meta') {
    const task = board.tasks.find(task => task.id === id);
    if (!task) throw new Error(`Task #${id || ''} not found`);
    Object.assign(task, fields(args.slice(2), ['branch', 'worktree', 'merged']), { updatedAt: now });
  } else if (command === 'integration') {
    board.integration = { branch: null, worktree: null, base: null, landedAt: null, ...board.integration,
      ...fields(args.slice(1), ['branch', 'worktree', 'base', 'landedAt']) };
  } else if (command === 'set' || command === 'exec') {
    if (args.length !== 3) throw new Error('Provide an id and a value');
    const task = board.tasks.find(task => task.id === id);
    if (!task) throw new Error(`Task #${id} not found`);
    if (command === 'set') {
      if (!statuses.includes(value)) throw new Error('Unknown status');
      const attempts = Array.isArray(task.attempts) ? task.attempts : [];
      const open = attempts.findLast(attempt => attempt.outcome === null);
      if (value === 'running' && !open) {
        task.attempts = attempts;
        attempts.push({ n: attempts.length + 1, provider: task.executor, model: task.model || null, effort: task.effort || null,
          startedAt: now, endedAt: null, outcome: null, tokens: null });
      }
      if (open && ['done', 'rework', 'failed'].includes(value)) {
        open.tokens = await attemptTokens(board, task, open, cwd);
        open.endedAt = now;
        open.outcome = value === 'done' ? 'accepted' : value;
      }
      task.status = value;
      // A note describes one transition; it must not outlive it (e.g. a rework note on a done task).
      task.note = note ?? '';
    } else {
      if (!executors.includes(value)) throw new Error('Unknown executor');
      task.executor = value;
      task.model = model;
      task.effort = effort;
    }
    task.updatedAt = now;
  } else if (command === 'finish' && args.length === 1) board.finishedAt = now;
  else throw new Error('Unknown board command');
  board.updatedAt = now;
  await atomicJSON(path, board);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const output = await runBoard(); if (output !== undefined) console.log(output); }
  catch (error) { console.error(`Error: ${String(error.message).replace(/[\r\n]/g, ' ')}`); process.exitCode = 1; }
}
