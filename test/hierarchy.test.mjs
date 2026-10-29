import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { projectSlug } from '../plugins/orchestra/lib/paths.mjs';
import { renderBoard, renderRows, renderHeader } from '../plugins/orchestra/lib/render.mjs';

const strip = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const tokens = spent => ({ input: spent, cacheWrite: 0, cacheRead: 0, output: 0, spent });
async function json(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
async function fixture(t, { stub = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orchestra-hierarchy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, 'runtime');
  for (const file of ['lib/paths.mjs', 'lib/collect.mjs', 'lib/render.mjs', 'scripts/board.mjs', 'hud/statusline.mjs', 'hud/subagent-rows.mjs']) {
    await mkdir(dirname(join(runtime, file)), { recursive: true });
    await cp(new URL(`../plugins/orchestra/${file}`, import.meta.url), join(runtime, file));
  }
  await mkdir(join(root, 'repo'));
  const cwd = await realpath(join(root, 'repo')), home = join(root, 'home');
  const env = { ...process.env, ORCHESTRA_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), KB_TRACE: join(root, 'kb-calls.jsonl'), KB_STATS: join(root, 'stats.json') };
  if (stub) {
    await writeFile(join(runtime, 'lib/kb.mjs'), `import { readFileSync, appendFileSync } from 'node:fs';
export function openKb(cwd, options) {
  if (options.readOnly !== true) throw Error('HUD must open memory read-only');
  const record = operation => appendFileSync(process.env.KB_TRACE, JSON.stringify({ operation, cwd, readOnly: options.readOnly })+'\\n');
  record('open');
  return { stats() { record('stats'); return JSON.parse(readFileSync(process.env.KB_STATS, 'utf8')); }, close() { record('close'); } };
}
`);
  }
  const sessionId = 'hierarchy-session', transcriptPath = join(env.CLAUDE_CONFIG_DIR, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
  const startedAt = new Date(Date.now() - 60000).toISOString();
  await mkdir(dirname(transcriptPath), { recursive: true });
  await writeFile(transcriptPath, JSON.stringify({ type: 'assistant', isSidechain: false, cwd, timestamp: startedAt, message: { id: 'main', model: 'claude-opus', usage: { input_tokens: 10 }, content: [] } }) + '\n');
  const boardPath = join(home, 'boards', `${projectSlug(cwd)}.json`), kbPath = join(home, 'kb', `${projectSlug(cwd)}.sqlite`);
  function cli(file, args = [], input = '') {
    return spawnSync(process.execPath, [join(runtime, file), ...args], { env, input, encoding: 'utf8', timeout: 10000 });
  }
  function node(code) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  }
  function board(...args) {
    const result = cli('scripts/board.mjs', ['--cwd', cwd, ...args]);
    assert.equal(result.status, 0, result.stderr);
    if (!['json', 'show'].includes(args[0])) assert.equal(result.stdout, '', `${args[0]} must be silent`);
    return result.stdout;
  }
  function collect(collectCwd = cwd) {
    return JSON.parse(node(`import { collectSession } from ${JSON.stringify(pathToFileURL(join(runtime, 'lib/collect.mjs')).href)};
console.log(JSON.stringify(await collectSession(${JSON.stringify({ transcriptPath, cwd: collectCwd, sessionId })})));`));
  }
  async function addJob(id, jobCwd, taskId, spent) {
    await json(join(home, 'codex-jobs', `${id}.json`), { version: 1, id, cwd: jobCwd, label: `#${taskId} task`, model: 'gpt-test', status: 'completed', pid: process.pid,
      startedAt, endedAt: new Date().toISOString(), tokens: tokens(spent), activity: 'Bash pytest' });
  }
  function git(args) {
    const result = spawnSync('git', ['-c', 'user.name=Orchestra Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  }
  return { root, runtime, cwd, home, env, sessionId, transcriptPath, startedAt, boardPath, kbPath, cli, node, board, collect, addJob, git };
}

test('board accepts one dotted level, stores its parent and rejects invalid/missing parents atomically', async t => {
  const f = await fixture(t);
  f.board('init', 'hierarchy'); f.board('add', '2', 'parent', '--exec', 'sonnet');
  f.board('add', '2.1', 'child', '--exec', 'codex', '--deps', '2');
  f.board('add', 'alpha-b', 'parent 2', '--exec', 'opus');
  f.board('add', 'alpha-b.child_c', 'child 2', '--exec', 'codex');
  const board = JSON.parse(f.board('json'));
  assert.equal(board.tasks[0].parent, null); assert.equal(board.tasks[1].parent, '2');
  assert.equal(board.tasks[3].parent, 'alpha-b'); assert.deepEqual(board.tasks[1].dependsOn, ['2']);
  for (const id of ['2.1.1', '3.1', '2..1', '.2', '2.', '2/1', '2.1']) {
    const before = await readFile(f.boardPath, 'utf8');
    const result = f.cli('scripts/board.mjs', ['--cwd', f.cwd, 'add', id, 'error', '--exec', 'codex']);
    assert.equal(result.status, 1, id); assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.equal(await readFile(f.boardPath, 'utf8'), before);
  }
});

test('meta and integration validate keys, preserve partial updates and stay silent', async t => {
  const f = await fixture(t);
  f.board('init', 'metadata'); f.board('add', '2', 'task', '--exec', 'codex');
  f.board('meta', '2', 'branch=orchestra/test/2', `worktree=${join(f.cwd, 'path with spaces')}`, 'merged=true');
  let board = JSON.parse(f.board('json'));
  assert.equal(board.tasks[0].branch, 'orchestra/test/2'); assert.equal(board.tasks[0].merged, true);
  assert.equal(board.tasks[0].worktree, join(f.cwd, 'path with spaces'));
  f.board('meta', '2', 'merged=false');
  board = JSON.parse(f.board('json')); assert.equal(board.tasks[0].merged, false); assert.equal(board.tasks[0].branch, 'orchestra/test/2');
  f.board('integration', 'branch=orchestra/test/main', 'worktree=/tmp/integration with spaces', 'base=abc=123');
  const landedAt = new Date().toISOString(); f.board('integration', `landedAt=${landedAt}`);
  board = JSON.parse(f.board('json'));
  assert.deepEqual(board.integration, { branch: 'orchestra/test/main', worktree: '/tmp/integration with spaces', base: 'abc=123', landedAt });
  for (const args of [['meta', '2'], ['meta', 'missing', 'merged=true'], ['meta', '2', 'branch=bad', 'merged=yes'], ['meta', '2', 'unknown=x'], ['integration'], ['integration', 'merged=true'], ['integration', 'branch']]) {
    const before = await readFile(f.boardPath, 'utf8');
    const result = f.cli('scripts/board.mjs', ['--cwd', f.cwd, ...args]);
    assert.equal(result.status, 1, args.join(' ')); assert.equal(result.stdout, '');
    assert.equal(await readFile(f.boardPath, 'utf8'), before);
  }
});

test('sub-tasks follow their parent with nested connectors and fixed executor/token columns', () => {
  const tasks = [
    { id: '1', title: 'short', executor: 'sonnet', tokens: tokens(10) },
    { id: '2', title: 'parent '.repeat(20), executor: 'codex', tokens: tokens(100) },
    { id: '3', title: 'next', executor: 'haiku', tokens: tokens(30) },
    { id: '2.1', parentId: '2', title: 'child '.repeat(20), executor: 'codex', tokens: tokens(200) },
    { id: '2.2', parent: '2', title: 'short', executor: 'sonnet', tokens: tokens(0) },
  ].map(task => ({ ...task, status: 'running', note: 'editing cli.py' }));
  for (const width of [60, 100, 140]) {
    const rows = renderRows({ board: { tasks } }, { width });
    assert.deepEqual(rows.map(row => row.match(/#([\w.]+)/)[1]), ['1', '2', '2.1', '2.2', '3']);
    assert(rows[2].startsWith('│  ├─ ◐ ')); assert(rows[3].startsWith('│  ╰─ ◐ '));
    const executors = rows.map(row => row.search(/(?:Sonnet|Codex|Haiku)/));
    assert(executors.every(offset => offset === executors[0]));
    const tokenOffset = executors[0] + 7;
    assert.equal(rows[1].slice(tokenOffset, tokenOffset + 6), '   100');
    assert.equal(rows[2].slice(tokenOffset, tokenOffset + 6), '   200');
    assert.equal(rows[3].slice(tokenOffset, tokenOffset + 6), '     —');
    assert(rows.every(row => Array.from(row).length <= width));
    assert.deepEqual(renderRows({ board: { tasks } }, { width, color: true }).map(strip), rows);
  }
});

test('merged tasks show merged unless noted; landed and memory labels remain visible in the header', () => {
  const session = { project: { name: 'a very long project name '.repeat(5), branch: 'feature' }, agents: [],
    totals: { spent: 100, byExecutor: { codex: 100 }, tasks: { done: 2 } }, kb: { notes: 34, hits: 4, savedTokens: 18000, recent: [] },
    board: { integration: { landedAt: '2026-10-29T00:00:00Z' }, tasks: [
      { id: '1', title: 'merged one', executor: 'codex', status: 'done', merged: true, tokens: tokens(0) },
      { id: '2', title: 'with note', executor: 'sonnet', status: 'done', merged: true, note: 'needs review', tokens: tokens(10) },
    ] } };
  const rows = renderRows(session);
  assert(rows[0].endsWith('merged')); assert(rows[1].endsWith('needs review'));
  const header = renderHeader(session, { width: 100 });
  // Narrow: the word 'saved' goes first, numbers stay; wide: the full label.
  assert(header.includes('· landed')); assert(header.includes('· memory 34 · ≈18k'));
  assert(renderHeader({ ...session, project: { name: 'demo', branch: 'main' } }, { width: 200 }).includes('· memory 34 · ≈18k saved'));
  assert(renderHeader(session, { width: 60 }).includes('Σ 100 · landed'), 'numbers and the landed label survive a narrow width');
  assert(Array.from(header).length <= 100);
  assert.equal(strip(renderHeader(session, { width: 100, color: true })), header);
  assert(!renderHeader({ ...session, kb: null, board: { tasks: [] } }).includes('memory'));
  assert(renderBoard(session).includes('✓ 2 done'));
});

test('collector tolerates missing KB module/database and never creates a DB', async t => {
  const absent = await fixture(t);
  assert.equal(absent.collect().kb, null);
  assert.equal(await readdir(join(absent.home, 'kb')).catch(error => error.code), 'ENOENT');
  await mkdir(dirname(absent.kbPath), { recursive: true }); await writeFile(absent.kbPath, 'existing database');
  // Use a fresh process/cache window so the optional import is actually attempted.
  for (const file of await readdir(join(absent.home, 'cache'))) if (file.startsWith('kb-')) await rm(join(absent.home, 'cache', file));
  assert.equal(absent.collect().kb, null); assert.equal(await readFile(absent.kbPath, 'utf8'), 'existing database');
  const missingDb = await fixture(t, { stub: true });
  assert.equal(missingDb.collect().kb, null);
  assert.equal(await readFile(missingDb.env.KB_TRACE, 'utf8').catch(error => error.code), 'ENOENT');
});

test('collector opens memory read-only, closes it, and caches stats across fresh HUD processes for ~5 s', async t => {
  const f = await fixture(t, { stub: true });
  await json(f.env.KB_STATS, { notes: 34, hits: 4, savedTokens: 18000, recent: [] });
  await mkdir(dirname(f.kbPath), { recursive: true }); await writeFile(f.kbPath, 'read-only fixture');
  const first = f.collect(); assert.equal(first.kb.notes, 34);
  const input = JSON.stringify({ session_id: f.sessionId, transcript_path: f.transcriptPath, cwd: f.cwd });
  const hud = f.cli('hud/statusline.mjs', [], input);
  assert.equal(hud.status, 0); assert(strip(hud.stdout).includes('· memory 34 · ≈18k saved'));
  let calls = (await readFile(f.env.KB_TRACE, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.operation), ['open', 'stats', 'close']);
  assert(calls.every(call => call.cwd === f.cwd && call.readOnly));
  await json(f.env.KB_STATS, { notes: 35, hits: 8, savedTokens: 36000, recent: [] });
  assert.equal(f.collect().kb.notes, 34, 'cache is reused before five seconds');
  for (const file of await readdir(join(f.home, 'cache'))) {
    if (!file.startsWith('kb-')) continue;
    const path = join(f.home, 'cache', file), cached = JSON.parse(await readFile(path, 'utf8'));
    cached.time = Date.now() - 6000; await json(path, cached);
  }
  assert.equal(f.collect().kb.notes, 35);
  calls = (await readFile(f.env.KB_TRACE, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.operation === 'stats').length, 2);
  assert.equal(await readFile(f.kbPath, 'utf8'), 'read-only fixture');
});

test('worktree Claude/Codex agents share the root board, metadata and memory; child tokens stay separate', async t => {
  const f = await fixture(t, { stub: true });
  f.git(['init', '-q']); await writeFile(join(f.cwd, 'README'), 'fixture'); f.git(['add', 'README']); f.git(['commit', '-qm', 'fixture']);
  const worktree = join(f.cwd, '.orchestra/worktrees/2'), external = join(f.root, 'external-worktree');
  f.git(['worktree', 'add', '-qb', 'orchestra/test/2', worktree]);
  f.git(['worktree', 'add', '-qb', 'orchestra/test/2.1', external]);
  f.board('init', 'worktrees', '--session', f.sessionId);
  f.board('add', '2', 'parent', '--exec', 'codex'); f.board('add', '2.1', 'child', '--exec', 'codex');
  const meta = f.cli('scripts/board.mjs', ['--cwd', worktree, 'meta', '2.1', 'branch=orchestra/test/2.1', `worktree=${external}`, 'merged=true']);
  assert.equal(meta.status, 0, meta.stderr); assert.equal(meta.stdout, '');
  f.board('integration', 'branch=orchestra/test/main', 'worktree=/tmp/main', 'base=abc', 'landedAt=2026-10-29T00:00:00Z');
  await f.addJob('parent', worktree, '2', 100); await f.addJob('child', external, '2.1', 200);
  const sibling = `${f.cwd}-other`; await mkdir(sibling); await f.addJob('unrelated', sibling, '2.1', 999);
  await symlink(sibling, join(f.cwd, 'outside-link')); await f.addJob('symlink-outside', join(f.cwd, 'outside-link'), '2', 999);
  await json(join(f.env.CLAUDE_CONFIG_DIR, 'plugins/data/codex-openai-codex/state/fixture/state.json'), { jobs: [
    { id: 'secondary', workspaceRoot: worktree, summary: '#2 plugin', status: 'completed', createdAt: f.startedAt, completedAt: new Date().toISOString() },
  ] });
  const agentPath = join(dirname(f.transcriptPath), f.sessionId, 'subagents/agent-claude-child.jsonl');
  await mkdir(dirname(agentPath), { recursive: true });
  await writeFile(agentPath, JSON.stringify({ type: 'assistant', cwd: worktree, timestamp: f.startedAt, isSidechain: true,
    message: { id: 'child', model: 'claude-sonnet', stop_reason: 'end_turn', usage: { input_tokens: 5 }, content: [] } }) + '\n');
  await json(agentPath.replace(/\.jsonl$/, '.meta.json'), { description: '#2.1 child', agentType: 'general-purpose' });
  await json(f.env.KB_STATS, { notes: 1, hits: 0, savedTokens: 200, recent: [] });
  await mkdir(dirname(f.kbPath), { recursive: true }); await writeFile(f.kbPath, 'memory');
  const session = f.collect(worktree);
  assert.equal(session.project.cwd, f.cwd); assert.equal(session.project.name, 'repo'); assert.equal(session.kb.notes, 1);
  assert.deepEqual(session.agents.map(agent => agent.id).sort(), ['child', 'claude-child', 'parent', 'secondary']);
  const [parent, child] = session.board.tasks;
  assert.equal(parent.parentId, null); assert.equal(parent.branch, null); assert.equal(parent.merged, false);
  assert.equal(child.parentId, '2'); assert.equal(child.branch, 'orchestra/test/2.1'); assert.equal(child.merged, true);
  assert.equal(parent.tokens.spent, 100); assert.equal(child.tokens.spent, 205); assert.equal(session.totals.spent, 315);
  assert.equal(session.totals.tasks.queued, 2); assert.equal(session.board.integration.base, 'abc');
  const rows = f.cli('hud/subagent-rows.mjs', [], JSON.stringify({ columns: 100, tasks: [
    { id: 'parent-row', description: '#2 task', agentType: 'codex:codex-rescue', cwd: f.cwd },
    { id: 'child-row', description: '#2.1 task', agentType: 'codex:codex-rescue', cwd: worktree },
  ] }));
  assert.equal(rows.status, 0, rows.stderr);
  const contents = rows.stdout.trim().split('\n').map(line => JSON.parse(line).content);
  assert.match(contents[0], /Codex\s+100\s/); assert.match(contents[1], /Codex\s+200\s/);
});
