export const executorColors = { opus: '#D97757', codex: '#10A37F', sonnet: '#7C6CF2', haiku: '#3BA7E0', fable: '#C9A227', other: '#8A8F98' };
export const statusColors = { done: '#2E9E5B', completed: '#2E9E5B', running: '#E0A030', review: '#3BA7E0', rework: '#C77DDB', failed: '#D9534F', queued: '#8A8F98', stopped: '#8A8F98' };
export const statusGlyphs = { done: '✓', completed: '✓', running: '◐', review: '◑', rework: '↻', failed: '✗', queued: '○', stopped: '○' };
export const statusLabels = { queued: 'queued', running: 'running', review: 'review', rework: 'rework', done: 'done', failed: 'failed', completed: 'finished', stopped: 'stopped' };
export const executorName = value => ({ opus: 'Opus', codex: 'Codex', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', other: 'Other' })[value] || 'Other';
export const cleanText = value => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ');
export function formatTokens(value) {
  const n = Math.max(0, Number(value) || 0);
  return n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(n));
}
export function paint(text, hex, color) {
  if (!color || !hex) return text;
  const values = hex.slice(1).match(/../g).map(value => parseInt(value, 16));
  return `\x1b[38;2;${values.join(';')}m${text}\x1b[0m`;
}
function cellWidth(char) {
  if (/\p{Mark}/u.test(char)) return 0;
  const n = char.codePointAt(0);
  return n >= 0x1100 && (n <= 0x115f || n >= 0x2e80 && n <= 0xa4cf || n >= 0xac00 && n <= 0xd7af || n >= 0xf900 && n <= 0xfaff || n >= 0xfe10 && n <= 0xfe6f || n >= 0xff00 && n <= 0xff60 || n >= 0x1f300) ? 2 : 1;
}
const displayWidth = text => Array.from(cleanText(text)).reduce((sum, char) => sum + cellWidth(char), 0);
const firstLine = text => cleanText(String(text ?? '').split(/[\r\n]/, 1)[0]);
const normalizedWidth = width => Number.isFinite(Number(width)) ? Math.max(1, Math.floor(Number(width))) : 100;
function column(text, width, right = false) {
  const value = truncate(text, width), padding = ' '.repeat(Math.max(0, width - displayWidth(value)));
  return right ? padding + value : value + padding;
}
export function agentActivity(agent) {
  return ['completed', 'failed', 'stopped'].includes(agent.status) ? statusLabels[agent.status] : agent.activity || statusLabels[agent.status] || 'working';
}
export function renderRow(row, { width = 100, color = false, prefix = '', columnPrefixWidth = displayWidth(prefix) } = {}) {
  width = normalizedWidth(width);
  // Reserve the executor/token fields and some activity even on narrow terminals.
  const labelWidth = Math.max(1, Math.min(Math.round(width * 0.28), width - columnPrefixWidth - 27) - (displayWidth(prefix) - columnPrefixWidth));
  const label = column(firstLine(row.label), labelWidth);
  const glyph = paint(statusGlyphs[row.status] || '○', statusColors[row.status], color);
  const executor = paint(column(executorName(row.executor), 6), executorColors[row.executor], color);
  const tokens = column(row.tokens?.spent ? formatTokens(row.tokens.spent) : '—', 6, true);
  return truncate(`${prefix}${glyph} ${label} ${executor} ${tokens}   ${cleanText(row.activity)}`, width);
}
export function truncate(line, width = 100) {
  width = normalizedWidth(width);
  const parts = String(line).match(/\x1b\[[0-?]*[ -/]*[@-~]|[^]/gu) || [];
  const visible = parts.reduce((sum, part) => sum + (part.startsWith('\x1b[') ? 0 : cellWidth(part)), 0);
  if (visible <= width) return line;
  let result = '', used = 0, ansi = false;
  for (const part of parts) {
    if (part.startsWith('\x1b[')) { result += part; ansi = true; continue; }
    const size = cellWidth(part);
    if (used + size > width - 1) break;
    result += part; used += size;
  }
  return `${result}${ansi ? '\x1b[0m' : ''}…`;
}
export function renderHeader(session, { width = 100, color = false } = {}) {
  const project = session.project || {}, counts = session.totals?.byExecutor || {};
  const totals = ['opus', 'codex', 'sonnet', 'haiku', 'fable', 'other'].filter(key => counts[key] > 0).map(key => `${paint(executorName(key), executorColors[key], color)} ${formatTokens(counts[key])}`);
  const name = `◆ ${cleanText(project.name || 'orchestra')}`;
  const rest = `${project.branch ? `  ⎇ ${cleanText(project.branch)}` : ''}${totals.length ? `  ·  ${totals.join(' · ')}` : ''}  ·  Σ ${formatTokens(session.totals?.spent)}`;
  const landed = session.board?.integration?.landedAt ? ' · landed' : '';
  const memory = session.kb ? [`memory ${session.kb.notes} · ≈${formatTokens(session.kb.savedTokens)} saved`,
    `memory ${session.kb.notes} · ≈${formatTokens(session.kb.savedTokens)}`].map(text => ` · ${text}`) : [];
  const full = normalizedWidth(width), fits = text => displayWidth(text) <= full;
  // Drop the least important parts first: the word 'saved', then the memory block.
  for (const suffix of [...memory.map(text => `${landed}${text}`), landed]) {
    if (fits(`${name}${rest}${suffix}`)) return `${name}${rest}${suffix}`;
  }
  // Still too wide (a very long project name): shorten the name, keep the numbers and labels.
  const minName = [24, 10, 10];   // the full memory label is worth keeping only with a readable name
  for (const [index, suffix] of [...memory.map(text => `${landed}${text}`), landed].entries()) {
    const room = full - displayWidth(`${rest}${suffix}`);
    if (room >= minName[memory.length ? index : 2]) return `${truncate(name, room)}${rest}${suffix}`;
  }
  return truncate(`${name}${rest}${landed}`, width);
}
export function taskParent(task) {
  return task.parentId || task.parent || (String(task.id).includes('.') ? String(task.id).split('.')[0] : null);
}
export function taskHierarchy(tasks) {
  const ids = new Set(tasks.map(task => task.id)), children = new Map(), roots = [];
  for (const task of tasks) {
    const parent = taskParent(task);
    if (parent && ids.has(parent)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(task);
    } else roots.push(task);
  }
  return roots.flatMap((task, index) => [
    { task, prefix: index === roots.length - 1 ? '╰─ ' : '├─ ' },
    ...(children.get(task.id) || []).map((child, childIndex, siblings) => ({ task: child, prefix: childIndex === siblings.length - 1 ? '│  ╰─ ' : '│  ├─ ' })),
  ]);
}
export function renderRows(session, { width = 100, color = false } = {}) {
  const tasks = session.board?.tasks;
  const rows = tasks ? taskHierarchy(tasks) : (session.agents || []).map((task, index, agents) => ({ task, prefix: index === agents.length - 1 ? '╰─ ' : '├─ ' }));
  return rows.map(({ task: row, prefix }) => {
    const isTask = !!tasks;
    const agents = isTask ? (session.agents || []).filter(agent => row.agentIds?.includes(agent.id)) : [];
    const active = agents.find(agent => agent.status === 'running') || agents[0];
    let activity = isTask ? (active ? agentActivity(active) : statusLabels[row.status]) : agentActivity(row);
    if (isTask && row.status === 'queued' && row.dependsOn?.length) activity = `waits on ${row.dependsOn.map(id => `#${id}`).join(', ')}`;
    if (isTask && row.status === 'done') activity = `done${row.attempts > 1 ? ` · ${row.attempts} attempts` : ''}`;
    if (isTask && row.merged) activity = 'merged';
    if (isTask && row.note) activity = row.note;
    const label = isTask ? `#${row.id} ${row.title}` : row.description || row.id;
    return renderRow({ ...row, label, activity }, { width, color, prefix, columnPrefixWidth: 3 });
  });
}
export function renderSummary(session, { width = 100, color = false } = {}) {
  const counts = session.totals?.tasks || {};
  const segments = ['done', 'running', 'review', 'queued', 'failed'].filter(key => counts[key] > 0).map(key => `${paint(statusGlyphs[key], statusColors[key], color)} ${counts[key]} ${statusLabels[key]}`);
  return segments.length ? truncate(`  tasks  ${segments.join('   ')}`, width) : null;
}
export function renderBoard(session, options = {}) {
  return [renderHeader(session, options), session.board && renderSummary(session, options), ...renderRows(session, options)].filter(Boolean).join('\n');
}
