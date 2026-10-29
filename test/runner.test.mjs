import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const runnerModule = new URL('../plugins/orchestra/lib/runner.mjs', import.meta.url).href;
const collectModule = new URL('../plugins/orchestra/lib/collect.mjs', import.meta.url).href;
const kbModule = new URL('../plugins/orchestra/lib/kb.mjs', import.meta.url).href;
const codexScript = fileURLToPath(new URL('../plugins/orchestra/scripts/codex-task.mjs', import.meta.url));
const tokens = { input: 7, cacheWrite: 0, cacheRead: 3, output: 2, spent: 9 };

async function until(check) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error('Timed out waiting for fake provider');
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orchestra-runner-'));
  const cwd = join(root, 'project'), home = join(root, 'home'), bin = join(root, 'bin');
  await mkdir(cwd); await mkdir(bin);
  const env = { ...process.env, ORCHESTRA_HOME: home, CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'), PATH: `${bin}:${process.env.PATH}`,
    FAKE_PROMPT: join(root, 'prompt'), FAKE_ARGS: join(root, 'args'), FAKE_FINISH: join(root, 'finish'),
    FAKE_RESULT: 'Other provider answer\n## Findings\n- [fact] Shared runner | | Provider-neutral lifecycle.', ...overrides };
  // Deliberately different executable and event vocabulary; no Codex helpers are used.
  await writeFile(join(bin, 'fake-worker'), `#!/usr/bin/env node
const fs = require('node:fs');
let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_PROMPT, prompt);
  fs.writeFileSync(process.env.FAKE_ARGS, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}));
  process.stdout.write('diagnostic, not JSON\\n' + JSON.stringify({phase: 'working'}) + '\\n');
  const finish = () => {
    if (process.env.FAKE_FAIL) { process.stdout.write(JSON.stringify({phase: 'failed', reason: 'fake failure'})); process.exitCode = 1; }
    else process.stdout.write(JSON.stringify({phase: 'finished', answer: process.env.FAKE_RESULT}));
  };
  if (process.env.FAKE_GATE) {
    const timer = setInterval(() => { if (fs.existsSync(process.env.FAKE_FINISH)) { clearInterval(timer); finish(); } }, 25);
  } else finish();
});
`, { mode: 0o755 });
  const script = join(root, 'fake-provider.mjs');
  await writeFile(script, `import { runTask } from ${JSON.stringify(runnerModule)};
const provider = { name: 'fake', displayName: 'Fake', command: 'fake-worker', idPrefix: 'fk', defaultModel: 'fake-default', entrypoint: import.meta.url };
const buildArgs = ({model, effort, write, cwd, resume, threadId}) => [model, effort || 'normal', write ? 'write' : 'read', cwd, ...(resume ? [threadId] : [])];
const parseEvent = (job, event, completedTokens) => {
  if (event.phase === 'working') { job.threadId = 'fake-thread'; job.activity = 'fake activity'; }
  if (event.phase === 'finished') { job.finalMessage = event.answer; Object.assign(completedTokens, ${JSON.stringify(tokens)}); Object.assign(job.tokens, completedTokens); return {completed: true, failed: false}; }
  if (event.phase === 'failed') { job.error = event.reason; return {failed: true}; }
};
const code = await runTask({provider, buildArgs, parseEvent, argv: process.argv.slice(2)});
if (!Number.isInteger(code)) throw new Error('runTask must return a numeric exit code');
process.exitCode = code;
`);
  const children = new Set();
  async function jobs() {
    const files = (await readdir(join(home, 'jobs')).catch(() => [])).filter(name => name.endsWith('.json'));
    return (await Promise.all(files.map(async name => {
      try { return JSON.parse(await readFile(join(home, 'jobs', name), 'utf8')); }
      catch { return null; }
    }))).filter(Boolean);
  }
  t.after(async () => {
    await writeFile(env.FAKE_FINISH, 'finish');
    for (const child of children) child.kill('SIGTERM');
    await until(async () => (await jobs()).every(job => job.status !== 'running')).catch(async () => {
      for (const job of await jobs()) { try { process.kill(job.pid, 'SIGTERM'); } catch { /* Already exited. */ } }
    });
    await rm(root, { recursive: true, force: true });
  });
  function run(args = [], prompt = '#5 shared runner', entry = script) {
    const child = spawn(process.execPath, [entry, ...args], { env });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.stdin.on('error', () => {}); child.stdin.end(prompt);
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Runner did not exit')); }, 10000);
      child.once('error', reject);
      child.once('close', code => { clearTimeout(timer); children.delete(child); accept({ code, stdout, stderr }); });
    });
  }
  function evaluate(code, args = []) {
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, ...args], { env, encoding: 'utf8' }));
  }
  const collect = () => evaluate(`import { collectCodexJobs } from ${JSON.stringify(collectModule)}; console.log(JSON.stringify(await collectCodexJobs(process.argv[1])));`, [cwd]);
  const memory = () => evaluate(`import { openKb } from ${JSON.stringify(kbModule)}; const kb = openKb(process.argv[1], {readOnly: true}); try { console.log(JSON.stringify(kb?.list({recent: 100}) || [])); } finally { kb?.close(); }`, [cwd]);
  return { root, cwd, home, env, run, jobs, collect, memory };
}

