#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { collectSession } from '../lib/collect.mjs';
import { orchestraConfig } from '../lib/paths.mjs';
import { renderHeader, renderRows, renderSummary, cleanText } from '../lib/render.mjs';

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
async function chain(command, input) {
  return new Promise(resolve => {
    let output = '', settled = false, child;
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(output.trim()); } };
    const timer = setTimeout(() => { child?.kill('SIGKILL'); finish(); }, 700);
    try {
      child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdin.on('error', () => {});
      child.stdout.on('data', data => { if (output.length < 65536) output += data.toString(); });
      child.on('error', finish); child.on('close', finish); child.stdin.end(input);
    } catch { finish(); }
  });
}
let input = '', data = {};
try {
  for await (const chunk of process.stdin) input += chunk;
  data = JSON.parse(input);
  if (data?.rate_limits) {
    // Optional recording must never hold up rendering or make the HUD fail.
    import('../lib/limits.mjs').then(({ recordClaudeLimits }) => recordClaudeLimits(data.rate_limits)).catch(() => {});
  }
  const config = orchestraConfig();
  if (typeof config?.chain === 'string' && config.chain.trim() && !process.env.ORCHESTRA_CHAIN_ACTIVE) {
    process.env.ORCHESTRA_CHAIN_ACTIVE = '1';
    const previous = await chain(config.chain, input);
    if (previous) console.log(previous);
  }
  const cwd = data.cwd || data.workspace?.project_dir || process.cwd();
  const session = await collectSession({ transcriptPath: data.transcript_path, sessionId: data.session_id, cwd });
  const options = { width: Number(process.env.COLUMNS) || 100, color: true };
  console.log(renderHeader(session, options));
  const finished = session.board?.finishedAt;
  if (session.board && (!finished || Date.now() - Date.parse(finished) < 600000) || session.agents.some(agent => agent.status === 'running')) {
    const summary = session.board && renderSummary(session, options);
    if (summary) console.log(summary);
    const rows = renderRows(session, options);
    for (const row of rows.slice(0, 6)) console.log(row);
    if (rows.length > 6) console.log(`… ${rows.length - 6} more`);
  }
} catch {
  console.log(`◆ ${cleanText(basename(data?.cwd || data?.workspace?.project_dir || process.cwd()))}  ·  Σ 0`);
}
process.exitCode = 0;
