import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, chmod, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { applyCodexEvent } from '../plugins/orchestra/scripts/codex-task.mjs';

const zero = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, spent: 0 });
function activity(command) {
  const job = { tokens: zero() };
  applyCodexEvent(job, { type: 'item.started', item: { type: 'command_execution', command } });
  return job.activity;
}
for (const shell of ['/bin/zsh', '/bin/bash', 'sh', 'zsh', 'bash']) {
  for (const flag of ['-c', '-lc']) {
    for (const quote of ["'", '"']) {
      test(`command activity unwraps ${shell} ${flag} with ${quote === "'" ? 'single' : 'double'} quotes`, () => {
        assert.equal(activity(`${shell} ${flag} ${quote}python3 -m pytest -q tests${quote}`), 'Bash python3 -m pytest -q tests');
      });
    }
  }
}
test('command activity decodes escaped single quotes and double-quote escapes', () => {
  assert.equal(activity(String.raw`/bin/zsh -lc 'printf '\''hello world'\'''`), "Bash printf 'hello world'");
  assert.equal(activity(String.raw`bash -lc "printf \"hello world\""`), 'Bash printf "hello world"');
  assert.equal(activity(String.raw`sh -c 'printf C:\\temp'`), String.raw`Bash printf C:\\temp`);
});
test('command activity collapses whitespace before truncating the inner command to 40 chars', () => {
  const command = `  python3\n\t-m   pytest -q tests/${'x'.repeat(80)}  `;
  assert.equal(activity(`bash -lc '${command}'`), `Bash ${command.replace(/\s+/g, ' ').trim().slice(0, 40)}`);
  assert.equal(activity(' \tpython3\n  -m   pytest  '), 'Bash python3 -m pytest');
});
test('command activity preserves other commands, malformed quotes and extra shell arguments', () => {
  for (const command of ["fish -c 'ls -a'", "env bash -c 'ls -a'", "bash -c 'echo hi' extra", "bash -c 'ls';pwd", "bash -c 'unterminated", 'python3 -m pytest -q']) {
    assert.equal(activity(command), `Bash ${command.replace(/\s+/g, ' ').trim().slice(0, 40)}`);
  }
});

async function until(check, description, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
for (const location of ['today', 'yesterday', 'archive']) {
  const resume = location !== 'today';
  test(`live rollout tokens ${resume ? `subtract the ${location} thread baseline on resume` : 'grow before completion'} and finish with authoritative usage`, { timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'orchestra-live-tokens-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, 'workspace'), home = join(root, 'home'), codexHome = join(root, 'codex'), bin = join(root, 'bin'), control = join(root, 'control');
    for (const dir of [cwd, home, bin, control]) await mkdir(dir);
    const executable = join(bin, 'codex');
    await cp(new URL('fixtures/codex-live.mjs', import.meta.url), executable); await chmod(executable, 0o755);
    // An old resumed thread exercises bounded recursive discovery, beyond today/yesterday.
    const date = location === 'archive' ? new Date(2020, 0, 2) : new Date();
    if (location === 'yesterday') date.setDate(date.getDate() - 1);
    const rollout = join(codexHome, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'), 'rollout-test-live-token-thread.jsonl');
    const baseline = resume ? { input_tokens: 10000, cached_input_tokens: 7000, output_tokens: 2000 } : { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
    if (resume) {
      await mkdir(join(home, 'codex-jobs'), { recursive: true });
      await writeFile(join(home, 'codex-jobs/previous.json'), JSON.stringify({ id: 'previous', cwd, threadId: 'live-token-thread', startedAt: '2020-01-02T00:00:00Z', status: 'completed' }));
      await mkdir(dirname(rollout), { recursive: true });
      await writeFile(rollout, [
        { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: baseline } } },
        { type: 'event_msg', payload: { type: 'token_count', info: null } },
      ].map(JSON.stringify).join('\n') + '\n');
    }
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORCHESTRA_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: codexHome,
      FAKE_ROLLOUT: rollout, FAKE_CONTROL: control, FAKE_BASELINE: JSON.stringify(baseline) };
    const args = [fileURLToPath(new URL('../plugins/orchestra/scripts/codex-task.mjs', import.meta.url)), '--cwd', cwd];
    if (resume) args.push('--resume-last');
    const child = spawn(process.execPath, args, { env });
    t.after(() => child.kill('SIGTERM'));
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.on('close', code => resolve(code)));
    child.stdin.end('#9 live tokens');
    let jobPath;
    const writes = [];
    async function current() {
      if (!jobPath) {
        for (const file of await readdir(join(home, 'codex-jobs')).catch(() => [])) {
          if (file.startsWith('cx-') && file.endsWith('.json')) { jobPath = join(home, 'codex-jobs', file); break; }
        }
      }
      if (!jobPath) return null;
      const job = JSON.parse(await readFile(jobPath, 'utf8'));
      const encoded = JSON.stringify(job);
      if (writes.at(-1)?.encoded !== encoded) writes.push({ encoded, job, mtime: (await stat(jobPath)).mtimeMs });
      return job;
    }
    const first = await until(async () => { const job = await current(); return job?.status === 'running' && job.tokens.spent > 0 && job; }, 'non-zero running tokens');
    assert.deepEqual(first.tokens, { input: 40, cacheWrite: 0, cacheRead: 60, output: 10, spent: 50 });
    await writeFile(join(control, 'advance'), 'go');
    const second = await until(async () => { const job = await current(); return job?.tokens.spent >= 120 && job; }, 'partial rollout line to finish');
    assert.equal(second.status, 'running');
    assert.deepEqual(second.tokens, { input: 100, cacheWrite: 0, cacheRead: 100, output: 20, spent: 120 });
    await writeFile(join(control, 'regress'), 'go');
    await until(() => stat(join(control, 'regressed')).catch(() => null), 'regressing rollout counter');
    // Cover a stale/lower counter without letting it decrease a published value.
    if (!resume) { await new Promise(resolve => setTimeout(resolve, 2200)); assert.equal((await current()).tokens.spent, 120); }
    await writeFile(join(control, 'finish'), 'go');
    assert.equal(await exited, 0, stderr);
    const final = await current();
    assert.equal(final.status, 'completed');
    assert.deepEqual(final.tokens, { input: 190, cacheWrite: 0, cacheRead: 160, output: 40, spent: 230 });
    assert.match(stdout, /\[codex\] #9 done · 230 tokens/);
    for (let i = 1; i < writes.length; i++) {
      for (const key of Object.keys(zero())) assert(writes[i].job.tokens[key] >= writes[i - 1].job.tokens[key], `${key} must not decrease`);
      if (writes[i].job.status === 'running') assert(writes[i].mtime - writes[i - 1].mtime >= 950, 'running writes remain throttled');
    }
  });
}