test('runTask supports a second provider with shared persistence, flags, findings, memory and footer', async t => {
  const f = await fixture(t);
  const result = await f.run(['--cwd', f.cwd, '--write', '--model', 'other-model', '--effort', 'high']);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  assert.match(result.stdout, /^Other provider answer\n## Findings/);
  assert.match(result.stdout, /\[fake\] #5 done · 9 tokens · \d+m\d+s · to memory: 1\n$/);
  const [job] = await f.jobs();
  assert.match(job.id, /^fk-[a-z0-9]+-[a-z0-9]{4}$/);
  assert.equal(job.provider, 'fake'); assert.equal(job.status, 'completed');
  assert.equal(job.threadId, 'fake-thread'); assert.deepEqual(job.tokens, tokens);
  assert.deepEqual(JSON.parse(await readFile(f.env.FAKE_ARGS, 'utf8')), {
    args: ['other-model', 'high', 'write', job.cwd], cwd: job.cwd,
  });
  assert.match(await readFile(f.env.FAKE_PROMPT, 'utf8'), /## Findings/);
  assert.equal(f.memory()[0].author, 'fake #5');
  assert.deepEqual(await f.run(['wait', job.id]), result);
  const second = await f.run(['--cwd', f.cwd], '#6 shared runner');
  assert.equal(second.code, 0, second.stderr);
  assert.match(await readFile(f.env.FAKE_PROMPT, 'utf8'), /^## Project memory\n/);
  assert.equal(f.memory().length, 1, 'wait never ingests findings again; repeated findings deduplicate');
  const agent = f.collect().find(agent => agent.id === job.id);
  assert.equal(agent.executor, 'fake'); assert.equal(agent.kind, 'fake'); assert.equal(agent.type, 'fake');
  assert.deepEqual(agent.tokens, tokens);
});

test('second provider detach and wait share the lifecycle and preserve live activity', async t => {
  const f = await fixture(t, { FAKE_GATE: 'yes' });
  const detached = await f.run(['--cwd', f.cwd, '--detach']);
  assert.equal(detached.code, 0, detached.stderr); assert.equal(detached.stderr, '');
  assert.match(detached.stdout, /^fk-[a-z0-9]+-[a-z0-9]{4}\n$/);
  const id = detached.stdout.trim();
  await until(async () => (await f.jobs()).find(job => job.activity === 'fake activity'));
  const pending = await f.run(['wait', id, '--timeout', '0']);
  assert.equal(pending.code, 3); assert.equal(pending.stdout, `[fake] ${id} still running; call wait again\n`);
  await writeFile(f.env.FAKE_FINISH, 'finish');
  const result = await f.run(['wait', id, '--timeout', '5']);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /\[fake\] #5 done/);
  assert.deepEqual(await f.run(['wait', id]), result);
});

test('second provider failure and invalid prompts return numeric failures with English output', async t => {
  const f = await fixture(t, { FAKE_FAIL: 'yes' });
  const invalid = await f.run(['--cwd', f.cwd], 'missing task label');
  assert.equal(invalid.code, 1); assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /^Error: The first line of the prompt must start with #<id>\n$/);
  assert.deepEqual(await f.jobs(), []);
  const failure = await f.run(['--cwd', f.cwd]);
  assert.equal(failure.code, 1, failure.stderr); assert.equal(failure.stderr, '');
  assert.match(failure.stdout, /^fake failure\n\[fake\] #5 failed/);
  assert.doesNotMatch(failure.stdout, /Codex|codex/);
  const [job] = await f.jobs();
  assert.equal(job.status, 'failed'); assert.equal(job.error, 'fake failure');
  assert.deepEqual(await f.run(['wait', job.id]), failure);
});

test('collector reads jobs and legacy codex-jobs, prefers current copies and ignores malformed files', async t => {
  const f = await fixture(t);
  const legacy = { id: 'cx-legacy', cwd: f.cwd, taskId: '9', label: '#9 legacy job', model: 'old-model', status: 'completed',
    startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z', finalMessage: 'Legacy answer', tokens };
  await mkdir(join(f.home, 'codex-jobs'), { recursive: true });
  await writeFile(join(f.home, 'codex-jobs', 'cx-legacy.json'), JSON.stringify(legacy));
  let agents = f.collect();
  assert.equal(agents.length, 1); assert.equal(agents[0].executor, 'codex');
  const waited = await f.run(['wait', legacy.id], '', codexScript);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(waited.stdout, 'Legacy answer\n[codex] #9 done · 9 tokens · 0m1s · to memory: 0\n');
  await mkdir(join(f.home, 'jobs'));
  await writeFile(join(f.home, 'jobs', 'cx-legacy.json'), JSON.stringify({ ...legacy, provider: 'codex', finalMessage: 'Current answer', model: 'new-model' }));
  await writeFile(join(f.home, 'jobs', 'broken.json'), '{');
  await writeFile(join(f.home, 'jobs', 'unrelated.json'), JSON.stringify({ ...legacy, id: 'unrelated', cwd: f.root }));
  agents = f.collect();
  assert.equal(agents.length, 1); assert.equal(agents[0].model, 'new-model');
  const current = await f.run(['wait', legacy.id], '', codexScript);
  assert.equal(current.code, 0, current.stderr); assert.match(current.stdout, /^Current answer\n/);
  const wrongProvider = await f.run(['wait', legacy.id]);
  assert.equal(wrongProvider.code, 1); assert.match(wrongProvider.stderr, /Unknown Fake job/);
});
