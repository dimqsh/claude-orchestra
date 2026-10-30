import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, appendFile, rm, rename, symlink, utimes, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
const childDiagnostics = result => `signal=${result.signal}; stderr=${result.stderr ?? ''}`;

const root = await mkdtemp(join(tmpdir(), 'orchestra-core-'));
const fixtureEnv = { ORCHESTRA_HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') };
after(() => rm(root, { recursive: true, force: true }));
let paths, core, render, applyCodexEvent;
before(async () => {
  // Isolate module-level path constants from the other suites in test/index.mjs.
  const runtime = join(root, 'runtime');
  await cp(new URL('../plugins/orchestra/lib/', import.meta.url), join(runtime, 'lib'), { recursive: true });
  await mkdir(join(runtime, 'scripts'), { recursive: true });
  await cp(new URL('../plugins/orchestra/scripts/codex-task.mjs', import.meta.url), join(runtime, 'scripts/codex-task.mjs'));
  const saved = Object.fromEntries(Object.keys(fixtureEnv).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, fixtureEnv);
    paths = await import(pathToFileURL(join(runtime, 'lib/paths.mjs')));
    core = await import(pathToFileURL(join(runtime, 'lib/collect.mjs')));
    render = await import(pathToFileURL(join(runtime, 'lib/render.mjs')));
    ({ applyCodexEvent } = await import(pathToFileURL(join(runtime, 'scripts/codex-task.mjs'))));
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
const base = resolve(fileURLToPath(new URL('../', import.meta.url)));
const fixture = name => readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
async function waitFor(check, description, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function fileContains(path, expected) {
  try { return (await readFile(path, 'utf8')) === expected; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
let sequence = 0;
async function workspace() { const cwd = join(root, `workspace-${sequence++}`); await mkdir(cwd); return cwd; }
async function sessionFixture() {
  const cwd = await workspace(), sessionId = `session-${sequence}`, dir = paths.projectDir(cwd);
  await mkdir(join(dir, sessionId, 'subagents'), { recursive: true });
  const transcriptPath = join(dir, `${sessionId}.jsonl`);
  await writeFile(transcriptPath, await fixture('claude-main.jsonl'));
  await writeFile(join(dir, sessionId, 'subagents/agent-a1.jsonl'), await fixture('claude-agent.jsonl'));
  await paths.atomicJSON(join(dir, sessionId, 'subagents/agent-a1.meta.json'), { agentType: 'general-purpose', description: '#1 fix bug', toolUseId: 't1' });
  return { cwd, sessionId, transcriptPath, dir };
}
function cli(script, args = [], input = '', env = {}) {
  return spawnSync(process.execPath, [join(base, 'plugins/orchestra', script), ...args], { input, encoding: 'utf8', env: { ...process.env, ...fixtureEnv, ...env }, timeout: 30000 });
}
const strip = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
async function job(cwd, overrides = {}) {
  const value = { version: 1, id: `cx-test-${sequence++}`, label: '#1 task', cwd, model: 'gpt-test', status: 'completed', pid: process.pid,
    startedAt: '2026-10-29T01:00:02.000Z', endedAt: '2026-10-29T01:00:03.000Z', activity: 'Bash pytest -q', tokens: core.codexTokens({ input_tokens: 100, cached_input_tokens: 80, output_tokens: 5 }), ...overrides };
  await paths.atomicJSON(join(paths.jobsDir(), `${value.id}.json`), value); return value;
}

test('paths follow overrides, slug rules and realpath board identity', async () => {
  const cwd = await workspace(), alias = `${cwd}-link`; await symlink(cwd, alias);
  assert.equal(paths.projectSlug('/a_b.c/é'), '-a-b-c--');
  assert.equal(paths.boardPath(cwd), paths.boardPath(alias));
  assert.equal(paths.codexHome, join(root, 'codex'));
  assert.deepEqual(paths.orchestraConfig(), {});
});
test('Claude and Codex accounting exclude reads and avoid reasoning double count', () => {
  assert.deepEqual(core.claudeTokens({ input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 1000, output_tokens: 30 }), { input: 10, cacheWrite: 20, cacheRead: 1000, output: 30, spent: 60 });
  assert.deepEqual(core.codexTokens({ input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 15 }), { input: 20, cacheWrite: 0, cacheRead: 80, output: 20, spent: 40 });
  assert.equal(core.codexTokens({ input_tokens: 1, cached_input_tokens: 4 }).spent, 0);
});
test('task ids use anchored contract pattern', () => {
  for (const [label, id] of [['#2 export', '2'], ['#abc-2.3 title', 'abc-2.3'], ['#a_b title', 'a_b'], [' #2 x', null], ['title #2', null], ['', null]]) assert.equal(core.parseTaskId(label), id);
});
test('collector dedupes message.id, ignores snapshots and sidechains, resolves notification completion and task aggregation', async () => {
  const data = await sessionFixture();
  await paths.atomicJSON(paths.boardPath(data.cwd), { title: 'board', sessionId: data.sessionId, createdAt: '2026-10-29T01:00:00Z', finishedAt: null, tasks: [{ id: '1', title: 'task', status: 'review', executor: 'sonnet', attempts: 1 }] });
  const session = await core.collectSession(data);
  assert.equal(session.orchestrator.tokens.spent, 60);
  assert.equal(session.agents.length, 1);
  assert.equal(session.agents[0].tokens.spent, 23);
  assert.equal(session.agents[0].status, 'completed');
  assert.equal(session.agents[0].endedAt, '2026-10-29T01:00:04.000Z');
  assert.equal(session.agents[0].executor, 'sonnet');
  assert.equal(session.totals.spent, 83);
  assert.equal(session.board.tasks[0].tokens.spent, 23);
  assert.deepEqual(session.board.tasks[0].agentIds, ['a1']);
  assert.equal(session.totals.tasks.review, 1);
  assert.deepEqual(await core.findLatestTranscript(data.cwd), { transcriptPath: data.transcriptPath, sessionId: data.sessionId });
});
test('incremental cache handles split UTF-8, no-newline tails, appends, truncation and inode replacement', async () => {
  const data = await sessionFixture();
  await core.collectSession(data);
  const row = JSON.stringify({ type: 'assistant', message: { id: 'm2', model: 'claude-opus', usage: { input_tokens: 2, output_tokens: 3 }, content: [{ type: 'text', text: 'é' }] } });
  const bytes = Buffer.from(row), split = bytes.indexOf(Buffer.from('é')) + 1;
  await appendFile(data.transcriptPath, bytes.subarray(0, split));
  assert.equal((await core.collectSession(data)).orchestrator.tokens.spent, 60);
  await appendFile(data.transcriptPath, bytes.subarray(split));
  assert.equal((await core.collectSession(data)).orchestrator.tokens.spent, 65);
  assert.equal((await core.collectSession(data)).orchestrator.tokens.spent, 65);
  await appendFile(data.transcriptPath, '\n');
  assert.equal((await core.collectSession(data)).orchestrator.tokens.spent, 65);
  await writeFile(data.transcriptPath, `${row}\n`);
  assert.equal((await core.collectSession(data)).orchestrator.tokens.spent, 5);
  await writeFile(`${data.transcriptPath}.new`, await fixture('claude-main.jsonl'));
  await rename(`${data.transcriptPath}.new`, data.transcriptPath);
  assert.equal((await core.collectSession(data)).orchestrator.tokens.spent, 60);
});
test('foreground tool result marks completed or failed; background failures and stopped notifications', async () => {
  const data = await sessionFixture();
  for (const [isError, expected] of [[false, 'completed'], [true, 'failed']]) {
    await writeFile(data.transcriptPath, [
      { type: 'assistant', timestamp: '2026-10-29T01:00:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { description: '#1 foreground', model: 'haiku' } }] } },
      { type: 'user', timestamp: '2026-10-29T01:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: isError, content: 'agentId: a1\nDone' }] }, toolUseResult: { agentId: 'a1' } },
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal((await core.collectSession(data)).agents[0].status, expected);
  }
  for (const status of ['failed', 'stopped']) {
    await appendFile(data.transcriptPath, `${JSON.stringify({ type: 'queue-operation', timestamp: '2026-10-29T01:00:05Z', content: `<task-notification><task-id>a1</task-id><status>${status}</status></task-notification>` })}\n`);
    assert.equal((await core.collectSession(data)).agents[0].status, status);
  }
});
test('own Codex jobs, dead pid and forwarder lifetime merge prefer Codex tokens', async () => {
  const data = await sessionFixture();
  await paths.atomicJSON(join(data.dir, data.sessionId, 'subagents/agent-a1.meta.json'), { agentType: 'codex:codex-rescue', description: '#1 task', toolUseId: 't1' });
  assert.equal((await core.collectSession(data)).agents[0].executor, 'codex');
  const codex = await job(data.cwd);
  let session = await core.collectSession(data);
  assert.deepEqual(session.agents.map(a => a.id), [codex.id]);
  assert.equal(session.totals.spent, 85);
  await job(data.cwd, { id: codex.id, startedAt: '2026-10-29T02:00:00Z', endedAt: null, status: 'running', pid: 2147483647 });
  session = await core.collectSession(data);
  assert.equal(session.agents.length, 2, 'non-overlap keeps forwarder');
  assert.equal(session.agents.find(a => a.id === codex.id).status, 'stopped');
});
test('secondary Codex state reads last non-null cumulative usage and model', async () => {
  const cwd = await workspace(), state = join(paths.codexStateRoots()[0], 'fixture'), rollout = join(paths.codexHome, 'sessions/2026/10/29/rollout-synthetic-thread.jsonl');
  await paths.atomicJSON(join(state, 'state.json'), { jobs: [{ id: 'plugin-job', workspaceRoot: cwd, summary: '#7 check', status: 'completed', phase: 'done', threadId: 'synthetic-thread', createdAt: '2026-10-29T01:00:00Z' }] });
  await mkdir(join(paths.codexHome, 'sessions/2026/10/29'), { recursive: true });
  await writeFile(rollout, [
    { type: 'turn_context', payload: { model: 'gpt-test' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 150, output_tokens: 20 } } } },
    { type: 'event_msg', payload: { type: 'token_count', info: null } },
  ].map(JSON.stringify).join('\n') + '\n');
  const [agent] = await core.collectCodexJobs(cwd);
  assert.equal(agent.tokens.spent, 70); assert.equal(agent.model, 'gpt-test'); assert.equal(agent.taskId, '7');
});
test('active snapshot filters old sessions and orders by transcript mtime', async () => {
  const old = await sessionFixture(), fresh = await sessionFixture();
  await utimes(old.transcriptPath, new Date(0), new Date(0));
  const snapshot = await core.collectActive({ sinceMinutes: 1 });
  assert.equal(snapshot.version, 1);
  assert(!snapshot.sessions.some(s => s.sessionId === old.sessionId));
  assert(snapshot.sessions.some(s => s.sessionId === fresh.sessionId));
  assert(snapshot.sessions.every((s, i) => !i || s.updatedAt <= snapshot.sessions[i - 1].updatedAt));
});
test('renderBoard has no default ANSI, exact token formats, colors and width truncation', () => {
  const session = { project: { name: 'project', branch: 'main' }, agents: [], totals: { spent: 18200, byExecutor: { opus: 18200 }, tasks: { queued: 1 } }, board: { tasks: [{ id: '1', title: 'very long task '.repeat(10), executor: 'codex', status: 'queued', dependsOn: ['2'], tokens: core.emptyTokens() }] } };
  const plain = render.renderBoard(session, { width: 60 });
  assert(!plain.includes('\x1b')); assert(plain.includes('…'));
  assert(plain.split('\n').every(line => Array.from(line).length <= 60));
  const colored = render.renderBoard(session, { width: 60, color: true });
  assert(colored.includes('\x1b[38;2;')); assert.equal(strip(colored), plain);
  assert.deepEqual([512, 18200, 1400000, 14000].map(render.formatTokens), ['512', '18.2k', '1.4M', '14k']);
  assert(render.renderRows({ agents: [{ description: '#2 agent', executor: 'haiku', status: 'running', activity: 'Bash tests', tokens: { spent: 10 } }] })[0].includes('#2 agent'));
});
test('board CLI init/add/set/exec/show/finish/json, attempts and archive use atomic writes', async () => {
  const cwd = await workspace();
  function board(...args) {
    const result = cli('scripts/board.mjs', [...args, '--cwd', cwd]);
    assert.equal(result.status, 0, childDiagnostics(result));
    assert.equal(result.stderr, '');
    if (!['show', 'json'].includes(args[0])) assert.equal(result.stdout, '', `${args[0]} is silent`);
    return result.stdout.trim();
  }
  board('init', 'check', '--session', 'sid'); board('add', '1', 'task', '--exec', 'codex'); board('add', '2', 'dependent', '--exec', 'sonnet', '--deps', '1');
  board('set', '1', 'running'); board('set', '1', 'running');
  assert.equal(JSON.parse(board('json')).tasks[0].attempts.length, 1);
  board('set', '1', 'rework', '--note', 'fix it'); board('set', '1', 'running'); board('exec', '1', 'opus');
  assert.equal(JSON.parse(board('json')).tasks[0].attempts.length, 2);
  assert.equal(JSON.parse(board('json')).tasks[0].executor, 'opus');
  assert(board('show').includes('waits on #1')); assert(!board('show').includes('\x1b'));
  assert(board('show', '--color').includes('\x1b'));
  board('set', '1', 'done'); board('finish'); assert(JSON.parse(board('json')).finishedAt);
  const dir = join(paths.orchestraHome, 'boards'); assert(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
  const before = await readFile(paths.boardPath(cwd), 'utf8');
  const bad = cli('scripts/board.mjs', ['set', '1', 'invalid', '--cwd', cwd]);
  assert.equal(bad.status, 1); assert.equal(bad.stderr.trim().split('\n').length, 1);
  assert.equal(await readFile(paths.boardPath(cwd), 'utf8'), before);
  board('init', 'fresh'); assert.equal(JSON.parse(board('json')).tasks.length, 0);
  assert((await readdir(join(dir, 'archive'))).some(name => name.endsWith('.json')));
});
async function fakeCodex(t, cwd, env = {}) {
  const bin = join(cwd, 'bin'); await mkdir(bin);
  const events = join(cwd, 'events.jsonl'); await writeFile(events, await fixture('codex-events.jsonl'));
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node\nconst fs=require('node:fs');\nfs.writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));fs.writeFileSync(process.env.FAKE_CWD,process.cwd());\nlet p='';process.stdin.on('data',d=>p+=d);process.stdin.on('end',()=>{fs.writeFileSync(process.env.FAKE_PROMPT,p);const events=fs.readFileSync(process.env.FAKE_EVENTS,'utf8');process.stdout.write(events.slice(0,37));setTimeout(()=>{process.stdout.write(events.slice(37));process.exitCode=Number(process.env.FAKE_EXIT||0);},20);});\n`, { mode: 0o755 });
  return { ...fixtureEnv, PATH: `${bin}:${process.env.PATH}`, FAKE_EVENTS: events, FAKE_ARGS: join(cwd, 'args.json'), FAKE_CWD: join(cwd, 'cwd.txt'), FAKE_PROMPT: join(cwd, 'prompt.txt'), ...env };
}
test('Codex parser understands activities, updates and failures', () => {
  const value = { tokens: core.emptyTokens() };
  for (const [type, item, activity] of [['item.started', { type: 'command_execution', command: 'pytest -q' }, 'Bash pytest -q'], ['item.updated', { type: 'file_change', changes: [{ path: '/src/foo.py' }] }, 'editing foo.py'], ['item.started', { type: 'reasoning' }, 'thinking'], ['item.started', { type: 'mcp_tool_call' }, 'mcp_tool_call']]) {
    applyCodexEvent(value, { type, item }); assert.equal(value.activity, activity);
  }
  applyCodexEvent(value, { type: 'turn.failed', error: { message: 'bad' } }); assert.equal(value.error, 'bad');
});
test('codex-task fake executable: arguments, event parsing, job writes, token sums and footer', async t => {
  const cwd = await workspace(), env = await fakeCodex(t, cwd);
  const result = cli('scripts/codex-task.mjs', ['--cwd', cwd, '--model', 'gpt-test', '--effort', 'high', '--write'], '\n#2 check\nrun it', env);
  assert.equal(result.status, 0, childDiagnostics(result));
  const finalAnswer = (await fixture('codex-events.jsonl')).trim().split('\n').map(JSON.parse).filter(event => event.item?.type === 'agent_message').at(-1).item.text;
  assert.match(result.stdout, new RegExp(`^${finalAnswer}\\n\\[codex\\] #2 done · 370 tokens · 0m\\d+s`));
  const args = JSON.parse(await readFile(env.FAKE_ARGS, 'utf8'));
  assert.deepEqual(args, ['exec', '--json', '--skip-git-repo-check', '-m', 'gpt-test', '-c', 'model_reasoning_effort=high', '-s', 'workspace-write', '-C', paths.canonicalPath(cwd), '-']);
  const [agent] = await core.collectCodexJobs(cwd); assert.equal(agent.tokens.spent, 370); assert.equal(agent.tokens.input, 300); assert.equal(agent.tokens.cacheRead, 900);
  const written = await core.readJSON(join(paths.jobsDir(), `${agent.id}.json`));
  assert.equal(written.status, 'completed'); assert.equal(written.threadId, 'synthetic-thread'); assert(written.endedAt); assert(written.write); assert.equal(written.taskId, '2');
  // Since contract section 15 the runner appends the "## Findings" request after the task text.
  const sentPrompt = await readFile(env.FAKE_PROMPT, 'utf8');
  assert(sentPrompt.startsWith('\n#2 check\nrun it'), sentPrompt);
  assert.match(sentPrompt, /## Findings/);
  assert(!(await readdir(paths.jobsDir())).some(name => name.endsWith('.tmp')));
  const resumed = cli('scripts/codex-task.mjs', ['--cwd', cwd, '--resume-last'], '#2 more', env);
  assert.equal(resumed.status, 0, childDiagnostics(resumed));
  const resumedArgs = JSON.parse(await readFile(env.FAKE_ARGS, 'utf8'));
  assert.deepEqual(resumedArgs, ['exec', 'resume', 'synthetic-thread', '-m', 'gpt-6.1-sol', '-c', 'sandbox_mode="read-only"', '--json', '--skip-git-repo-check', '-']);
  assert.equal(await readFile(env.FAKE_CWD, 'utf8'), paths.canonicalPath(cwd));
  const writableResume = cli('scripts/codex-task.mjs', ['--cwd', cwd, '--resume-last', '--write', '--model', 'gpt-resume', '--effort', 'high'], '#2 edit', env);
  assert.equal(writableResume.status, 0, childDiagnostics(writableResume));
  assert.deepEqual(JSON.parse(await readFile(env.FAKE_ARGS, 'utf8')), ['exec', 'resume', 'synthetic-thread', '-m', 'gpt-resume', '-c', 'sandbox_mode="workspace-write"', '--json', '--skip-git-repo-check', '-c', 'model_reasoning_effort=high', '-']);
  assert.equal(await readFile(env.FAKE_CWD, 'utf8'), paths.canonicalPath(cwd));
});
test('codex-task rejects bad prompt, persists failure and unsupported-model hint', async t => {
  const cwd = await workspace(), env = await fakeCodex(t, cwd, { FAKE_EXIT: '1' });
  assert.equal(cli('scripts/codex-task.mjs', ['--cwd', cwd], 'missing task id', env).status, 1);
  await writeFile(env.FAKE_EVENTS, '{"type":"turn.failed","error":{"message":"model not supported"}}\n');
  const result = cli('scripts/codex-task.mjs', ['--cwd', cwd], '#3 fail', env);
  assert.equal(result.status, 1); assert.match(result.stdout, /update the Codex CLI: codex update/); assert.match(result.stdout, /\[codex\] #3 failed/);
  const [agent] = await core.collectCodexJobs(cwd); assert.equal(agent.status, 'failed');
});
test('statusline chain receives identical stdin, header prints, malformed input and missing transcript fall back with zero exit', async () => {
  const data = await sessionFixture(), chainPath = join(data.cwd, 'chain.cjs');
  await writeFile(chainPath, "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log('CHAIN '+JSON.parse(s).session_id));");
  await paths.atomicJSON(join(paths.orchestraHome, 'config.json'), { chain: `"${process.execPath}" "${chainPath}"` });
  const input = JSON.stringify({ cwd: data.cwd, transcript_path: data.transcriptPath, session_id: data.sessionId });
  const result = cli('hud/statusline.mjs', [], input);
  assert.equal(result.status, 0, childDiagnostics(result)); assert(result.stdout.startsWith(`CHAIN ${data.sessionId}\n◆`)); assert(strip(result.stdout).includes('Opus 60'));
  for (const input of ['broken', 'null', JSON.stringify({ transcript_path: '/missing', cwd: data.cwd })]) {
    const fallback = cli('hud/statusline.mjs', [], input); assert.equal(fallback.status, 0, childDiagnostics(fallback)); assert.match(fallback.stdout, /◆/);
  }
  await paths.atomicJSON(join(paths.orchestraHome, 'config.json'), { chain: `"${process.execPath}" -e "setTimeout(()=>{},10000)"` });
  const start = performance.now(), timeout = cli('hud/statusline.mjs', [], input);
  assert.equal(timeout.status, 0, childDiagnostics(timeout)); assert(performance.now() - start < 2500);
  await rm(join(paths.orchestraHome, 'config.json'));
});
test('statusline rows obey board lifetime, running agents, six row cap and width', async () => {
  const data = await sessionFixture();
  const board = { title: 'board', sessionId: data.sessionId, createdAt: new Date().toISOString(), finishedAt: null, tasks: Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), title: 'task', executor: 'sonnet', status: 'queued' })) };
  await paths.atomicJSON(paths.boardPath(data.cwd), board);
  const input = JSON.stringify({ cwd: data.cwd, transcript_path: data.transcriptPath, session_id: data.sessionId });
  let output = strip(cli('hud/statusline.mjs', [], input, { COLUMNS: '80' }).stdout);
  assert.match(output, /… 2 more/); assert.equal(output.split('\n').filter(line => /^[├╰]/.test(line)).length, 6);
  board.finishedAt = new Date(Date.now() - 11 * 60000).toISOString(); await paths.atomicJSON(paths.boardPath(data.cwd), board);
  output = strip(cli('hud/statusline.mjs', [], input).stdout); assert.equal(output.trim().split('\n').length, 1);
  board.finishedAt = new Date().toISOString(); await paths.atomicJSON(paths.boardPath(data.cwd), board);
  assert.match(strip(cli('hud/statusline.mjs', [], input).stdout), /├─/);
});
test('subagent rows emit per-task JSON, duration, fallback tokens, merged Codex activity/tokens and truncation', async () => {
  const cwd = await workspace(); await job(cwd, { label: '#1 task', startedAt: new Date(Date.now() - 60000).toISOString(), endedAt: null, status: 'running' });
  const tasks = [{ id: 'a', description: '#1 task', agentType: 'codex:codex-rescue', status: 'running', cwd, tokenCount: 999, startTime: Date.now() - 134000 }, { id: 'b', description: '#2 other', model: 'claude-sonnet', tokenCount: 123, startTime: Date.now() }];
  const result = cli('hud/subagent-rows.mjs', [], JSON.stringify({ columns: 100, tasks }));
  assert.equal(result.status, 0, childDiagnostics(result)); const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.id), ['a', 'b']); assert.match(rows[0].content, /Codex\s+25\s+Bash pytest -q.*2m1[45]s/); assert.match(rows[1].content, /Sonnet.*123/);
  const short = cli('hud/subagent-rows.mjs', [], JSON.stringify({ columns: 20, tasks }));
  assert(short.stdout.trim().split('\n').map(JSON.parse).every(row => Array.from(row.content).length <= 20));
  const bad = cli('hud/subagent-rows.mjs', [], 'bad');
  assert.equal(bad.status, 0, childDiagnostics(bad));
});

test('sidecar links launch before its result arrives without a duplicate phantom agent', async () => {
  const data = await sessionFixture();
  const firstLine = (await fixture('claude-main.jsonl')).split('\n')[0];
  await writeFile(data.transcriptPath, `${firstLine}\n`);
  const session = await core.collectSession(data);
  assert.equal(session.agents.length, 1); assert.equal(session.agents[0].id, 'a1'); assert.equal(session.agents[0].status, 'running');
});

test('codex-task writes live running state, throttles progress writes and always writes the final state', async t => {
  const cwd = await workspace(), env = await fakeCodex(t, cwd);
  await writeFile(join(cwd, 'bin/codex'), `#!/usr/bin/env node
process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'live-thread'}));let n=0;const timer=setInterval(()=>console.log(JSON.stringify({type:'item.updated',item:{type:'command_execution',command:'step '+n++}})),40);setTimeout(()=>{clearInterval(timer);console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:2,output_tokens:3}}));},1400);});
`, { mode: 0o755 });
  const child = spawn(process.execPath, [join(base, 'plugins/orchestra/scripts/codex-task.mjs'), '--cwd', cwd], { env: { ...process.env, ...env } });
  t.after(() => child.kill('SIGKILL'));
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume(); child.stdin.end('#8 live');
  const exit = new Promise(resolveExit => child.on('close', resolveExit)), writes = [];
  let finished = false; exit.then(() => { finished = true; });
  while (!finished) {
    const files = await readdir(paths.jobsDir()).catch(() => []);
    for (const file of files.filter(file => file.endsWith('.json'))) {
      const value = await core.readJSON(join(paths.jobsDir(), file));
      if (value?.cwd !== paths.canonicalPath(cwd)) continue;
      const encoded = JSON.stringify(value);
      if (writes.at(-1)?.encoded !== encoded) writes.push({ encoded, at: performance.now(), value });
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.equal(await exit, 0); assert.match(stdout, /#8 done/);
  const live = writes.filter(write => write.value.status === 'running');
  assert(live.length >= 2, 'initial running state and live progress are visible');
  for (let i = 1; i < live.length; i++) assert(live[i].at - live[i - 1].at >= 900, 'progress writes are at least one second apart, allowing observation jitter');
  assert.equal(live[1].value.threadId, 'live-thread');
  const [agent] = await core.collectCodexJobs(cwd); assert.equal(agent.status, 'completed'); assert.equal(agent.tokens.spent, 11);
});

test('SIGTERM is forwarded and persisted as a failed stopped job', { timeout: 10000 }, async t => {
  const cwd = await workspace(), env = await fakeCodex(t, cwd), marker = join(cwd, 'signal.txt'), ready = join(cwd, 'ready.txt');
  await writeFile(join(cwd, 'bin/codex'), `#!/usr/bin/env node
const fs=require('node:fs');process.stdin.resume();process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'SIGTERM');process.exit(1)});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},500);
`, { mode: 0o755 });
  const child = spawn(process.execPath, [join(base, 'plugins/orchestra/scripts/codex-task.mjs'), '--cwd', cwd], { env: { ...process.env, ...env } });
  t.after(() => child.kill('SIGKILL'));
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume(); child.stdin.end('#9 stop');
  const exit = new Promise(resolveExit => child.on('close', resolveExit));
  await waitFor(() => fileContains(ready, 'ready'), 'fake codex signal-handler readiness');
  assert(child.kill('SIGTERM'));
  await waitFor(() => fileContains(marker, 'SIGTERM'), 'forwarded SIGTERM acknowledgement');
  assert.equal(await exit, 1);
  assert.equal(await readFile(marker, 'utf8'), 'SIGTERM'); assert.match(stdout, /stopped/);
  const [agent] = await core.collectCodexJobs(cwd); assert.equal(agent.status, 'failed');
  const value = await core.readJSON(join(paths.jobsDir(), `${agent.id}.json`)); assert.equal(value.error, 'stopped'); assert(value.endedAt);
});

test('Codex model precedence is flag, config, environment, default; whitespace before task label is rejected', async t => {
  const cwd = await workspace(), env = await fakeCodex(t, cwd), config = join(paths.orchestraHome, 'config.json');
  async function check(extraArgs, expected, overrides = {}) {
    const result = cli('scripts/codex-task.mjs', ['--cwd', cwd, ...extraArgs], '#10 model', { ...env, ...overrides });
    assert.equal(result.status, 0, childDiagnostics(result));
    const args = JSON.parse(await readFile(env.FAKE_ARGS, 'utf8')); assert.equal(args[args.indexOf('-m') + 1], expected);
  }
  await paths.atomicJSON(config, { codexModel: 'config-model' });
  try {
    await check(['--model', 'flag-model'], 'flag-model', { ORCHESTRA_CODEX_MODEL: 'env-model' });
    await check([], 'config-model', { ORCHESTRA_CODEX_MODEL: 'env-model' });
    await rm(config);
    await check([], 'env-model', { ORCHESTRA_CODEX_MODEL: 'env-model' });
    await check([], 'gpt-6.1-sol', { ORCHESTRA_CODEX_MODEL: '' });
    assert.equal(cli('scripts/codex-task.mjs', ['--cwd', cwd], '  #10 invalid', env).status, 1);
  } finally { await rm(config, { force: true }); }
});

test('atomic JSON replacement exposes only whole board documents to concurrent readers', async () => {
  const cwd = await workspace(), path = paths.boardPath(cwd);
  await paths.atomicJSON(path, { version: 1, tasks: [], sequence: 0, title: 'é'.repeat(100000) });
  let complete = false, reads = 0;
  const writer = (async () => {
    try { for (let sequence = 1; sequence <= 20; sequence++) await paths.atomicJSON(path, { version: 1, tasks: [], sequence, title: 'ü'.repeat(100000) }); }
    finally { complete = true; }
  })();
  while (!complete) {
    const value = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(value.version, 1); assert.equal(value.title.length, 100000); reads++;
  }
  await writer;
  assert(reads > 0); assert.equal(JSON.parse(await readFile(path, 'utf8')).sequence, 20);
});

test('fixed columns retain executor, right-aligned tokens and activity for long task and agent labels', () => {
  const rows = [
    { id: '1', description: '#1 short', executor: 'codex', tokens: { spent: 0 } },
    { id: '2', description: `#2 ${'long title '.repeat(20)}\nHIDDEN_SECOND_LINE`, executor: 'sonnet', tokens: { spent: 309000 } },
    { id: '3', description: '#3 test', executor: 'haiku', tokens: { spent: 24 } },
  ].map(row => ({ ...row, title: row.description.slice(3), status: 'running', activity: 'Bash pytest -q', note: 'Bash pytest -q' }));
  for (const width of [60, 100, 140]) {
    const executorOffset = 3 + 2 + Math.round(width * 0.28) + 1, tokenOffset = executorOffset + 7;
    for (const session of [{ agents: rows }, { agents: [], board: { tasks: rows } }]) {
      const lines = render.renderRows(session, { width });
      assert.equal(lines.length, rows.length);
      assert.deepEqual(render.renderRows(session, { width, color: true }).map(strip), lines);
      for (const [index, line] of lines.entries()) {
        assert.equal(line.indexOf(render.executorName(rows[index].executor)), executorOffset);
        assert.equal(line.slice(executorOffset, executorOffset + 6), render.executorName(rows[index].executor).padEnd(6));
        assert.equal(line.slice(tokenOffset, tokenOffset + 6), (rows[index].tokens.spent ? render.formatTokens(rows[index].tokens.spent) : '—').padStart(6));
        assert(line.includes('Bash')); assert(!line.includes('HIDDEN_SECOND_LINE'));
        assert(Array.from(line).length <= width);
      }
    }
  }
});

test('subagent rows share fixed first-line label, executor and token columns', () => {
  const tasks = [
    { id: 'a', description: '#1 short', model: 'claude-haiku', tokenCount: 24 },
    { id: 'b', description: `#2 ${'long title '.repeat(20)}\nHIDDEN_SECOND_LINE`, model: 'claude-sonnet', tokenCount: 309000 },
    { id: 'c', description: '#3 empty', model: 'claude-opus', tokenCount: 0 },
  ].map(task => ({ ...task, status: 'running', activity: 'Bash pytest -q' }));
  const result = cli('hud/subagent-rows.mjs', [], JSON.stringify({ columns: 100, tasks }));
  assert.equal(result.status, 0, childDiagnostics(result));
  const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line).content);
  const names = ['Haiku', 'Sonnet', 'Opus'], tokens = ['24', '309k', '—'];
  for (const [index, line] of lines.entries()) {
    assert.equal(line.indexOf(names[index]), 31);
    assert.equal(line.slice(31, 37), names[index].padEnd(6));
    assert.equal(line.slice(38, 44), tokens[index].padStart(6));
    assert(line.includes('Bash pytest -q')); assert(!line.includes('HIDDEN_SECOND_LINE'));
    assert(Array.from(line).length <= 100);
  }
});

test('placeholder models are ignored in favor of metadata, requestedModel or the last real model', async () => {
  const data = await sessionFixture(), agentPath = join(data.dir, data.sessionId, 'subagents/agent-a1.jsonl');
  const metaPath = agentPath.replace(/\.jsonl$/, '.meta.json');
  const meta = { agentType: 'research', description: '#1 API error', toolUseId: 't1', model: 'sonnet' };
  const stub = { type: 'assistant', requestedModel: 'haiku', timestamp: '2026-10-29T01:00:03Z', message: { id: 'placeholder-stub', model: '<synthetic>', content: [] } };
  await writeFile(agentPath, `${JSON.stringify(stub)}\n`); await paths.atomicJSON(metaPath, meta);
  let agent = (await core.collectSession(data)).agents[0];
  assert.equal(agent.executor, 'sonnet'); assert.equal(agent.model, 'sonnet');
  delete meta.model; await paths.atomicJSON(metaPath, meta);
  agent = (await core.collectSession(data)).agents[0];
  assert.equal(agent.executor, 'haiku'); assert.equal(agent.model, 'haiku');
  // A cache produced by the previous parser must not keep its synthetic model.
  for (const file of await readdir(paths.cacheDir())) {
    const path = join(paths.cacheDir(), file), cached = await core.readJSON(path);
    if (cached?.state?.ids?.['placeholder-stub']) {
      cached.version = 1; cached.state.model = '<synthetic>'; delete cached.state.requestedModel;
      await paths.atomicJSON(path, cached);
    }
  }
  assert.equal((await core.collectSession(data)).agents[0].executor, 'haiku');
  await appendFile(agentPath, `${JSON.stringify({ ...stub, message: { id: 'real-model', model: 'claude-opus-5-5', content: [] } })}\n${JSON.stringify({ ...stub, message: { id: 'later-stub', model: '<synthetic>', content: [] } })}\n`);
  agent = (await core.collectSession(data)).agents[0];
  assert.equal(agent.executor, 'opus'); assert.equal(agent.model, 'claude-opus-5-5');
  assert.equal(core.executorFor('<sonnet>'), 'other');
});

test('finished Claude and Codex agents report terminal activity; board notes override terminal labels', async () => {
  const data = await sessionFixture(), agentPath = join(data.dir, data.sessionId, 'subagents/agent-a1.jsonl');
  await appendFile(agentPath, `${JSON.stringify({ type: 'assistant', message: { id: 'handback', content: [{ type: 'tool_use', name: 'SubagentHandback', input: {} }] } })}\n`);
  const statuses = ['completed', 'failed', 'stopped'], labels = ['finished', 'failed', 'stopped'];
  for (const [index, status] of statuses.entries()) {
    await appendFile(data.transcriptPath, `${JSON.stringify({ type: 'queue-operation', timestamp: '2026-10-29T01:00:05Z', content: `<task-notification><task-id>a1</task-id><status>${status}</status></task-notification>` })}\n`);
    assert.equal((await core.collectSession(data)).agents.find(agent => agent.id === 'a1').activity, labels[index]);
    await job(data.cwd, { id: 'cx-terminal', status });
    assert.equal((await core.collectCodexJobs(data.cwd))[0].activity, labels[index]);
  }
  const agents = statuses.map((status, index) => ({ id: `a${index}`, description: `#${index} agent`, executor: 'sonnet', status, activity: 'SubagentHandback' }));
  const lines = render.renderRows({ agents });
  for (const [index, line] of lines.entries()) { assert(line.endsWith(labels[index])); assert(!line.includes('SubagentHandback')); }
  const tasks = ['done', 'queued', 'review'].map((status, index) => ({ id: String(index), title: 'task', executor: 'sonnet', status, agentIds: [`a${index}`], note: 'important note', dependsOn: ['2'] }));
  assert(render.renderRows({ agents, board: { tasks } }).every(line => line.endsWith('important note')));
  const result = cli('hud/subagent-rows.mjs', [], JSON.stringify({ columns: 100, tasks: agents.map(agent => ({ ...agent, model: 'sonnet' })) }));
  assert.equal(result.status, 0, childDiagnostics(result));
  for (const [index, line] of result.stdout.trim().split('\n').entries()) {
    const { content } = JSON.parse(line); assert(content.includes(labels[index])); assert(!content.includes('SubagentHandback'));
  }
});

for (const phase of ['before-spawn', 'during-spawn']) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`${signal} ${phase} persists a failed stopped job and exits non-zero`, async t => {
      const cwd = await workspace(), env = await fakeCodex(t, cwd);
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('fixtures/codex-signal-probe.mjs', import.meta.url)), phase, signal, cwd], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10000 });
      assert.equal(result.status, 1, result.stderr); assert.equal(result.signal, null);
      assert.match(result.stdout, /stopped\n\[codex\] #11 failed/);
      const [agent] = await core.collectCodexJobs(cwd);
      assert.equal(agent.status, 'failed');
      const value = await core.readJSON(join(paths.jobsDir(), `${agent.id}.json`));
      assert.equal(value.error, 'stopped'); assert(value.endedAt);
      if (phase === 'before-spawn') assert.equal(await readFile(env.FAKE_ARGS, 'utf8').catch(error => error.code), 'ENOENT', 'cancelled jobs do not start codex');
    });
  }
}
