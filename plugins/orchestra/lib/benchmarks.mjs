import { readFileSync } from 'node:fs';
import { readCatalog, updateCatalog } from './catalog.mjs';
import { orchestraConfig } from './paths.mjs';

const AA = 'artificialanalysis.ai';
const BENCHLM = 'benchlm.ai';
const AA_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';
const BENCHLM_URL = 'https://raw.githubusercontent.com/leoncuhk/awesome-llm-bench/main/README.md';
const WEEK_MS = 7 * 86400000;

function normalize(name, creator = '') {
  let value = String(name || '').trim().toLowerCase();
  // Catalog executor prefixes and public vendor namespaces are not model identities.
  value = value.replace(/^[\w-]+[:/]/, '');
  value = value.replace(/[\s.]+/g, '-');
  const vendor = String(creator || '').trim().toLowerCase().replace(/[\s.]+/g, '-');
  if (vendor && value.startsWith(`${vendor}-`)) value = value.slice(vendor.length + 1);
  return value;
}

/** Exact identities only: concrete Claude versions must have been resolved by discovery. */
export function matchModel(publicName, creator, catalog) {
  const name = normalize(publicName, creator);
  if (!name) return null;
  const find = target => {
    const ids = Object.entries(catalog.models).filter(([id, entry]) =>
      [id, entry.model, entry.resolved].some(value => value && normalize(value) === target)
    ).map(([id]) => id);
    return ids.length === 1 ? ids[0] : null;
  };
  const exact = find(name);
  if (exact) return exact;
  let aliases = {};
  try {
    const value = JSON.parse(readFileSync(new URL('../data/model-aliases.json', import.meta.url), 'utf8'))?.aliases;
    if (value && typeof value === 'object' && !Array.isArray(value)) aliases = value;
  } catch { /* Missing or malformed aliases must not prevent exact matching or discovery. */ }
  return Object.hasOwn(aliases, name) && typeof aliases[name] === 'string' ? find(normalize(aliases[name])) : null;
}

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function parseAA(body, date) {
  if (!Array.isArray(body?.data)) throw new Error('invalid response');
  return body.data.flatMap(row => {
    if (!row || typeof row.name !== 'string') return [];
    const data = { source: AA, date };
    for (const [field, value] of [
      ['codingIndex', row.evaluations?.artificial_analysis_coding_index],
      ['livecodebench', row.evaluations?.livecodebench],
      ['outputTokensPerSecond', row.median_output_tokens_per_second],
    ]) if (number(value)) data[field] = value;
    const pricing = row.pricing;
    if (number(pricing?.price_1m_input_tokens) && number(pricing?.price_1m_output_tokens)) {
      data.price = { input: pricing.price_1m_input_tokens, output: pricing.price_1m_output_tokens, unit: 'USD per 1M tokens' };
    }
    // An identity with no usable figures is not public benchmark evidence.
    return Object.keys(data).length > 2 ? [{ name: row.name, creator: row.model_creator?.name, data }] : [];
  });
}

function parseBenchLM(text, date) {
  const rows = [];
  for (const [heading, metric] of [['SWE-bench Verified', 'swebench'], ['Terminal-Bench 2.0', 'terminalbench']]) {
    const section = text.split(`### ${heading}\n`)[1]?.split(/^#{1,3} /m)[0];
    if (!section || !/\|\s*Rank\s*\|\s*Model\s*\|\s*Provider\s*\|\s*License\s*\|\s*Score\s*\|/.test(section)) {
      throw new Error('invalid response');
    }
    let count = 0;
    for (const line of section.split('\n')) {
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
      if (cells.length !== 5 || !/^\d+$/.test(cells[0])) continue;
      const score = /^(\d+(?:\.\d+)?)%$/.exec(cells[4]);
      const name = /^\[(.*)\]\([^)]*\)$/.exec(cells[1])?.[1] || cells[1];
      if (!score || !name || Number(score[1]) > 100) continue;
      rows.push({ name, creator: cells[2], data: { source: BENCHLM, date, [metric]: Number(score[1]) } });
      count++;
    }
    if (!count) throw new Error('invalid response');
  }
  return rows;
}

/** Fetch once per source, outside the lock; apply to the latest catalog in one sync mutation. */
export async function refreshBenchmarks({ force = false, fetch = globalThis.fetch, key } = {}) {
  const catalog = await readCatalog();
  const result = { matched: [], unmatched: [], source: [], warnings: [] };
  const age = Date.now() - Date.parse(catalog.benchmarksAt);
  if (!force && age >= 0 && age < WEEK_MS && Object.values(catalog.models).every(entry => entry.public)) return result;

  key ??= process.env.ORCHESTRA_AA_KEY || orchestraConfig().artificialAnalysisKey;
  const date = new Date().toISOString().slice(0, 10);
  const records = [];
  let failed = false;
  async function load(source, url, options, parse) {
    let response;
    try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) }); } catch {
      result.warnings.push(`${source}: request failed`); failed = true; return;
    }
    if (!response.ok) {
      result.warnings.push(`${source}: HTTP ${response.status}`); failed = true; return;
    }
    try {
      const rows = await parse(response);
      records.push(...rows);
      result.source.push(source);
    } catch {
      result.warnings.push(`${source}: invalid response`); failed = true;
    }
  }
  if (key) await load(AA, AA_URL, { headers: { 'x-api-key': key } }, async response => parseAA(await response.json(), date));
  else result.warnings.push('no Artificial Analysis key');
  await load(BENCHLM, BENCHLM_URL, {}, async response => parseBenchLM((await response.text()).replace(/\r\n/g, '\n'), date));

  await updateCatalog(current => {
    const updates = new Map();
    for (const row of records) {
      const id = matchModel(row.name, row.creator, current);
      if (!id) continue;
      const previous = updates.get(id);
      if (!previous) updates.set(id, { ...row.data });
      else if (previous.source === BENCHLM && row.data.source === BENCHLM) Object.assign(previous, row.data);
      // AA is loaded first and remains authoritative for every model it covers.
    }
    for (const [id, entry] of Object.entries(current.models)) {
      const data = updates.get(id);
      // A missing key or failed source must never re-date or replace its last good figures.
      const preserve = entry.public?.source && data?.source !== AA && (
        (!data && failed) || (entry.public.source === AA && !result.source.includes(AA))
      );
      if (data) result.matched.push(id);
      else result.unmatched.push(id);
      // A source failure leaves unchecked entries retryable even with a recent benchmarksAt.
      if (!preserve && (data || !failed)) entry.public = data || { source: null, note: 'no public data' };
    }
    // A failed request is retryable; it must not suppress retries for another week.
    if (!failed) current.benchmarksAt = new Date().toISOString();
  });
  return result;
}
