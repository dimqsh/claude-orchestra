import { readFileSync } from 'node:fs';
import { allowFable, entryId } from './catalog.mjs';
import { maxUsedPercent } from './limits.mjs';

const { providerCostClasses } = JSON.parse(readFileSync(new URL('../data/model-aliases.json', import.meta.url), 'utf8'));
const finite = value => Number.isFinite(value) && value >= 0;
const percent = value => Math.min(100, Math.max(0, value));

/** Public coding evidence is the prior; BenchLM supplies SWE-bench when AA is absent. */
function prior(entry) {
  const data = entry.public;
  for (const [key, label] of [['codingIndex', ''], ['swebench', 'SWE-bench '],
    ['terminalbench', 'Terminal-Bench '], ['livecodebench', 'LiveCodeBench ']]) {
    if (!finite(data?.[key])) continue;
    const source = data.source === 'artificialanalysis.ai' ? 'AA' : data.source === 'benchlm.ai' ? 'BenchLM' : data.source || 'public';
    return { value: percent(data[key]), evidence: `${source} ${label}${data[key]}${data.date ? ` (${data.date})` : ''}` };
  }
  return null;
}

/**
 * Public prior and own pass rate have equal weight; without a prior, use the own rate alone.
 * Fewer than five historical tasks are ignored. At five, the historical first-try fraction
 * replaces both benchmarks. Missing evidence yields 0 with an explicit "no public data" label.
 */
export function score(entry, type, history = {}) {
  const past = history?.[entry.id || entryId(entry.provider, entry.model)]?.[type];
  if (past?.tasks >= 5 && finite(past.firstTry) && past.firstTry <= 1) {
    const value = past.firstTry * 100;
    return { value, evidence: `history ${past.tasks} tasks, ${Math.round(value)}% first try` };
  }
  const pub = prior(entry), own = entry.own?.byType?.[type];
  if (own?.total > 0 && finite(own.passed) && own.passed <= own.total) {
    const rate = 100 * own.passed / own.total;
    return { value: pub ? (pub.value + rate) / 2 : rate,
      evidence: `own ${own.passed}/${own.total}${pub ? ` · ${pub.evidence}` : ''}` };
  }
  return pub || { value: 0, evidence: 'no public data' };
}

function blendedPrice(entry) {
  const price = entry.public?.price;
  return finite(price?.input) && finite(price?.output) ? (3 * price.input + price.output) / 4 : null;
}

/** USD per 1M tokens, 3:1 input/output blend: <=1, <=5, <=15, then the highest class. */
export function costClass(entry) {
  const price = blendedPrice(entry);
  if (price === null) return providerCostClasses[entry.provider] || '$$$$';
  return price <= 1 ? '$' : price <= 5 ? '$$' : price <= 15 ? '$$$' : '$$$$';
}

function effort(entry, top, rung) {
  const efforts = entry.efforts || [];
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const highest = order.findLast(value => efforts.includes(value)) || efforts.at(-1) || null;
  if (top) return highest;
  return (rung === 1 && efforts.includes('medium') ? 'medium' : efforts.includes('high') ? 'high' : highest);
}

/** Up to three distinct entries; an already-selected top model is not repeated as padding. */
export function ladder(type, catalog, limits, history = {}) {
  const fableAllowed = allowFable();
  const candidates = Object.values(catalog.models).filter(entry => {
    const identities = [entry.id, entry.model, entry.resolved].filter(Boolean).join(' ');
    return entry.available?.ok === true && entry.provider !== 'kimi' &&
      !/(?:^|[\s:/_-])opus(?:$|[\s:/_-])/i.test(identities) &&
      (fableAllowed || !/(?:^|[\s:/_-])fable(?:$|[\s:/_-])/i.test(identities));
  }).map(entry => ({ entry, id: entry.id || entryId(entry.provider, entry.model),
    score: score(entry, type, history), cost: costClass(entry),
    lowLimit: maxUsedPercent(limits, entry.provider) > 90 }));
  // Defaults have no exact price: use a representative price within their configured class.
  const price = row => blendedPrice(row.entry) ?? [0.5, 3, 10, 20][row.cost.length - 1];
  const cheapest = (a, b) => a.cost.length - b.cost.length || price(a) - price(b) ||
    b.score.value - a.score.value || a.id.localeCompare(b.id);
  candidates.sort(cheapest);
  const best = [...candidates].sort((a, b) => b.score.value - a.score.value || cheapest(a, b))[0];
  if (!best) return [];
  const rows = [];
  const add = (candidate, rung) => rows.push({ rung, id: candidate.id,
    effort: effort(candidate.entry, candidate === best, rung), score: candidate.score,
    cost: candidate.cost, lowLimit: candidate.lowLimit });
  const first = candidates.find(row => !row.lowLimit && row.score.value >= best.score.value * 0.85);
  if (first) {
    add(first, 1);
    if (first === best) return rows;
    const next = candidates.find(row => row !== first &&
      (row.score.value >= first.score.value + 5 || row.cost.length > first.cost.length));
    if (next) add(next, 2);
  }
  if (!rows.some(row => row.id === best.id)) add(best, 3);
  return rows;
}
