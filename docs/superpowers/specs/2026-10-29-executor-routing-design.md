# Executor discovery and routing

Status: design, awaiting approval · 2026-10-29

## Intent

Opus is the brain, every other model is a pair of hands. Today the plugin hands every hard
subtask to one fixed Codex model (`gpt-6.1-sol`) and every routine one to Sonnet, and Opus still
edits code itself for small fixes. That wastes tokens in both directions: strong, expensive models
do trivial work, and Opus spends its scarce budget on edits.

The plugin should find every model the user can actually use, know what each one is good at and
what it costs, and give Opus that picture. Opus then picks, for every subtask, the cheapest
executor that will do it well, writes a brief suited to that model, reviews, and lands the result.
Opus decides; the plugin supplies information, not routing rules.

## Decisions the user made

- **Executors:** Claude models available to Claude Code agents, GPT models through the Codex CLI,
  Gemini through the Gemini CLI, and Kimi through the Kimi CLI. Only providers the user is logged
  in to or subscribed to.
- **Sandboxing:** Gemini runs commands only inside its macOS sandbox, confined to the worktree like
  Codex. Kimi stays off until it offers a sandbox: its headless `--print` mode approves every
  command on the whole machine. Discovery lists it as `disabled: no sandbox`.
- **Own benchmark budget:** the first run happens only with consent at `/orchestra:setup`, where the
  user picks the models and sees the token estimate. After that only newly discovered models run
  automatically, never during an orchestration run, and never while that provider is above 70% of
  any limit window. Not used: opencode (same OpenAI account as Codex), llama.cpp and any
  local model, DeepSeek (not installed).
- **Opus never writes or edits code**, not even one line. The top of the escalation ladder is the
  strongest available hand, not Opus.
- **Hands do exactly what the brief says.** Every brief lists the files that may change and a
  checkable done criterion. A hand that notices a problem outside its scope reports it instead of
  fixing it. The review rejects extra changes as rework.
- **No load on the machine.** Nothing local is started. Discovery reads files and sends at most one
  tiny request per model.
- **New models are found automatically**, e.g. `gpt-5.6-terra` appearing in the Codex model list.
- **Two kinds of benchmark:** the plugin's own small benchmark, and a public site that publishes
  results continuously. Agreed setup: Artificial Analysis (free API key) as the main public source,
  BenchLM as the keyless fallback, a 6-task own benchmark, and the user's board history overriding
  both once a model has 5 or more tasks of a type.
- **Opus picks models itself**, without asking the user to approve the plan.
- **Remaining limits matter:** Claude (5-hour and weekly windows) and Codex (weekly window).

## Goals

1. A model catalog, rebuilt automatically, of every usable executor with its capabilities, cost,
   remaining limit and evidence.
2. Per task type, a ranking Opus can read in a few lines before it splits a task.
3. A runner for Gemini with the same contract as `codex-task.mjs`; Kimi follows once it can be sandboxed.
4. Every task on the board records the executor, model, effort and task type, so outcomes feed back
   into the catalog.
5. The orchestrate skill changes to brain-only Opus, catalog-driven choice and strict scope.

## Non-goals

- Hard-coded routing rules in code. The skill gives Opus guidance; the code gives it data.
- Local models, even when the hardware could run them (an M3 Pro with 18 GB would be noticeably
  loaded by a 7-14B model).
- Switching a running task to another model mid-flight. Escalation happens between attempts.
- A benchmark dashboard. The web graph only shows which model did what.

## Anti-goals (failure even if it technically works)

- Catalog upkeep that costs more tokens than the routing saves.
- Any probe or benchmark that slows down the machine or starts a local model.
- Opus editing code, or hands "improving" things they were not asked to touch.
- Old benchmark numbers presented as current: every score carries its source and date.
- A plan that names a model without saying why.

## Task types

Every subtask gets one type. The catalog scores models per type.

| Type | Examples |
|---|---|
| `bug` | crash, wrong result, failing test to fix |
| `logic` | new non-trivial behavior, algorithms, data handling |
| `refactor` | restructure without changing behavior, multi-file moves |
| `tests` | tests that follow an existing pattern |
| `docs` | README, comments, text, typos |
| `search` | find where something lives, explain code, gather context (read-only) |

## Components

### 1. Model catalog

`~/.claude/orchestra/models.json`, one entry per executor and model:

