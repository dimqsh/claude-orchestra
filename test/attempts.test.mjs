import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { projectSlug } from '../plugins/orchestra/lib/paths.mjs';
import { renderRows } from '../plugins/orchestra/lib/render.mjs';

const script = fileURLToPath(new URL('../plugins/orchestra/scripts/board.mjs', import.meta.url));
const collector = new URL('../plugins/orchestra/lib/collect.mjs', import.meta.url).href;
const json = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); };
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orchestra-attempts-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), home = join(root, 'home');
  await mkdir(cwd);
  const env = { ...process.env, ORCHESTRA_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') };
  const boardPath = join(home, 'boards', `${projectSlug(cwd)}.json`), sessionId = 'attempt-session';
  const transcriptPath = join(env.CLAUDE_CONFIG_DIR, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
  const cli = (...args) => spawnSync(process.execPath, [script, '--cwd', cwd, ...args], { env, encoding: 'utf8', timeout: 10000 });
  function board(...args) {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    if (!['json', 'show'].includes(args[0])) assert.equal(result.stdout, '', `${args[0]} must be silent`);
    return result.stdout;
  }
  function evaluate(code) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import * as collect from ${JSON.stringify(collector)}; ${code}`], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  }
  async function transcript() {
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, JSON.stringify({ type: 'assistant', cwd, timestamp: new Date(Date.now() - 60000).toISOString(),
      message: { id: 'main', model: 'claude-opus', usage: { input_tokens: 999 }, content: [] } }) + '\n');
  }
  const task = () => JSON.parse(board('json')).tasks[0];
  return { cwd, home, env, boardPath, sessionId, transcriptPath, cli, board, task, evaluate, transcript,
    collect: () => evaluate(`console.log(JSON.stringify(await collect.collectSession(${JSON.stringify({ cwd, transcriptPath, sessionId })})));`) };
}

test('set running/rework/running/done records two attempts with outcomes rework then accepted', async t => {
  const f = await fixture(t);
  f.board('init', 'attempts');
  f.board('add', '1', 'fix', '--exec', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'high', '--type', 'bug');
  assert.equal(f.task().type, 'bug'); assert.deepEqual(f.task().attempts, []);
  f.board('set', '1', 'running');
  const first = f.task().attempts[0];
  assert.deepEqual(first, { n: 1, provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', startedAt: first.startedAt, endedAt: null, outcome: null, tokens: null });
  assert(Number.isFinite(Date.parse(first.startedAt)));
  f.board('set', '1', 'running'); assert.deepEqual(f.task().attempts, [first]);
  f.board('set', '1', 'review'); f.board('set', '1', 'running'); assert.deepEqual(f.task().attempts, [first]);
  f.board('set', '1', 'rework');
  const closed = f.task().attempts[0];
  assert.equal(closed.outcome, 'rework'); assert.equal(closed.tokens, null); assert(closed.endedAt >= first.startedAt);
  f.board('set', '1', 'running'); f.board('set', '1', 'done');
  assert.deepEqual(f.task().attempts.map(a => [a.n, a.outcome, a.tokens]), [[1, 'rework', null], [2, 'accepted', null]]);
  assert.deepEqual(f.task().attempts[0], closed);
  const accepted = f.task().attempts[1];
  f.board('set', '1', 'done'); assert.deepEqual(f.task().attempts[1], accepted);
  assert.match(f.board('show'), /6\.1-sol@high\s+—\s+done · 2 attempts/);
});

test('an escalated task keeps the failed attempt of the cheaper model and exec affects only the next attempt', async t => {
  const f = await fixture(t);
  f.board('init', 'escalation');
  f.board('add', '1', 'fix', '--exec', 'codex', '--model', 'gpt-cheap', '--effort', 'low', '--type', 'logic');
  f.board('set', '1', 'running');
  const open = f.task().attempts[0];
  f.board('exec', '1', 'gemini', '--model', 'gemini-pro', '--effort', 'high');
  assert.deepEqual(f.task().attempts[0], open);
  f.board('set', '1', 'failed');
  const failed = f.task().attempts[0];
  assert.equal(failed.outcome, 'failed'); assert.equal(failed.provider, 'codex'); assert.equal(failed.model, 'gpt-cheap');
  f.board('set', '1', 'running'); f.board('set', '1', 'done');
  assert.deepEqual(f.task().attempts[0], failed);
  assert.deepEqual(f.task().attempts.map(a => [a.provider, a.model, a.effort]), [['codex', 'gpt-cheap', 'low'], ['gemini', 'gemini-pro', 'high']]);
  f.board('exec', '1', 'sonnet'); f.board('set', '1', 'running');
  assert.deepEqual(f.task().attempts[2], { n: 3, provider: 'sonnet', model: null, effort: null, startedAt: f.task().attempts[2].startedAt, endedAt: null, outcome: null, tokens: null });
});

test('attempt tokens sum matching agents and jobs since the attempt start, without earlier attempts or parent tokens', async t => {
  const f = await fixture(t);
  await f.transcript(); f.board('init', 'tokens', '--session', f.sessionId);
  f.board('add', '1', 'fix', '--exec', 'codex', '--type', 'bug'); f.board('set', '1', 'running');
  const started = Date.parse(f.task().attempts[0].startedAt), startedAt = new Date(started + 1).toISOString();
  for (const [id, taskId, date, spent, provider] of [
    ['old', '1', new Date(started - 1).toISOString(), 1000, 'codex'],
    ['boundary', '1', new Date(started).toISOString(), 2000, 'codex'],
    ['current', '1', startedAt, 11, 'codex'], ['other', '2', startedAt, 1000, 'codex'],
    ['child', '1.1', startedAt, 1000, 'codex'], ['gemini', '1', startedAt, 13, 'gemini'],
  ]) await json(join(f.home, 'jobs', `${id}.json`), { id, provider, cwd: f.cwd, label: `#${taskId} task`, status: 'completed', startedAt: date, endedAt: startedAt, tokens: { spent } });
  const agentPath = join(dirname(f.transcriptPath), f.sessionId, 'subagents/agent-a.jsonl');
  await mkdir(dirname(agentPath), { recursive: true });
  await writeFile(agentPath, JSON.stringify({ type: 'assistant', cwd: f.cwd, timestamp: startedAt, message: { id: 'a', model: 'claude-sonnet', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 500 }, content: [] } }) + '\n');
  await json(agentPath.replace('.jsonl', '.meta.json'), { description: '#1 task' });
  f.board('set', '1', 'rework'); assert.equal(f.task().attempts[0].tokens, 31);
  f.board('set', '1', 'running'); f.board('set', '1', 'done'); assert.equal(f.task().attempts[1].tokens, 0);
  const snapshot = f.collect().board.tasks[0];
  assert.equal(snapshot.attemptCount, 2); assert.deepEqual(snapshot.attemptList, f.task().attempts); assert(!Object.hasOwn(snapshot, 'attempts'));
});

