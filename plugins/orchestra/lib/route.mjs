import { readFileSync } from 'node:fs';
import { allowFable, entryId } from './catalog.mjs';
import { maxUsedPercent } from './limits.mjs';

const finite = value => Number.isFinite(value) && value >= 0;
const percent = value => Math.min(100, Math.max(0, value));
const metrics = [['codingIndex', ''], ['swebench', 'SWE-bench '],
  ['terminalbench', 'Terminal-Bench '], ['livecodebench', 'LiveCodeBench ']];

/** Use one public axis per ladder: greatest coverage, then the declared metric order. */
function primaryMetric(entries) {
  let metric = metrics[0], values = [];
  for (const candidate of metrics) {
    const covered = entries.map(entry => entry.public?.[candidate[0]]).filter(finite).map(percent);
    if (covered.length > values.length) { metric = candidate; values = covered; }
  }
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const neutral = values.length ? (values[middle] + values[Math.floor((values.length - 1) / 2)]) / 2 : 50;
  return { metric, neutral };
}

function prior(entry, { metric: [key, label], neutral }) {
  const data = entry.public;
  if (!finite(data?.[key])) return { value: neutral, evidence: `no public data · neutral prior ${Number(neutral.toFixed(1))}` };
  const source = data.source === 'artificialanalysis.ai' ? 'AA' : data.source === 'benchlm.ai' ? 'BenchLM' : data.source || 'public';
  return { value: percent(data[key]), evidence: `${source} ${label}${data[key]}${data.date ? ` (${data.date})` : ''}` };
}

function observations(entry, type, history) {
  const past = history?.[entry.id || entryId(entry.provider, entry.model)]?.[type];
  const historyN = finite(past?.tasks) && finite(past?.firstTry) && past.firstTry <= 1 ? past.tasks : 0;
  const own = entry.own?.byType?.[type];
  const ownN = finite(own?.total) && own.total > 0 && finite(own.passed) && own.passed <= own.total ? own.total : 0;
  return { past, historyN, own, ownN, n: ownN + historyN };
}

/**
 * Pool own passes with historical first-try successes; n observations get weight n / (n + 4).
 * At five historical tasks, history alone dominates. Missing primary-metric evidence uses
 * the candidate cohort's median, or 50 when none is known. Standalone score uses one entry.
 */
function scoreWithPrior(entry, type, history, context) {
  const { past, historyN, own, ownN, n } = observations(entry, type, history);
  const historyEvidence = `history ${historyN} tasks, ${Math.round((past?.firstTry || 0) * 100)}% first try`;
  if (historyN >= 5) return { value: past.firstTry * 100, evidence: historyEvidence };
  const pub = prior(entry, context);
  const passes = (ownN ? own.passed : 0) + (historyN ? historyN * past.firstTry : 0);
  const evidence = [ownN ? `own ${own.passed}/${own.total}` : null,
    historyN ? historyEvidence : null, pub.evidence].filter(Boolean).join(' · ');
  // Algebraically (1 - w) * prior + w * 100 * passes / n, with w = n / (n + 4).
  return { value: (4 * pub.value + 100 * passes) / (n + 4), evidence };
}

export function score(entry, type, history = {}) {
  return scoreWithPrior(entry, type, history, primaryMetric([entry]));
}

function blendedPrice(entry) {
  const price = entry.public?.price;
  return finite(price?.input) && finite(price?.output) ? (3 * price.input + price.output) / 4 : null;
}

/** USD per 1M tokens, 3:1 input/output blend: <=1, <=5, <=15, then the highest class. */
export function costClass(entry) {
  const price = blendedPrice(entry);
  if (price === null) {
    let defaults = {};
    try {
      defaults = JSON.parse(readFileSync(new URL('../data/model-aliases.json', import.meta.url), 'utf8')) ?? {};
    } catch { /* Missing or malformed optional defaults must not break routing. */ }
    for (const [values, key] of [
      [defaults.modelCostClasses, entry.id || entryId(entry.provider, entry.model)],
      [defaults.providerCostClasses, entry.provider],
    ]) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      const cost = values[key];
      if (typeof cost === 'string' && /^\${1,4}$/.test(cost)) return cost;
    }
    return '$$';
  }
  return price <= 1 ? '$' : price <= 5 ? '$$' : price <= 15 ? '$$$' : '$$$$';
}

function effort(entry, rung, onlyBest) {
  const efforts = entry.efforts || [];
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const target = order.indexOf(rung === 1 && !onlyBest ? 'medium' : 'high');
  return order.slice(0, target + 1).findLast(value => efforts.includes(value)) ||
    order.slice(target + 1).find(value => efforts.includes(value)) || null;
}

export function eligibleEntries(catalog) {
  const fableAllowed = allowFable();
  return Object.values(catalog.models).filter(entry => {
    const identities = [entry.id, entry.model, entry.resolved].filter(Boolean).join(' ');
    return entry.available?.ok === true && ['codex', 'claude'].includes(entry.provider) &&
      !/(?:^|[\s:/_-])opus(?:$|[\s:/_-])/i.test(identities) &&
      (fableAllowed || !/(?:^|[\s:/_-])fable(?:$|[\s:/_-])/i.test(identities));
  });
}

function hasEvidence(entry, type, history, context) {
  return finite(entry.public?.[context.metric[0]]) || observations(entry, type, history).n >= 1;
}

/** Eligible, non-skipped model IDs without public primary-metric or measured per-type evidence. */
export function untested(type, catalog, limits, history = {}) {
  const entries = eligibleEntries(catalog), context = primaryMetric(entries);
  return entries.filter(entry => !entry.own?.skipped && !hasEvidence(entry, type, history, context))
    .map(entry => entry.id || entryId(entry.provider, entry.model));
}

/** Up to three distinct entries with evidence; the top model is not repeated as padding. */
export function ladder(type, catalog, limits, history = {}) {
  const entries = eligibleEntries(catalog);
  const context = primaryMetric(entries);
  const candidates = entries.filter(entry => hasEvidence(entry, type, history, context))
    .map(entry => ({ entry, id: entry.id || entryId(entry.provider, entry.model),
    score: scoreWithPrior(entry, type, history, context), cost: costClass(entry),
    lowLimit: maxUsedPercent(limits, entry.provider) > 90 }));
  // Defaults have no exact price: use a representative price within their configured class.
  const price = row => blendedPrice(row.entry) ?? [0.5, 3, 10, 20][row.cost.length - 1];
  const cheapest = (a, b) => a.cost.length - b.cost.length || price(a) - price(b) ||
    b.score.value - a.score.value || a.id.localeCompare(b.id);
  const best = [...candidates].sort((a, b) => b.score.value - a.score.value ||
    b.cost.length - a.cost.length || prior(b.entry, context).value - prior(a.entry, context).value)[0];
  if (!best) return [];
  candidates.sort(cheapest);
  const rows = [];
  const add = (candidate, rung) => rows.push({ rung, id: candidate.id,
    effort: effort(candidate.entry, rung, candidate === best && rung === 1), score: candidate.score,
    cost: candidate.cost, lowLimit: candidate.lowLimit });
  const first = candidates.find(row => !row.lowLimit && row.score.value >= best.score.value * 0.85 - 1e-9);
  if (first) {
    add(first, 1);
    if (first === best) return rows;
    const next = candidates.find(row => row !== first &&
      (row.score.value >= first.score.value + 5 || (row.cost.length > first.cost.length && row.score.value >= first.score.value)));
    if (next) add(next, 2);
  }
  if (!rows.some(row => row.id === best.id)) add(best, 3);
  return rows;
}
