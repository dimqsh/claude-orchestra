import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, realpath, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { projectSlug } from '../plugins/orchestra/lib/paths.mjs';
import { renderRows, renderRow, executorColors, paint } from '../plugins/orchestra/lib/render.mjs';

const childDiagnostics = result => `signal=${result.signal}; stderr=${result.stderr ?? ''}`;

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
  const cli = (...args) => spawnSync(process.execPath, [script, '--cwd', cwd, ...args], { env, encoding: 'utf8', timeout: 30000 });
  function board(...args) {
    const result = cli(...args);
    assert.equal(result.status, 0, childDiagnostics(result)); assert.equal(result.stderr, '');
    if (!['json', 'show'].includes(args[0])) assert.equal(result.stdout, '', `${args[0]} must be silent`);
    return result.stdout;
  }
  function evaluate(code) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import * as collect from ${JSON.stringify(collector)}; ${code}`], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, childDiagnostics(result)); assert.equal(result.stderr, '');
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

test('attempt tokens sum all matching agents and jobs and subtract earlier attempts, excluding other task ids', async t => {
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
  f.board('set', '1', 'rework'); assert.equal(f.task().attempts[0].tokens, 3031);
  f.board('set', '1', 'running');
  const verdict = f.cli('set', '1', 'done');
  assert.equal(verdict.status, 0, childDiagnostics(verdict)); assert.equal(verdict.stderr, ''); assert.equal(verdict.stdout, '');
  assert.equal(f.task().attempts[1].tokens, 0, childDiagnostics(verdict));
  const snapshot = f.collect().board.tasks[0];
  assert.equal(snapshot.attemptCount, 2); assert.deepEqual(snapshot.attemptList, f.task().attempts); assert(!Object.hasOwn(snapshot, 'attempts'));
});

test('SendMessage-style rework records growing tokens from the same Sonnet agent', async t => {
  const f = await fixture(t); await f.transcript();
  f.board('init', 'resumed Sonnet', '--session', f.sessionId);
  f.board('add', '1', 'fix', '--exec', 'sonnet', '--model', 'claude-sonnet-4-5-20250929');
  f.board('set', '1', 'running');
  const startedAt = new Date().toISOString(), agentPath = join(dirname(f.transcriptPath), f.sessionId, 'subagents/agent-resumed.jsonl');
  await mkdir(dirname(agentPath), { recursive: true });
  const row = (id, spent) => JSON.stringify({ type: 'assistant', cwd: f.cwd, timestamp: new Date().toISOString(),
    message: { id, model: 'claude-sonnet-4-5-20250929', stop_reason: 'end_turn', usage: { input_tokens: spent, cache_read_input_tokens: 1000 }, content: [] } }) + '\n';
  await writeFile(agentPath, row('first', 30));
  await json(agentPath.replace('.jsonl', '.meta.json'), { description: '#1 fix' });
  f.board('set', '1', 'rework'); assert.equal(f.task().attempts[0].tokens, 30);
  const first = f.task().attempts[0], originalAgentStart = f.collect().agents[0].startedAt;
  assert(originalAgentStart >= startedAt);
  f.board('set', '1', 'running');
  await appendFile(agentPath, row('after-SendMessage', 17));
  assert.equal(f.collect().agents[0].startedAt, originalAgentStart);
  assert(originalAgentStart < f.task().attempts[1].startedAt);
  f.board('set', '1', 'rework');
  assert.deepEqual(f.task().attempts.map(a => a.tokens), [30, 17]);
  f.board('set', '1', 'running');
  await appendFile(agentPath, row('second-SendMessage', 9));
  f.board('set', '1', 'done');
  assert.deepEqual(f.task().attempts.map(a => a.tokens), [30, 17, 9]);
  assert.deepEqual(f.task().attempts[0], first);
});

test('nothing matching the exact task id records null even when a session and child jobs exist', async t => {
  const f = await fixture(t); await f.transcript();
  f.board('init', 'unobserved', '--session', f.sessionId); f.board('add', '1', 'fix', '--exec', 'codex');
  for (const taskId of ['1.1', '2']) await json(join(f.home, 'jobs', `${taskId}.json`), {
    id: taskId, cwd: f.cwd, label: `#${taskId} unrelated`, status: 'completed', startedAt: new Date().toISOString(), tokens: { spent: 100 },
  });
  f.board('set', '1', 'running'); f.board('set', '1', 'done');
  assert.equal(f.task().attempts[0].tokens, null);
});

