import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { applyCodexEvent } from '../plugins/orchestra/scripts/codex-task.mjs';

const runner = fileURLToPath(new URL('../plugins/orchestra/scripts/codex-task.mjs', import.meta.url));
const kbModule = new URL('../plugins/orchestra/lib/kb.mjs', import.meta.url).href;
const fakeCodex = `#!/usr/bin/env node
const fs = require('node:fs');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', async () => {
  fs.writeFileSync(process.env.FAKE_PROMPT, prompt);
  fs.writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
  const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
  emit({ type: 'thread.started', thread_id: 'round-three-thread' });
  emit({ type: 'turn.started' });
  emit({ type: 'item.started', item: { type: 'command_execution', command: '/bin/zsh -lc ls' } });
  if (process.env.FAKE_GATE === 'yes') {
    while (!fs.existsSync(process.env.FAKE_FINISH)) await new Promise(done => setTimeout(done, 20));
  }
  if (process.env.FAKE_FAIL === 'yes') {
    emit({ type: 'turn.failed', error: { message: 'model not supported' } });
    process.exitCode = 1;
  } else {
    emit({ type: 'item.completed', item: { type: 'agent_message', text: process.env.FAKE_RESULT || 'Answer ready.' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 } });
  }
});
`;

async function until(check, message, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error(`Timed out: ${message}`);
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orchestra-codex2-'));
  const cwd = join(root, 'project'), home = join(root, 'home'), bin = join(root, 'bin');
  await mkdir(cwd); await mkdir(bin);
  await writeFile(join(bin, 'codex'), fakeCodex, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORCHESTRA_HOME: home,
    CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
    FAKE_PROMPT: join(root, 'prompt'), FAKE_ARGS: join(root, 'args'), FAKE_FINISH: join(root, 'finish'), ...overrides };
  const children = new Set();
  async function jobs() {
    const names = await readdir(join(home, 'jobs')).catch(() => []);
    return Promise.all(names.filter(name => name.endsWith('.json')).map(async name =>
      JSON.parse(await readFile(join(home, 'jobs', name), 'utf8'))));
  }
  t.after(async () => {
    await writeFile(env.FAKE_FINISH, 'finish');
    for (const child of children) child.kill('SIGTERM');
    await until(async () => (await jobs()).every(job => job.status !== 'running'), 'background runner cleanup').catch(async () => {
      for (const job of await jobs()) { try { process.kill(job.pid, 'SIGTERM'); } catch { /* already exited */ } }
    });
    await rm(root, { recursive: true, force: true });
  });
  function run(args, prompt, extraEnv = {}) {
    const child = spawn(process.execPath, [runner, ...args], { env: { ...env, ...extraEnv } });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.stdin.on('error', () => {});
    child.stdin.end(prompt || '');
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Runner did not exit')); }, 15000);
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer); children.delete(child); accept({ code, stdout, stderr });
      });
    });
  }
  function memory(action, notes = []) {
    const code = `import { openKb } from ${JSON.stringify(kbModule)};
      import { readFileSync } from 'node:fs';
      const kb = openKb(process.argv[1], {readOnly: process.argv[2] === 'list'});
      try {
        if (process.argv[2] === 'seed') for (const note of JSON.parse(readFileSync(0, 'utf8'))) kb.add(note);
        console.log(JSON.stringify(kb?.list({recent: 100}) || []));
      } finally { kb?.close(); }`;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, cwd, action],
      { input: JSON.stringify(notes), encoding: 'utf8', env }));
  }
  return { root, cwd, home, env, run, jobs, memory,
    prompt: () => readFile(env.FAKE_PROMPT, 'utf8'), finish: () => writeFile(env.FAKE_FINISH, 'finish') };
}

test('unquoted single shell word is still stripped', () => {
  const job = { tokens: {} };
  applyCodexEvent(job, { type: 'item.started', item: { type: 'command_execution', command: '/bin/zsh -lc ls' } });
  assert.equal(job.activity, 'Bash ls');
});

