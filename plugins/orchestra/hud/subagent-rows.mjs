#!/usr/bin/env node
import { collectCodexJobs, executorFor, parseTaskId, projectRoot } from '../lib/collect.mjs';
import { renderRow, agentActivity } from '../lib/render.mjs';

process.stdout.on('error', () => {});
function duration(start) {
  const ms = typeof start === 'number' ? (start < 1e11 ? start * 1000 : start) : Date.parse(start);
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 1000)) : 0;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}
let data = {};
try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  data = JSON.parse(input);
  const jobsByCwd = new Map();
  for (const task of Array.isArray(data?.tasks) ? data.tasks : []) {
    try {
      const type = task.agentType || task.type || '', cwd = task.cwd || data.cwd || process.cwd();
      let job;
      if (/codex/i.test(type)) {
        const root = await projectRoot(cwd);
        if (!jobsByCwd.has(root)) jobsByCwd.set(root, await collectCodexJobs(root));
        const start = typeof task.startTime === 'number' ? (task.startTime < 1e11 ? task.startTime * 1000 : task.startTime) : Date.parse(task.startTime);
        const label = task.description || task.name || '';
        const taskId = parseTaskId(label);
        const matches = jobsByCwd.get(root).filter(candidate => (!taskId || candidate.taskId === taskId) && (!Number.isFinite(start) || !candidate.endedAt || Date.parse(candidate.endedAt) >= start) && Date.parse(candidate.startedAt) <= Date.now());
        job = matches.find(candidate => candidate.description === label) || matches.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
      }
      const executor = job || /codex/i.test(type) ? 'codex' : executorFor(task.model);
      const status = job?.status || task.status || 'running';
      const label = task.description || task.name || task.id;
      const activity = agentActivity({ status, activity: job?.activity || task.activity });
      const tokens = job?.tokens.spent ?? task.tokenCount ?? 0;
      const content = renderRow({ label, executor, status, tokens: { spent: tokens }, activity: `${activity}   ${duration(task.startTime || job?.startedAt)}` }, { width: data.columns || 100 });
      console.log(JSON.stringify({ id: String(task.id), content }));
    } catch { console.log(JSON.stringify({ id: String(task?.id || ''), content: '◐ agent' })); }
  }
} catch { /* no valid task ids to emit */ }
process.exitCode = 0;
