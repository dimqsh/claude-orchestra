import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const limitsUrl = new URL('../plugins/orchestra/lib/limits.mjs', import.meta.url).href;
const hud = new URL('../plugins/orchestra/hud/statusline.mjs', import.meta.url);
const fixture = name => readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const empty = { claude: null, codex: null, gemini: null, kimi: null };

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'orchestra-limits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, ORCHESTRA_HOME: join(root, 'home'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), ORCHESTRA_CHAIN_ACTIVE: '' };
  const path = join(env.ORCHESTRA_HOME, 'limits.json');
  const rollout = name => join(env.CODEX_HOME, 'sessions', name);
  async function put(path, text) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  function run(code) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import * as limits from ${JSON.stringify(limitsUrl)};\n${code}`], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    return JSON.parse(child.stdout);
  }
  function statusline(input, script = hud) {
    return spawnSync(process.execPath, [script instanceof URL ? script.pathname : script],
      { env, input: JSON.stringify({ cwd: root, ...input }), encoding: 'utf8', timeout: 10000 });
  }
  return { root, env, path, rollout, put, run, statusline };
}

test('codex limits come from the newest rollout token_count', async t => {
  const f = await sandbox(t);
  const older = f.rollout('2026/10/28/rollout-old.jsonl');
  const newest = f.rollout('2026/10/29/rollout-new.jsonl');
  await f.put(older, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count',
    rate_limits: { primary: { used_percent: 99, window_minutes: 300 } } } }));
  await utimes(older, new Date(0), new Date(0));
  await f.put(newest, await fixture('rollout-limits.jsonl'));
  await f.put(f.rollout('2026/10/29/not-a-rollout.jsonl'), '{}');
  assert.deepEqual(f.run('console.log(JSON.stringify(await limits.readLimits()));'), {
    ...empty, codex: [{ name: 'week', usedPercent: 8, resetsAt: '2026-10-31T00:00:00.000Z' }]
  });
});

test('claude limits are recorded from statusline stdin and throttled', async t => {
  const f = await sandbox(t);
  const input = JSON.parse(await fixture('statusline-stdin-limits.json'));
  f.run(`await limits.recordClaudeLimits(${JSON.stringify(input.rate_limits)}); console.log('null');`);
  const first = await readFile(f.path, 'utf8'), info = await stat(f.path);
  assert.deepEqual(JSON.parse(first).claude, input.rate_limits);
  // A fresh process one second later must honor the persisted timestamp.
  f.run(`const now = Date.now(); Date.now = () => now + 1000;
    await limits.recordClaudeLimits({ five_hour: { used_percent: 99 } }); console.log('null');`);
  assert.equal(await readFile(f.path, 'utf8'), first);
  assert.equal((await stat(f.path)).mtimeMs, info.mtimeMs);
  assert.deepEqual(f.run('console.log(JSON.stringify(await limits.readLimits()));'), {
    ...empty, claude: [
      { name: '5h', usedPercent: 12, resetsAt: '2026-10-31T00:00:00.000Z' },
      { name: '7d', usedPercent: 34, resetsAt: '2026-11-05T00:00:00.000Z' }
    ]
  });
  const recordedAt = Date.parse(JSON.parse(first).recordedAt);
  assert.ok(Number.isFinite(recordedAt));
  f.run(`Date.now = () => ${recordedAt} + 60000;
    await limits.recordClaudeLimits({ five_hour: { used_percent: 0 } }); console.log('null');`);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).claude, { five_hour: { used_percent: 0 } });
});

test('missing data gives null, not an error', async t => {
  const f = await sandbox(t);
  assert.deepEqual(f.run('console.log(JSON.stringify(await limits.readLimits()));'), empty);
  await f.put(f.path, '{invalid JSON');
  await f.put(f.rollout('2026/10/29/rollout-empty.jsonl'), 'invalid JSON\n{}\n');
  assert.deepEqual(f.run('console.log(JSON.stringify(await limits.readLimits()));'), empty);
  f.run(`await limits.recordClaudeLimits(undefined); await limits.recordClaudeLimits(null); console.log('null');`);
  assert.equal(await readFile(f.path, 'utf8'), '{invalid JSON');
});

test('concurrent Claude recordings share the sixty-second throttle', async t => {
  const f = await sandbox(t);
  const out = f.run(`import { readFile } from 'node:fs/promises';
    await Promise.all(Array.from({ length: 12 }, (_, used_percent) =>
      limits.recordClaudeLimits({ five_hour: { used_percent } })));
    const before = await readFile(${JSON.stringify(f.path)}, 'utf8');
    await limits.recordClaudeLimits({ five_hour: { used_percent: 99 } });
    console.log(JSON.stringify({ before, after: await readFile(${JSON.stringify(f.path)}, 'utf8') }));`);
  assert.equal(out.before, out.after);
  assert.ok(JSON.parse(out.before).claude.five_hour.used_percent < 12);
});

test('Claude aliases, invalid windows, and optional reset times are tolerated', async t => {
  const f = await sandbox(t);
  for (const [key, value] of [['used_percentage', 0], ['used_percent', 23], ['utilization', 45]]) {
    await f.put(f.path, JSON.stringify({ claude: {
      five_hour: { [key]: value, resets_at: 'invalid' }, seven_day: { [key]: 50 }, unknown: { [key]: 99 }
    } }));
    assert.deepEqual(f.run('console.log(JSON.stringify((await limits.readLimits()).claude));'), [
      { name: '5h', usedPercent: value, resetsAt: null }, { name: '7d', usedPercent: 50, resetsAt: null }
    ]);
  }
  await f.put(f.path, JSON.stringify({ claude: { five_hour: { used_percent: null }, seven_day: { utilization: '50' } } }));
  assert.deepEqual(f.run('console.log(JSON.stringify(await limits.readLimits()));'), empty);
});

test('Codex secondary windows are mapped and malformed trailing lines are ignored', async t => {
  const f = await sandbox(t);
  await f.put(f.rollout('2026/10/29/rollout-secondary.jsonl'), [
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {
      primary: { used_percent: 0, window_minutes: 300, resets_at: 1793404800 },
      secondary: { used_percent: 80, window_minutes: 10080 }
    } } }), '{truncated'
  ].join('\n'));
  assert.deepEqual(f.run('console.log(JSON.stringify((await limits.readLimits()).codex));'), [
    { name: '5h', usedPercent: 0, resetsAt: '2026-10-31T00:00:00.000Z' },
    { name: 'week', usedPercent: 80, resetsAt: null }
  ]);
});

test('unknown Codex windows stay null rather than reviving an older event', async t => {
  const f = await sandbox(t);
  await f.put(f.rollout('2026/10/29/rollout-unknown.jsonl'), [await fixture('rollout-limits.jsonl'),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {
      primary: { used_percent: 90, window_minutes: 'toString' },
      secondary: { used_percent: 50, window_minutes: 60 }
    } } })
  ].join('\n'));
  assert.deepEqual(f.run('console.log(JSON.stringify(await limits.readLimits()));'), empty);
});

test('maxUsedPercent returns the highest known window or null', async t => {
  const f = await sandbox(t);
  assert.deepEqual(f.run(`const data = { claude: [{ usedPercent: 0 }, { usedPercent: 72 }], codex: [{ usedPercent: 0 }], gemini: null };
    console.log(JSON.stringify([limits.maxUsedPercent(data, 'claude'), limits.maxUsedPercent(data, 'codex'),
      limits.maxUsedPercent(data, 'gemini'), limits.maxUsedPercent(data, 'kimi'), limits.maxUsedPercent({ claude: [] }, 'claude')]));`),
  [72, 0, null, null, null]);
});

test('statusline records Claude limits without adding output', async t => {
  const f = await sandbox(t), input = JSON.parse(await fixture('statusline-stdin-limits.json'));
  const child = f.statusline(input);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.match(child.stdout, /◆/);
  assert.equal(child.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).claude, input.rate_limits);
});

test('statusline still prints when limits.json is not writable', async t => {
  const f = await sandbox(t);
  // A directory at the target makes atomic rename fail even for privileged test runners.
  await mkdir(f.path, { recursive: true });
  const child = f.statusline(JSON.parse(await fixture('statusline-stdin-limits.json')));
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.match(child.stdout, /◆/);
  assert.equal(child.stdout.trim().split('\n').length, 1);
});

test('statusline renders before the optional limits recorder finishes', async t => {
  const f = await sandbox(t), runtime = join(f.root, 'runtime');
  await cp(new URL('../plugins/orchestra/lib/', import.meta.url), join(runtime, 'lib'), { recursive: true });
  await mkdir(join(runtime, 'hud'));
  await cp(hud, join(runtime, 'hud/statusline.mjs'));
  // If the HUD awaits the recorder, this sentinel precedes the header.
  await writeFile(join(runtime, 'lib/limits.mjs'), `export async function recordClaudeLimits() {
    await new Promise(resolve => setTimeout(resolve, 400)); console.log('recorder finished');
  }`);
  const child = f.statusline({ rate_limits: { five_hour: { used_percentage: 12 } } }, join(runtime, 'hud/statusline.mjs'));
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.match(child.stdout.trim().split('\n')[0], /◆/);
  assert.match(child.stdout, /recorder finished/);
});