test('attempt token collection uses the board session and tolerates a missing bound transcript', async t => {
  const f = await fixture(t); await f.transcript();
  f.board('init', 'bound session', '--session', 'missing-session'); f.board('add', '1', 'fix', '--exec', 'sonnet');
  f.board('set', '1', 'running'); f.board('set', '1', 'done'); assert.equal(f.task().attempts[0].tokens, null);
});

test('history counts first-try acceptance per model and type across boards and archives', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.evaluate('console.log(JSON.stringify(await collect.history()));'), {});
  const attempt = (n, model, outcome, tokens, provider = 'codex') => ({ n, provider, model, effort: null, startedAt: '2026-10-29T00:00:00Z', endedAt: outcome ? '2026-10-29T00:01:00Z' : null, outcome, tokens });
  await json(f.boardPath, { tasks: [
    { id: '1', type: 'bug', attempts: [attempt(1, 'cheap', 'rework', 10), attempt(2, 'cheap', 'accepted', 20)] },
    { id: '2', type: 'bug', attempts: [attempt(1, 'cheap', 'failed', 30), attempt(2, 'strong', 'accepted', 80)] },
    { id: '3', type: 'docs', attempts: [attempt(1, 'cheap', 'accepted', null)] },
    { id: '4', type: 'bug', attempts: [attempt(1, 'cheap', null, null)] },
    { id: '5', attempts: 3 },
  ] });
  await json(join(f.home, 'boards/archive/old.json'), { tasks: [
    { id: '1', type: 'bug', attempts: [attempt(1, 'cheap', 'accepted', 0)] },
    { id: '2', type: 'search', attempts: [attempt(1, 'cheap', 'accepted', 12, 'gemini')] },
  ] });
  await json(join(f.home, 'boards/archive/corrupt-shape.json'), { tasks: null });
  await writeFile(join(f.home, 'boards/archive/torn.json'), '{');
  assert.deepEqual(f.evaluate('console.log(JSON.stringify(await collect.history()));'), {
    'codex:cheap': { bug: { tasks: 3, firstTry: 1 / 3, avgTokens: 20 }, docs: { tasks: 1, firstTry: 1, avgTokens: null } },
    'codex:strong': { bug: { tasks: 1, firstTry: 0, avgTokens: 80 } },
    'gemini:cheap': { search: { tasks: 1, firstTry: 1, avgTokens: 12 } },
  });
});