test('unknown earlier attempt costs keep later costs null despite matching task work', async t => {
  const f = await fixture(t); await f.transcript();
  f.board('init', 'unknown baseline', '--session', f.sessionId); f.board('add', '1', 'fix', '--exec', 'codex');
  f.board('set', '1', 'running'); f.board('set', '1', 'rework'); assert.equal(f.task().attempts[0].tokens, null);
  await json(join(f.home, 'jobs/current.json'), { id: 'current', cwd: f.cwd, label: '#1 fix', status: 'completed', startedAt: new Date().toISOString(), tokens: { spent: 50 } });
  f.board('set', '1', 'running'); f.board('set', '1', 'done');
  assert.deepEqual(f.task().attempts.map(a => a.tokens), [null, null]);
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
    { id: '1', type: 'bug', attempts: [attempt(2, 'cheap', 'accepted', 20), attempt(1, 'cheap', 'rework', 10)] },
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
    'codex:strong': { bug: { tasks: 1, firstTry: 1, avgTokens: 80 } },
    'gemini:cheap': { search: { tasks: 1, firstTry: 1, avgTokens: 12 } },
  });
});

test('history normalizes every legacy Claude executor and combines alias and canonical attempts', async t => {
  const f = await fixture(t);
  const task = (provider, n = 2, outcome = 'accepted', tokens = 12) => ({ n, provider, model: `claude-${provider}`, outcome, tokens });
  await json(f.boardPath, { tasks: ['sonnet', 'haiku', 'opus', 'fable'].map((alias, i) => ({
    id: String(i), type: 'docs', attempts: [task(alias)],
  })).concat({ id: 'mixed', type: 'bug', attempts: [
    { ...task('sonnet', 2, 'accepted', 20), provider: 'claude' }, task('sonnet', 1, 'rework', 10),
  ] }) });
  const stats = f.evaluate('console.log(JSON.stringify(await collect.history()));');
  assert.deepEqual(Object.keys(stats).sort(), ['claude:claude-fable', 'claude:claude-haiku', 'claude:claude-opus', 'claude:claude-sonnet']);
  for (const alias of ['sonnet', 'haiku', 'opus', 'fable']) assert.deepEqual(stats[`claude:claude-${alias}`].docs, { tasks: 1, firstTry: 1, avgTokens: 12 });
  assert.deepEqual(stats['claude:claude-sonnet'].bug, { tasks: 1, firstTry: 0, avgTokens: 30 });
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

test('board-less agent rows retain executor names even when model ids and effort are present', () => {
  const agents = [
    { id: 'a', executor: 'sonnet', model: 'claude-sonnet-4-5-20250929', effort: 'high' },
    { id: 'b', executor: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  ].map(agent => ({ ...agent, description: 'work', status: 'running', tokens: { spent: 123 }, activity: 'Bash tests' }));
  for (const width of [60, 100, 140]) {
    const rows = renderRows({ agents }, { width });
    assert.match(rows[0], /Sonnet\s+123/); assert.match(rows[1], /Codex\s+123/);
    assert(rows.every(row => !row.includes('@') && !row.includes('20250929') && !row.includes('6.1-sol')));
    assert.deepEqual(renderRows({ agents }, { width, color: true }).map(row => row.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')), rows);
  }
  assert.match(renderRow({ ...agents[0], label: 'work' }), /Sonnet\s+123/);
});

test('board model labels drop date suffixes and cap the aligned executor column at 14 characters', () => {
  const tasks = [
    { id: '1', executor: 'sonnet', model: 'claude-sonnet-4-5-20250929', effort: 'low' },
    { id: '1.1', parent: '1', executor: 'codex', model: 'gpt-a-model-name-that-is-very-long', effort: 'xhigh' },
    { id: '2', executor: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  ].map(task => ({ ...task, title: 'task', status: 'running', tokens: { spent: 123 }, note: 'Bash tests' }));
  for (const width of [60, 100, 140]) {
    const session = { board: { tasks } }, rows = renderRows(session, { width });
    assert.match(rows[0], /sonnet-4-5@low/); assert(rows.every(row => !row.includes('20250929')));
    const start = rows[0].indexOf('sonnet-4-5@low');
    assert.equal(rows[0].slice(start, start + 14), 'sonnet-4-5@low');
    assert.equal(rows[1].slice(start, start + 14), 'a-model-name-…');
    assert.equal(rows[2].slice(start, start + 14), '6.1-sol@high  ');
    for (const row of rows) {
      assert.equal(row.slice(start + 15, start + 21), '   123');
      assert.match(row, /Bash/); assert(Array.from(row).length <= width);
    }
    assert.deepEqual(renderRows(session, { width, color: true }).map(row => row.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')), rows);
  }
});

test('concurrent board verdicts preserve both tasks after overlapping token collection', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.board('init', 'concurrent', '--session', f.sessionId);
  for (const id of ['1', '2']) {
    f.board('add', id, 'fix', '--exec', 'claude', '--model', 'sonnet');
    f.board('set', id, 'running');
  }
  // Hold both real board CLI processes at their asynchronous collector boundary.
  const runtime = join(f.cwd, 'runtime');
  await cp(new URL('../plugins/orchestra/lib/', import.meta.url), join(runtime, 'lib'), { recursive: true });
  await mkdir(join(runtime, 'scripts'));
  await cp(script, join(runtime, 'scripts/board.mjs'));
  await writeFile(join(runtime, 'lib/collect.mjs'), `
    export const projectRoot = async cwd => cwd;
    export const emptyTokens = () => ({ spent: 0 });
    export async function collectSession() {
      process.send('collecting');
      await new Promise(resolve => process.stdin.once('data', resolve));
      return { agents: ['1', '2'].map(taskId => ({ taskId, tokens: { spent: 7 } })) };
    }
  `);
  const children = ['1', '2'].map(id => {
    const child = spawn(process.execPath, [join(runtime, 'scripts/board.mjs'), '--cwd', f.cwd, 'set', id, 'done'],
      { env: f.env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
    const ready = new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
      child.once('exit', code => reject(new Error(`board exited before collection: ${code}; stderr=${stderr}`)));
    });
    return { child, closed, ready };
  });
  await Promise.all(children.map(child => child.ready));
  // Finish one verdict while the second still holds the original board snapshot.
  for (const { child, closed } of children) {
    child.stdin.end('continue');
    const result = await closed;
    assert.equal(result.code, 0, `signal=${result.signal}; stderr=${result.stderr}`);
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
  const board = JSON.parse(f.board('json'));
  assert.deepEqual(board.tasks.map(task => [task.status, task.attempts[0].outcome, task.attempts[0].tokens]),
    [['done', 'accepted', 7], ['done', 'accepted', 7]]);
});

test('negative attempt token deltas are stored as null', async t => {
  const f = await fixture(t); await f.transcript();
  f.board('init', 'shrinking usage', '--session', f.sessionId);
  f.board('add', '1', 'fix', '--exec', 'codex');
  const path = join(f.home, 'jobs/current.json');
  const job = spent => ({ id: 'current', cwd: f.cwd, label: '#1 fix', status: 'completed',
    startedAt: new Date().toISOString(), tokens: { spent } });
  await json(path, job(50));
  f.board('set', '1', 'running'); f.board('set', '1', 'rework');
  assert.equal(f.task().attempts[0].tokens, 50);
  await json(path, job(20));
  f.board('set', '1', 'running'); f.board('set', '1', 'done');
  assert.deepEqual(f.task().attempts.map(attempt => attempt.tokens), [50, null]);
});

test('Claude task rows use their model family colour, including the open attempt and Sonnet fallback', () => {
  for (const [model, family] of [['claude-opus-5-5', 'opus'], ['sonnet', 'sonnet'], ['claude-haiku-4-5', 'haiku'],
    ['fable', 'fable'], ['unknown', 'sonnet'], [null, 'sonnet']]) {
    for (const open of [false, true]) {
      const task = { id: '1', title: 'fix', executor: open ? 'codex' : 'claude', model: open ? 'gpt-old' : model,
        status: 'running', attemptList: open ? [{ provider: 'claude', model, outcome: null }] : [] };
      const session = { board: { tasks: [task] } };
      const plain = renderRows(session)[0], coloured = renderRows(session, { color: true })[0];
      const label = model ? model.replace(/^claude-/, '').slice(0, 14) : 'Other';
      assert(coloured.includes(paint(label.padEnd(Math.max(6, label.length)), executorColors[family], true)), coloured);
      assert.equal(coloured.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''), plain);
    }
  }
});

test('active snapshots exclude temporary benchmark directories and their descendants', async t => {
  const f = await fixture(t); await f.transcript();
  for (const [sessionId, cwd] of [['bench', join(f.cwd, 'orchestra-bench-abc')],
    ['nested', join(f.cwd, 'orchestra-bench-def', 'nested')], ['ordinary', join(f.cwd, 'orchestra-benchmark-project')]]) {
    await mkdir(cwd, { recursive: true });
    const path = join(f.env.CLAUDE_CONFIG_DIR, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ type: 'assistant', cwd, timestamp: new Date().toISOString(),
      message: { id: sessionId, model: 'claude-sonnet', content: [] } }) + '\n');
  }
  const snapshot = f.evaluate('console.log(JSON.stringify(await collect.collectActive()));');
  assert.deepEqual(snapshot.sessions.map(session => session.sessionId).sort(), [f.sessionId, 'ordinary'].sort());
});
