import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const realServer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugins/orchestra/web/server.mjs');

const MOCK = {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  sessions: [{ sessionId: 'mock-1', project: { name: 'demo', cwd: '/tmp/demo', branch: null } }],
};

// Throw-away web/ tree: the real server.mjs, a temp mock file, no lib/ next to it.
function makeEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-server-test-'));
  const web = path.join(root, 'plugin', 'web');
  fs.mkdirSync(web, { recursive: true });
  const script = path.join(web, 'server.mjs');
  fs.copyFileSync(realServer, script);
  fs.writeFileSync(path.join(web, 'mock-snapshot.json'), JSON.stringify(MOCK, null, 2));
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>stub</title>');

  const home = path.join(root, 'home');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), ORCHESTRA_HOME: home };
  const pidFile = path.join(home, 'server.pid');

  const run = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });

  t.after(() => {
    // Safety net: never leave a server behind, even if an assertion failed.
    try {
      const [pid] = fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
      if (pid) process.kill(pid, 'SIGKILL');
    } catch {
      // nothing running
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, script, home, pidFile, env, run };
}

// Starts the server in the foreground on an OS-chosen port and resolves with its base URL.
function startForeground(t, e, ...args) {
  const child = spawn(process.execPath, [e.script, '--port', '0', ...args], { env: e.env });
  t.after(() => child.kill('SIGKILL'));
  return new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) resolve({ base: m[0], port: Number(m[1]), child });
    });
    child.once('exit', (code) => reject(new Error(`server exited early (${code}): ${buf}`)));
    setTimeout(() => reject(new Error('server did not start')), 5000).unref();
  });
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function firstSseData(base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${base}events`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      const m = buf.match(/^data: (.*)\n\n/m);
      if (m) return JSON.parse(m[1]);
    }
    throw new Error('SSE stream ended without data');
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

async function waitDown(base) {
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`${base}health`, { signal: AbortSignal.timeout(300) });
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('--mock: health, snapshot, static files, one SSE event, then --stop', async (t) => {
  const e = makeEnv(t);
  const { base, port } = await startForeground(t, e, '--mock');

  assert.deepEqual(await (await fetch(`${base}health`)).json(), { ok: true });
  assert.deepEqual(await (await fetch(`${base}api/snapshot`)).json(), MOCK);
  assert.deepEqual(await (await fetch(`${base}mock-snapshot.json`)).json(), MOCK);

  const index = await fetch(base);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(await index.text(), /<title>stub<\/title>/);

  assert.equal((await fetch(`${base}nope`)).status, 404);
  assert.equal((await fetch(`${base}api/snapshot`, { method: 'POST' })).status, 405);

  assert.deepEqual(await firstSseData(base), MOCK);

  // A foreign Host header (DNS rebinding) is refused.
  const status = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/health', headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(status, 403);

  assert.equal(fs.readFileSync(e.pidFile, 'utf8').trim().split(/\s+/)[1], String(port));
  const stop = e.run('--stop');
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /stopped/);
  assert.ok(await waitDown(base), 'server is down after --stop');
  assert.ok(!fs.existsSync(e.pidFile), 'pid file removed');
});

test('without lib/: server starts, /health works, /api/snapshot answers 503 with an error', async (t) => {
  const e = makeEnv(t);
  const { base } = await startForeground(t, e);

  assert.deepEqual(await (await fetch(`${base}health`)).json(), { ok: true });
  const res = await fetch(`${base}api/snapshot`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length > 0);
});

test('--ensure starts a detached server once, reuses it, --stop kills it', async (t) => {
  const e = makeEnv(t);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;

  const first = e.run('--ensure', '--mock', '--port', String(port));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), url);
  assert.deepEqual(await (await fetch(`${url}health`)).json(), { ok: true });
  assert.deepEqual(await (await fetch(`${url}api/snapshot`)).json(), MOCK);

  const pid = fs.readFileSync(e.pidFile, 'utf8');
  const second = e.run('--ensure', '--mock', '--port', String(port));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), url);
  assert.equal(fs.readFileSync(e.pidFile, 'utf8'), pid, 'no second server was started');
  assert.ok(fs.existsSync(path.join(e.home, 'server.log')));

  const stop = e.run('--stop');
  assert.equal(stop.status, 0, stop.stderr);
  assert.ok(await waitDown(url));
  assert.match(e.run('--stop').stdout, /not running/);
});
