#!/usr/bin/env node
// Local fake Codex: let the test observe each rollout update before completing.
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const path = process.env.FAKE_ROLLOUT, control = process.env.FAKE_CONTROL;
const baseline = JSON.parse(process.env.FAKE_BASELINE);
const emit = event => console.log(JSON.stringify(event));
function usage(input, cached, output) {
  return { input_tokens: baseline.input_tokens + input, cached_input_tokens: baseline.cached_input_tokens + cached, output_tokens: baseline.output_tokens + output };
}
function count(total) {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', note: 'é', info: total ? { total_token_usage: total } : null } }) + '\n';
}
function waitFor(name) {
  return new Promise(resolve => {
    const timer = setInterval(() => { if (existsSync(join(control, name))) { clearInterval(timer); resolve(); } }, 20);
  });
}
process.stdin.resume();
process.stdin.on('end', async () => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, count(null) + count(usage(100, 60, 10)));
  const next = Buffer.from(count(usage(200, 100, 20))), split = next.indexOf(Buffer.from('é')) + 1;
  appendFileSync(path, next.subarray(0, split));
  emit({ type: 'thread.started', thread_id: 'live-token-thread' });
  emit({ type: 'turn.started' });
  await waitFor('advance');
  appendFileSync(path, next.subarray(split));
  appendFileSync(path, count(null));
  await waitFor('regress');
  appendFileSync(path, count(usage(50, 30, 2)));
  writeFileSync(join(control, 'regressed'), 'ready');
  await waitFor('finish');
  appendFileSync(path, count(usage(350, 160, 40)));
  emit({ type: 'turn.completed', usage: { input_tokens: 150, cached_input_tokens: 60, output_tokens: 20 } });
  emit({ type: 'turn.started' });
  emit({ type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 20 } });
});
setTimeout(() => process.exit(2), 20000).unref();
