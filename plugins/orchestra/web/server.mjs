#!/usr/bin/env node
// Local web server for the orchestra agent graph.
//
//   node server.mjs [--port 7377] [--since 30] [--ensure] [--stop] [--mock]
//
// Binds 127.0.0.1 only. Endpoints: / (index.html), /mock-snapshot.json, /api/snapshot,
// /events (SSE), /health. --ensure starts a detached instance unless one already answers.
// --mock serves web/mock-snapshot.json instead of live data.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const INDEX_FILE = path.join(HERE, 'index.html');
const MOCK_FILE = path.join(HERE, 'mock-snapshot.json');

const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const orchestraHome = process.env.ORCHESTRA_HOME || path.join(claudeConfigDir, 'orchestra');
const PID_FILE = path.join(orchestraHome, 'server.pid');
const LOG_FILE = path.join(orchestraHome, 'server.log');

const DEFAULT_PORT = 7377;
const TICK_MS = 1000;
const PING_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const urlFor = (port) => `http://127.0.0.1:${port}/`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, since: 30, ensure: false, stop: false, mock: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice(7));
    else if (arg === '--since') opts.since = Number(argv[++i]);
    else if (arg === '--ensure') opts.ensure = true;
    else if (arg === '--stop') opts.stop = true;
    else if (arg === '--mock') opts.mock = true;
    else fail(`Unknown argument: ${arg}\nUsage: server.mjs [--port 7377] [--since 30] [--ensure] [--stop] [--mock]`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) fail('Invalid port (expected a number from 0 to 65535).');
  if (!(opts.since > 0)) fail('Invalid activity window (--since takes minutes, greater than 0).');
  return opts;
}

async function isHealthy(port, timeoutMs = 500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return (await res.json())?.ok === true;
  } catch {
    return false;
  }
}

// ---------- --ensure / --stop ----------

async function ensure({ port, since, mock }) {
  if (await isHealthy(port)) {
    console.log(urlFor(port));
    return;
  }
  fs.mkdirSync(orchestraHome, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, 'a');
  const args = [SELF, '--port', String(port), '--since', String(since), ...(mock ? ['--mock'] : [])];
  spawn(process.execPath, args, { detached: true, stdio: ['ignore', logFd, logFd] }).unref();
  fs.closeSync(logFd);

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await isHealthy(port, 300)) {
      console.log(urlFor(port));
      return;
    }
    await sleep(100);
  }
  fail(`Server did not respond within 3 s. Log: ${LOG_FILE}`);
}

async function stop() {
  let pid;
  let port;
  try {
    [pid, port] = fs.readFileSync(PID_FILE, 'utf8').trim().split(/\s+/).map(Number);
  } catch {
    console.log('Server is not running.');
    return;
  }
  // The pid file is only trusted while the server answers on the recorded port,
  // so a stale pid that the OS has reused is never signalled.
  if (!Number.isInteger(pid) || !port || !(await isHealthy(port))) {
    fs.rmSync(PID_FILE, { force: true });
    console.log('Server is not running (stale pid file removed).');
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') fail(`Could not stop the server (pid ${pid}): ${err.message}`);
  }
  for (let i = 0; i < 20 && (await isHealthy(port, 200)); i++) await sleep(100);
  fs.rmSync(PID_FILE, { force: true });
  console.log(`Server stopped (pid ${pid}).`);
}

// ---------- server ----------

let collectModule = null;
async function loadCollect() {
  collectModule ??= await import('../lib/collect.mjs');
  return collectModule;
}

async function startServer({ port, mock }) {
  const clients = new Set();
  let ticker = null;
  let busy = false;
  let last = null; // { key, json } of the snapshot last broadcast
  let actualPort = port;

  async function getSnapshot() {
    if (mock) return JSON.parse(await fs.promises.readFile(MOCK_FILE, 'utf8'));
    const { collectActive } = await loadCollect();
    return collectActive({ sinceMinutes: opts.since });
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function sendFile(res, file, type) {
    let data;
    try {
      data = await fs.promises.readFile(file);
    } catch {
      return sendJson(res, 404, { error: `${path.basename(file)} not found` });
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  }

  async function tick() {
    if (busy || clients.size === 0) return;
    busy = true;
    try {
      const snapshot = await getSnapshot();
      // generatedAt changes on every call, so it must not count as a change.
      const key = JSON.stringify(snapshot, (k, v) => (k === 'generatedAt' ? undefined : v));
      if (key !== last?.key) {
        last = { key, json: JSON.stringify(snapshot) };
        for (const client of clients) client.res.write(`data: ${last.json}\n\n`);
      }
    } catch (err) {
      const line = String(err.message).replace(/\s+/g, ' ');
      for (const client of clients) client.res.write(`: error ${line}\n\n`);
    } finally {
      busy = false;
    }
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const client = { res, ping: setInterval(() => res.write(': ping\n\n'), PING_MS) };
    clients.add(client);
    if (last) res.write(`data: ${last.json}\n\n`);
    if (!ticker) ticker = setInterval(tick, TICK_MS);
    tick();

    req.on('close', () => {
      clearInterval(client.ping);
      clients.delete(client);
      if (clients.size === 0) {
        clearInterval(ticker);
        ticker = null;
        last = null;
      }
    });
  }

  async function handle(req, res) {
    const host = (req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) {
      return sendJson(res, 403, { error: 'forbidden host' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });

    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    switch (pathname) {
      case '/':
      case '/index.html':
        return sendFile(res, INDEX_FILE, 'text/html; charset=utf-8');
      case '/mock-snapshot.json':
        return sendFile(res, MOCK_FILE, 'application/json; charset=utf-8');
      case '/health':
        return sendJson(res, 200, { ok: true });
      case '/events':
        return handleEvents(req, res);
      case '/api/snapshot':
        try {
          return sendJson(res, 200, await getSnapshot());
        } catch (err) {
          // lib/ missing (or not importable) means the live data source is unavailable.
          const unavailable = err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'ENOENT';
          return sendJson(res, unavailable ? 503 : 500, { error: err.message });
        }
      default:
        return sendJson(res, 404, { error: 'not found' });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) res.end();
      else sendJson(res, 500, { error: err.message });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  actualPort = server.address().port;

  fs.mkdirSync(orchestraHome, { recursive: true });
  fs.writeFileSync(PID_FILE, `${process.pid}\n${actualPort}\n`);

  const shutdown = () => {
    try {
      const [pid] = fs.readFileSync(PID_FILE, 'utf8').trim().split(/\s+/).map(Number);
      if (pid === process.pid) fs.rmSync(PID_FILE, { force: true });
    } catch {
      // pid file already gone
    }
    server.closeAllConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`Server: ${urlFor(actualPort)}${mock ? ' (mock)' : ''}`);
}

// ---------- main ----------

const opts = parseArgs(process.argv.slice(2));
if (opts.stop) await stop();
else if (opts.ensure) await ensure(opts);
else {
  try {
    await startServer(opts);
  } catch (err) {
    fail(err.code === 'EADDRINUSE' ? `Port ${opts.port} is in use.` : `Could not start the server: ${err.message}`);
  }
}