```json
{
  "id": "codex:gpt-5.6-terra",
  "provider": "codex",
  "model": "gpt-5.6-terra",
  "runner": "codex-task.mjs",
  "efforts": ["low", "medium", "high", "xhigh"],
  "available": { "ok": true, "checkedAt": "2026-10-29T10:00:00Z" },
  "access": "subscription: ChatGPT Pro",
  "public": {
    "source": "artificialanalysis.ai", "date": "2026-10-28",
    "codingIndex": 61.2, "livecodebench": 78.0,
    "price": { "input": 1.25, "output": 10.0, "unit": "USD per 1M tokens" },
    "outputTokensPerSecond": 140
  },
  "own": { "date": "2026-10-29", "byType": { "bug": { "passed": 1, "total": 1, "tokens": 18200, "seconds": 41 } } },
  "notes": "first seen 2026-10-29"
}
```

History from the boards (tasks per type, share accepted on the first attempt, average tokens) is
computed when the routing summary is built, not stored in the catalog.

### 2. Discovery: `scripts/models.mjs discover`

Runs at most once a day (the result is cached), plus when the user runs `/orchestra:setup`.

| Provider | How models are listed | How access is checked |
|---|---|---|
| Claude | The Agent tool aliases `haiku`, `sonnet`, `fable`, resolved to concrete versions from `message.model` in recent transcripts. `opus` is the orchestrator and is never a hand. | Always available inside Claude Code; no probe |
| Codex | `codex debug models` (JSON with slug, description, visibility and supported efforts; only `visibility: list` entries). `~/.codex/models_cache.json` is not used: an old app-server process can leave it stale, as it is on this machine today. | `codex exec -m <model> -s read-only "Reply OK"`, once per new or changed model |
| Gemini | Public catalog entries from the Gemini family, intersected with what the CLI accepts | `gemini -m <model> -p "Reply OK"` once; skipped when `~/.gemini/oauth_creds.json` is missing |
| Kimi | `kimi -m <model>` candidates from the public catalog | `kimi --print -p "Reply OK"` once; a login or subscription error means "not available" and no further probes until the next day |

Each probe is one short request, run one at a time. A model that fails its probe stays in the
catalog as unavailable with the error, so Opus can see why it is missing.

### 3. Public benchmarks: `scripts/models.mjs benchmarks`

Weekly, and whenever discovery finds a new model.

- **Artificial Analysis** (`https://artificialanalysis.ai/api/v2/data/llms/models`, header
  `x-api-key`): coding index, LiveCodeBench, price per 1M tokens, output speed. The key is read
  from `ORCHESTRA_AA_KEY` or `artificialAnalysisKey` in `~/.claude/orchestra/config.json`. The free
  tier allows 1000 requests a day; one request per refresh is enough. Attribution is required: the
  README and the web graph credit artificialanalysis.ai.
- **BenchLM** through its daily GitHub mirror (`leoncuhk/awesome-llm-bench`): SWE-bench Verified
  and Terminal-Bench tables. Used for models Artificial Analysis does not list yet, and as the only
  source when there is no key.
- Names on these sites differ from CLI model ids. Matching uses normalization plus a small alias
  table in the repo; an unmatched model is marked "no public data" rather than guessed.

### 4. Own benchmark: `scripts/models.mjs bench`

Six tiny fixture repositories under `plugins/orchestra/bench/`, one per task type plus one
multi-file change, each with a hidden check script (the pattern used for the orchestra-demo runs).

- Runs a model through its normal runner in a temporary directory: Codex through `codex-task.mjs`,
  Gemini and Kimi through their runners, Claude models through `claude -p --model <alias>`.
- First run: only the models the user picked at `/orchestra:setup`, after seeing the token estimate.
- After that: automatically once for every newly discovered model, in the background, one model at
  a time; postponed while an orchestration board is active or while the provider is above 70% of
  any limit window. It can always be rerun by hand.
- A hard token cap per model run (150k) stops it early; the partial result is kept and marked.
- Records pass/fail, tokens and seconds per type into the catalog.

### 5. Runner for Gemini (and later Kimi)

`scripts/gemini-task.mjs` (and `scripts/kimi-task.mjs` once Kimi has a sandbox) follow the contract of `codex-task.mjs`
(CONTRACT section 11 and 15): brief on stdin with `#<id>` on the first line, `--cwd`, `--model`,
`--effort` where the CLI supports it, `--write`, `--detach`/`wait`, live activity and tokens from
the CLI's `stream-json` output, memory prefix before the run and `## Findings` saved after it,
the same footer line. Gemini runs with `--approval-mode yolo --sandbox` for `--write` (commands
and tests allowed, confined by the macOS sandbox to the worktree) and `--approval-mode plan`
otherwise. Kimi gets a runner only when it offers a sandbox; until then it is listed in the catalog
as `disabled: no sandbox` and never receives a task.

Job files move from `codex-jobs/` to `jobs/` with a `provider` field; the collector reads both
folders during the transition. The board, status line and graph show the provider and model of
every job.

### 6. Limits