test('old boards without attempt records still load numeric attempts into the snapshot and show', async t => {
  const f = await fixture(t); await f.transcript();
  await json(f.boardPath, { title: 'old', sessionId: f.sessionId, tasks: [
    { id: '1', title: 'legacy', executor: 'sonnet', status: 'done', attempts: 2 },
    { id: '2', title: 'no attempts', executor: 'codex', status: 'queued' },
  ] });
  const tasks = f.collect().board.tasks;
  assert.deepEqual(tasks.map(task => [task.attemptCount, task.attemptList]), [[2, []], [0, []]]);
  assert(tasks.every(task => !Object.hasOwn(task, 'attempts')));
  assert.match(f.board('show'), /done · 2 attempts/);
  await rm(f.transcriptPath); assert.match(f.board('show'), /done · 2 attempts/);
});

test('task types and provider options validate atomically and preserve legacy executor aliases', async t => {
  const f = await fixture(t); f.board('init', 'validation');
  for (const [i, type] of ['bug', 'logic', 'refactor', 'tests', 'docs', 'search'].entries()) f.board('add', String(i), type, '--exec', 'codex', '--type', type);
  f.board('add', 'kimi', 'external', '--exec', 'kimi', '--model', 'kimi-model');
  f.board('add', 'claude', 'Claude', '--exec', 'claude', '--model', 'sonnet');
  f.board('add', 'legacy', 'legacy', '--exec', 'haiku');
  for (const args of [['add', 'bad', 'bad', '--exec', 'codex', '--type', 'typo'], ['add', 'bad', 'bad', '--exec', 'unknown'], ['exec', '0', 'unknown'], ['exec', '0', 'codex', '--model'], ['add', 'bad', 'bad', '--exec', 'codex', '--effort']]) {
    const before = await readFile(f.boardPath, 'utf8'), result = f.cli(...args);
    assert.equal(result.status, 1, args.join(' ')); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.equal(await readFile(f.boardPath, 'utf8'), before);
  }
});

test('model and effort executor columns align at narrow and wide widths with unchanged ANSI stripping', () => {
  const tasks = [
    { id: '1', title: 'short', model: 'gpt-6.1-sol', effort: 'high', executor: 'codex' },
    { id: '1.1', parent: '1', title: 'long '.repeat(50), model: 'sonnet', executor: 'sonnet' },
    { id: '2', title: 'next', executor: 'codex' },
  ].map(task => ({ ...task, status: 'done', attemptCount: 2, tokens: { spent: 123 } }));
  for (const width of [60, 100, 140]) {
    const session = { board: { tasks } }, rows = renderRows(session, { width });
    assert.match(rows[0], /6\.1-sol@high/); assert.match(rows[1], /sonnet/);
    assert.equal(rows[0].indexOf('6.1-sol@high'), rows[1].indexOf('sonnet'));
    assert.equal(rows[0].indexOf('123'), rows[1].indexOf('123')); assert.equal(rows[1].indexOf('123'), rows[2].indexOf('123'));
    assert(rows.every(row => Array.from(row).length <= width));
    assert.deepEqual(renderRows(session, { width, color: true }).map(row => row.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')), rows);
  }
});