test('detach exits while runner stays alive; wait times out repeatedly then returns persisted final output', { timeout: 20000 }, async t => {
  const f = await fixture(t, { FAKE_GATE: 'yes', FAKE_RESULT: 'Done.\n## Findings\n- [fact] Background result | | Useful fact' });
  const start = performance.now();
  const detached = await f.run(['--cwd', f.cwd, '--detach', '--write', '--model', 'fake-model', '--effort', 'high'], '#C child task');
  assert.equal(detached.code, 0, detached.stderr);
  assert.equal(detached.stderr, '');
  assert.match(detached.stdout, /^cx-[a-z0-9]+-[a-z0-9]{4}\n$/);
  assert.ok(performance.now() - start < 3000, 'must return before gated Codex finishes');
  const id = detached.stdout.trim();
  const running = (await f.jobs())[0];
  assert.equal(running.id, id); assert.equal(running.status, 'running');
  assert.ok(running.pid > 0); assert.doesNotThrow(() => process.kill(running.pid, 0));
  assert.equal(running.model, 'fake-model'); assert.equal(running.write, true); assert.equal(running.effort, 'high');
  for (const timeout of ['0.05', '0']) {
    const pending = await f.run(['wait', id, '--timeout', timeout]);
    assert.equal(pending.code, 3, pending.stderr); assert.match(pending.stdout, /still running; call wait again/);
  }
  await until(() => f.prompt().catch(() => null), 'background Codex started');
  await f.finish();
  const result = await f.run(['wait', id, '--timeout', '5']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Done\.\n## Findings/);
  assert.match(result.stdout, /\[codex\] #C done · 60 tokens · \d+m\d+s · to memory: 1\n$/);
  const again = await f.run(['wait', id]);
  assert.deepEqual(again, result, 'repeated waits reproduce output and never ingest notes again');
  const [final] = await f.jobs();
  assert.equal(final.status, 'completed'); assert.equal(final.memoryCount, 1);
  assert.equal(final.finalMessage, f.env.FAKE_RESULT);
  assert.equal(f.memory('list').length, 1);
});

test('wait matches foreground output including failure hint and footer', async t => {
  for (const fail of [false, true]) {
    const f = await fixture(t, fail ? { FAKE_FAIL: 'yes' } : {});
    const foreground = await f.run(['--cwd', f.cwd], '#2 result');
    assert.equal(foreground.code, fail ? 1 : 0, foreground.stderr);
    const [job] = await f.jobs();
    const waited = await f.run(['wait', job.id, '--timeout', '0']);
    assert.deepEqual(waited, foreground);
    if (fail) assert.match(waited.stdout, /model not supported\nupdate the Codex CLI: codex update\n\[codex\] #2 failed/);
  }
});

test('detached failures persist and wait exits 1; startup failures do not return a phantom id', async t => {
  const f = await fixture(t, { FAKE_FAIL: 'yes' });
  const started = await f.run(['--cwd', f.cwd, '--detach'], '#3 crash');
  assert.equal(started.code, 0, started.stderr);
  const result = await f.run(['wait', started.stdout.trim(), '--timeout', '5']);
  assert.equal(result.code, 1); assert.match(result.stdout, /#3 failed.*to memory: 0/);
  const invalid = await f.run(['--cwd', join(f.root, 'unused'), '--resume-last', '--detach'], '#4 no session');
  assert.equal(invalid.code, 1); assert.equal(invalid.stdout, ''); assert.match(invalid.stderr, /No previous Codex session/);
});

test('unknown jobs and invalid wait arguments produce English errors without creating files', async t => {
  const f = await fixture(t);
  for (const args of [['wait', 'cx-unknown'], ['wait', '../outside'], ['wait'],
    ['wait', 'cx-unknown', '--timeout', '-1'], ['wait', 'cx-unknown', '--timeout', 'NaN'],
    ['wait', 'cx-unknown', '--timeout'], ['wait', 'cx-unknown', '--other', '1']]) {
    const result = await f.run(args);
    assert.equal(result.code, 1); assert.match(result.stderr, /^Error: \S/); assert.doesNotMatch(result.stderr, /\p{Script=Cyrillic}/u);
  }
  assert.deepEqual(await f.jobs(), []);
});

test('missing, empty and nonmatching memory add no prefix and pure reads never create memory', async t => {
  const f = await fixture(t);
  const run = () => f.run(['--cwd', f.cwd], '#5 uniquetask\nDo the work.');
  assert.equal((await run()).code, 0);
  assert.doesNotMatch(await f.prompt(), /## Project memory/);
  assert.equal(await readdir(join(f.home, 'kb')).catch(error => error.code), 'ENOENT');
  f.memory('seed');
  assert.equal((await run()).code, 0);
  assert.doesNotMatch(await f.prompt(), /## Project memory/);
  f.memory('seed', [{ kind: 'file', title: 'mismatchedtitle', body: 'unrelatedword' }]);
  assert.equal((await run()).code, 0);
  const prompt = await f.prompt();
  assert.ok(prompt.startsWith('#5 uniquetask\nDo the work.'));
  assert.doesNotMatch(prompt, /## Project memory/);
  assert.match(prompt, /## Findings/); assert.match(prompt, /0 to 5 lines/);
});

test('memory includes context and only top five title search hits, compact, and counts delivered notes', async t => {
  const f = await fixture(t);
  f.memory('seed', [{ kind: 'context', title: 'About the project', body: 'Project context', author: 'opus' },
    ...Array.from({ length: 6 }, (_, i) => ({ kind: 'file', title: `targettask ${i}`, body: 'é'.repeat(500), author: 'sonnet #1' })),
    { kind: 'file', title: 'otherfile', body: 'secretonlyinbody' }]);
  const result = await f.run(['--cwd', f.cwd], '#6 targettask\nsecretonlyinbody');
  assert.equal(result.code, 0, result.stderr);
  const prompt = await f.prompt(), prefix = prompt.split('\n\n#6')[0];
  assert.ok(prompt.startsWith('## Project memory\n'));
  assert.match(prefix, /\[1\] context · About the project · opus · just now ✓\n     Project context/);
  assert.equal((prefix.match(/file · targettask/g) || []).length, 5);
  assert.doesNotMatch(prefix, /otherfile/);
  assert.equal((prefix.match(/é{299}…/g) || []).length, 5, 'bodies use CLI 300-character truncation');
  assert.ok(f.memory('list').some(note => note.hits > 0), 'notes handed to Codex count as used');
});

test('memory prefix is deduplicated and capped at approximately 1500 tokens', async t => {
  const f = await fixture(t);
  f.memory('seed', Array.from({ length: 8 }, (_, i) => ({ kind: 'context', title: `limit ${i} ${'é'.repeat(1000)}`, body: 'é'.repeat(2000) })));
  const result = await f.run(['--cwd', f.cwd], '#7 limit');
  assert.equal(result.code, 0, result.stderr);
  const prefix = (await f.prompt()).split('\n\n#7')[0];
  assert.ok(Buffer.byteLength(prefix) <= 6000);
  assert.ok(prefix.length > 1000);
  const ids = [...prefix.matchAll(/^\[(\d+)\]/gm)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('findings normalize repo-root paths from a nested cwd and skip malformed records/other sections', async t => {
  const f = await fixture(t);
  execFileSync('git', ['init', '-q', f.cwd]);
  await mkdir(join(f.cwd, 'src'));
  await writeFile(join(f.cwd, 'src/a.mjs'), 'a'); await writeFile(join(f.cwd, 'src/b.mjs'), 'b');
  const answer = ['Done.', '- [fact] Outside section | | do not add', '## Findings',
    `- [file] Shared module | ./src/a.mjs,${join(f.cwd, 'src/b.mjs')} | Use the existing module.`,
    '- [decision] Decision | | Keep the contract.',
    '- [bad] Bad kind | | text', '- [fact] | | no title', '- [fact] No text | | ',
    '- [fact] Escape | ../outside | text', '- [fact] Empty path | src/a.mjs, | text',
    `- [fact] Long | | ${'é'.repeat(2001)}`, 'malformed line',
    '## Next', '- [fact] Other section | | do not add'].join('\n');
  const result = await f.run(['--cwd', join(f.cwd, 'src')], '#8 findings', { FAKE_RESULT: answer });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /to memory: 2\n$/);
  const notes = f.memory('list');
  assert.equal(notes.length, 2);
  assert.ok(notes.every(note => note.author === 'codex #8' && note.taskId === '8'));
  const file = notes.find(note => note.kind === 'file');
  assert.deepEqual(file.paths, ['src/a.mjs', 'src/b.mjs']); assert.equal(file.stale, false);
  assert.equal(file.body, 'Use the existing module.');
  assert.deepEqual(notes.find(note => note.kind === 'decision').paths, []);
});

test('all seven note kinds are accepted and ingestion is bounded to five findings per run', async t => {
  const f = await fixture(t);
  const kinds = ['context', 'file', 'symbol', 'fact', 'command', 'gotcha', 'decision'];
  for (const group of [kinds.slice(0, 4), kinds.slice(4)]) {
    const result = await f.run(['--cwd', f.cwd], '#9 kinds', { FAKE_RESULT: '## Findings\n' + group.map(kind => `- [${kind}] ${kind} | | useful text`).join('\n') });
    assert.equal(result.code, 0); assert.match(result.stdout, new RegExp(`to memory: ${group.length}\\n$`));
  }
  assert.equal(f.memory('list').length, 7);
  const result = await f.run(['--cwd', f.cwd], '#9 limit', { FAKE_RESULT: '## Findings\n' + Array.from({ length: 8 }, (_, i) => `- [fact] New fact ${i} | | text`).join('\n') });
  assert.equal(result.code, 0); assert.match(result.stdout, /to memory: 5\n$/);
  assert.equal(f.memory('list').length, 12);
});

test('findings parser accepts the legacy Russian heading and heading variants', async t => {
  const f = await fixture(t);
  for (const [index, heading] of ['## Находки', '**Findings:**', 'Findings:', '## Findings'].entries()) {
    const result = await f.run(['--cwd', f.cwd], '#11 headings', { FAKE_RESULT: `Done\n${heading}\n- [fact] Variant ${index} | | text` });
    assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /to memory: 1\n$/);
  }
  assert.equal(f.memory('list').length, 4);
});

test('unavailable memory never fails a successful job or a subsequent wait', async t => {
  const f = await fixture(t);
  await mkdir(f.home);
  await writeFile(join(f.home, 'kb'), 'not a directory');
  const result = await f.run(['--cwd', f.cwd], '#10 memory errors', { FAKE_RESULT: 'Done\n## Findings\n- [fact] Fact | | text' });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  assert.match(result.stdout, /#10 done.*to memory: 0/);
  assert.doesNotMatch(await f.prompt(), /## Project memory/);
  const [job] = await f.jobs();
  assert.deepEqual(await f.run(['wait', job.id]), result);
});