- Claude: the status line script already receives `rate_limits` on stdin. It writes them to
  `~/.claude/orchestra/limits.json` at most once a minute.
- Codex: the last `token_count` event with `rate_limits` in the newest rollout file
  (`plan_type`, `used_percent`, window, reset time).
- Gemini and Kimi: unknown; shown as unknown.

### 7. Routing summary for Opus: `scripts/models.mjs brief`

Prints at most about 20 lines that Opus reads at step 0. For each task type, the top three
available candidates with: score and its evidence (public, own, or history with the number of
tasks), cost class, the effort to use, and the remaining limit of the provider. Example shape:

```
bug     codex:gpt-6.1-sol@high   own 6/6 · AA 74 · $$$ · codex 8% used/week
        codex:gpt-5.6-terra@med  history 9 tasks, 89% first try · $$ 
        claude:sonnet            AA 70 · $$ · claude 41% used/5h
docs    claude:haiku             own 1/1 · $ ...
```

How the score blends the three sources is documented in the code and in CONTRACT. The intended
weighting: public scores give the starting estimate, the own benchmark adjusts it, and history
dominates once a model has 5 or more tasks of that type.

Which candidates are shown (designer's call): per task type, a ladder of up to three rungs, cheapest
first:
1. **cheap:** the cheapest candidate whose score is at least 85% of the best score for that type;
2. **step up:** the next candidate with a clearly higher score (at least 5 points or one cost class up);
3. **top:** the best-scoring candidate, at its highest sensible effort.
Opus starts at rung 1 unless the subtask is risky; escalation climbs the rungs. A provider above 90%
of any limit window is still listed but marked `low limit` and is skipped for rung 1. Unavailable
models are not listed.

### 8. Board additions

`board add <id> "<title>" --exec <provider> --model <model> --effort <effort> --type <type>`.
The type is stored per task. Each attempt is stored as its own record: provider, model, effort,
tokens, and how it ended (accepted, rework, failed). A task that climbs to a stronger model keeps
the failed attempts of the cheaper one, so the history shows which model really did the work.

### 9. Skill changes (`skills/orchestrate/SKILL.md`)

- Step 0 runs `models.mjs brief` (after the daily discovery, if due).
- The plan table gets a type, model and effort per subtask and one line on why, citing the
  evidence from the summary.
- Opus never edits code. Small fixes go to the cheapest suitable hand. Escalation climbs the
  candidates for that task type; the last step is the strongest hand at its highest effort.
- The brief template keeps the strict scope rules: allowed files, done criterion, "report, don't
  fix" for anything outside scope. The review checks scope first.
- Sub-agents stay, but only when Opus allows them in the brief and names the sub-agent's model and
  effort there. A hand never picks a model itself. The runners keep `--detach`/`wait` for this.
- Short prompting notes per model family (Codex, Claude, Gemini, Kimi). Opus writes the brief; the
  notes only say what each family needs (for example, explicit file paths and a single done command
  for small models).

### 10. Setup changes (`/orchestra:setup`)

Runs discovery, asks for an optional Artificial Analysis key, and lists every available model with
its estimated benchmark cost in tokens. The user picks which models to benchmark now (none is fine);
only those run.

## Constraints

- Node built-ins only, as the rest of the plugin.
- English-only output, wording from the glossary (CONTRACT section 16).
- Probes and benchmarks never run in parallel with each other and never start local processes
  other than the provider CLIs.
- Tests use temporary `ORCHESTRA_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, fake CLIs on `PATH`, and
  recorded API responses. No test calls a real provider or the network.

## Designer's calls (the user did not decide these; check them)

- Opus is never a hand; `fable` is a hand, usually the top rung for `bug`, `logic` and `refactor`
  when the Claude limits allow it.
- The candidate ladder in section 7: 85% bar for rung 1, `low limit` above 90% of a window.
- Sub-agents only when the brief allows them and names their model.
- Codex models come from `codex debug models`, not from the CLI's cache file.
- Tokens and the model are recorded per attempt, not per task.

## Left to the builder

- The exact name matching between public sites and CLI model ids, and the alias table.
- The concrete `stream-json` event shapes of the Gemini and Kimi CLIs (check them on this machine).
- The content of the six benchmark tasks.
- The score blending formula, within the intent above.
- How the cost class (`$`..`$$$$`) is derived for subscription-only providers that publish no price.

## How we will know it works

- A model added to a provider list shows up in the catalog within a day, probed, with public data
  or "no public data", and an own-benchmark result after its background run.
- Every plan names type, model and effort per subtask with a one-line reason.
- Opus makes no code edits in a run.
- Over a week of use, the share of tokens spent on the most expensive models drops while the
  first-try acceptance rate stays the same or improves (read from the boards).
