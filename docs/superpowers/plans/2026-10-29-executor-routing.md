# Executor Discovery and Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opus picks, for every subtask, the cheapest available executor that will do it well, from a catalog the plugin builds itself out of discovery, public benchmarks, its own benchmark and board history.

**Architecture:** A catalog file (`~/.claude/orchestra/models.json`) is filled by small Node modules: discovery, limits, public benchmarks and an own benchmark. `scripts/models.mjs` exposes them as CLI commands, and `models.mjs brief` prints a short per-task-type ladder that the orchestrate skill reads at step 0. A Gemini runner joins the Codex runner through a shared runner library, and the board records every attempt with its model so history feeds back into the ladder.

**Tech Stack:** Node.js ≥ 20 built-ins only (`node:sqlite` stays limited to the memory), `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-29-executor-routing-design.md` (read it with this plan). Module conventions: `docs/CONTRACT.md`.

**Executors (orchestrate model):** the column "Executor" in each task says who builds it: Codex (`gpt-6.1-sol`) for logic, Sonnet for routine. Opus 5.5 reviews every task and the final branch.

## Global Constraints

- Node built-ins only; no npm dependencies.
- English-only output; wording from the glossary in CONTRACT section 16.
- Nothing local is started: no local models, no llama.cpp. Provider CLIs only.
- Probes run one at a time; at most one tiny request (`Reply OK`) per model per day; discovery result cached 24 h.
- Public benchmarks refresh weekly, or when discovery finds a new model.
- Every public score carries its `source` and `date`; Artificial Analysis attribution appears in README and the web graph.
- Opus is never a hand. `fable` is a hand only when `allowFable: true` is in `~/.claude/orchestra/config.json`.
- Kimi is listed as `disabled: no sandbox` and never receives a task.
- Gemini runs with `--approval-mode yolo --sandbox` for `--write`, `--approval-mode plan` otherwise.
- Own benchmark: 150k-token cap per model run; first run only for models the user picked; automatic runs only for new models, postponed while a board is active or while the provider is above 70% of any limit window.
- Ladder: rung 1 = cheapest candidate with score ≥ 85% of the best for the type; rung 2 = next candidate at least 5 points higher or one cost class up; rung 3 = best score. A provider above 90% of any window is marked `low limit` and skipped for rung 1.
- History dominates the score once a model has ≥ 5 tasks of a type.
- `models.mjs brief` prints at most 20 lines.
- Tests: temporary `ORCHESTRA_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`; fake CLIs on `PATH`; recorded API responses in `test/fixtures/`; no network. `test/index.mjs` loads every test file into one process: never mutate `process.env` at module level, pass env to child processes.

## Review Focus

1. A provider CLI is missing, logged out or its token expired between runs: discovery marks it unavailable with the error text, `brief` leaves it out, nothing throws. (Task 3)
2. The Artificial Analysis key is missing, invalid (401), rate-limited (429) or the network is down: the catalog keeps the previous public data with its old date, BenchLM is used if reachable, the command exits 0 with a one-line warning. (Task 4)
3. A public model name that only looks like a CLI id (`GPT-6 Sol` vs `gpt-6.1-sol`, `Claude Sonnet 5.5` vs `sonnet`): it never matches the wrong model; unmatched means `no public data`. (Task 4)
4. A new model is discovered while an orchestration board is active: the automatic benchmark is postponed, not started. (Task 7)
5. Discovery, benchmark and `brief` touch `models.json` at the same time: readers never see partial JSON, and a write never drops another writer's fields for a different model. (Task 1)

---

### Task 1: Catalog store

**Executor:** Sonnet

**Files:**
- Create: `plugins/orchestra/lib/catalog.mjs`
- Modify: `plugins/orchestra/lib/paths.mjs` (add `catalogPath`, `jobsDir`, `limitsPath`)
- Test: `test/catalog.test.mjs`

**Interfaces:**
- Produces:
  - `paths.catalogPath(): string` → `<orchestraHome>/models.json`; `paths.limitsPath(): string` → `<orchestraHome>/limits.json`; `paths.jobsDir(): string` → `<orchestraHome>/jobs`
  - `TASK_TYPES = ['bug', 'logic', 'refactor', 'tests', 'docs', 'search']`
  - `readCatalog(): Promise<{ version: 1, updatedAt: string|null, discoveredAt: string|null, benchmarksAt: string|null, models: Record<string, Entry> }>` (empty catalog when the file is missing)
  - `updateCatalog(mutator: (catalog) => void): Promise<Catalog>`: read, mutate, write atomically under a lock file `models.json.lock` (retry up to 2 s)
  - `entryId(provider: string, model: string): string` → `"<provider>:<model>"`
  - `allowFable(): boolean` from `orchestraConfig().allowFable === true`
  - `Entry` = the JSON shape in spec section 1 (`id, provider, model, runner, efforts, available{ok,checkedAt,error?}, access, public, own, notes`)

- [ ] **Step 1: Write failing tests** in `test/catalog.test.mjs`:
  - `readCatalog returns an empty catalog when the file is missing` → `models` is `{}`, `version` is `1`.
  - `updateCatalog merges per model without losing other models`: two `updateCatalog` calls started together (one sets `codex:a`, one sets `codex:b`) → both entries present.
  - `readers never see partial JSON`: 50 concurrent `updateCatalog` writes while a loop calls `readCatalog` → every read parses.
  - `allowFable is false unless config says true`.
  Run each in a child process with `ORCHESTRA_HOME` set to a temp dir.
- [ ] **Step 2:** `node --test test/catalog.test.mjs` → FAIL (module missing).
- [ ] **Step 3:** Implement `lib/catalog.mjs` with `atomicJSON` from `paths.mjs`; the lock is an exclusive `open(..., 'wx')` on the lock file, removed in `finally`, stale after 10 s.
- [ ] **Step 4:** `node --test test/catalog.test.mjs` → PASS; `node --test test/` → PASS.
- [ ] **Step 5:** Commit `feat(catalog): model catalog store`.

### Task 2: Limits

**Executor:** Codex

**Files:**
- Create: `plugins/orchestra/lib/limits.mjs`
- Modify: `plugins/orchestra/hud/statusline.mjs` (write Claude limits)
- Test: `test/limits.test.mjs`, fixtures `test/fixtures/rollout-limits.jsonl`, `test/fixtures/statusline-stdin-limits.json`

**Interfaces:**
- Consumes: `paths.limitsPath()`, `paths.codexHome`.
- Produces:
  - `recordClaudeLimits(rateLimits: object): Promise<void>`: writes `{ claude: {...}, recordedAt }` to `limits.json` at most once per 60 s (compare `recordedAt`).
  - `readLimits(): Promise<{ claude: Window[]|null, codex: Window[]|null, gemini: null, kimi: null }>` where `Window = { name: '5h'|'7d'|'week', usedPercent: number, resetsAt: string|null }`.
  - `maxUsedPercent(limits, provider): number|null`.

- [ ] **Step 1: Write failing tests:**
  - `codex limits come from the newest rollout token_count`: fixture with two `token_count` events, the last `primary.used_percent: 8.0`, `window_minutes: 10080` → `codex = [{ name: 'week', usedPercent: 8, resetsAt: <ISO of resets_at> }]`.
  - `claude limits are recorded from statusline stdin and throttled`: two `recordClaudeLimits` calls 1 s apart → file written once.
  - `missing data gives null, not an error`.
  - `statusline still prints when limits.json is not writable`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Check the real `rate_limits` field names in Claude Code's statusline stdin (the docs list `five_hour`, `seven_day`; read one real stdin by logging it once to a temp file, then remove the logging) and map them to `Window`. In `statusline.mjs`, call `recordClaudeLimits(input.rate_limits)` without awaiting the render path; errors are swallowed.
- [ ] **Step 4:** Run → PASS; full suite PASS.
- [ ] **Step 5:** Commit `feat(limits): Claude and Codex limit windows`.

### Task 3: Discovery

**Executor:** Codex

**Files:**
- Create: `plugins/orchestra/lib/discover.mjs`, `plugins/orchestra/scripts/models.mjs` (subcommands added by later tasks)
- Test: `test/discover.test.mjs`, fake CLIs `test/fixtures/bin/codex-models`, `test/fixtures/bin/gemini-probe`

**Interfaces:**
- Consumes: `updateCatalog`, `entryId`, `allowFable` (Task 1).
- Produces:
  - `discover({ force = false, runner = execFile } = {}): Promise<{ added: string[], changed: string[], unavailable: string[] }>`: skipped when `discoveredAt` is younger than 24 h unless `force`.
  - `listClaude(): Promise<Candidate[]>`, `listCodex(): Promise<Candidate[]>`, `listGemini(catalog): Candidate[]`, `listKimi(): Candidate[]`, `probe(candidate): Promise<{ ok: boolean, error?: string }>`.
  - `Candidate = { provider, model, runner, efforts, description? }`.
  - CLI: `node scripts/models.mjs discover [--force]` prints `added: …`, `unavailable: …` lines; exit 0.

- [ ] **Step 1: Write failing tests:**
  - `codex models come from codex debug models, visible ones only`: fake `codex` prints a JSON with `gpt-6.1-sol` (list) and `gpt-reserve` (hide) → only `codex:gpt-6.1-sol` with `efforts` from `supported_reasoning_levels`.
  - `claude hands are haiku and sonnet; fable only with allowFable; opus never`.
  - `gemini is skipped without ~/.gemini/oauth_creds.json`.
  - `kimi is listed as disabled: no sandbox and never probed`.
  - `a failed probe keeps the model as unavailable with the error text` (Review Focus 1: fake `gemini` exits 1 with `auth expired`).
  - `discovery runs at most once per 24 h unless --force`.
  - `probes run one at a time` (fake CLI records start/end timestamps; no overlap).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Claude versions: latest distinct `message.model` per alias family from transcripts modified in the last 7 days (`collect.mjs` helpers may be reused). Gemini candidates: the 3 newest Google models present in the catalog's public data, plus the CLI default (no `-m`). Probe commands exactly as in spec section 2.
- [ ] **Step 4:** Run → PASS; full suite PASS.
- [ ] **Step 5:** Commit `feat(models): discovery`.

### Task 4: Public benchmarks

**Executor:** Codex

**Files:**
- Create: `plugins/orchestra/lib/benchmarks.mjs`, `plugins/orchestra/data/model-aliases.json`
- Modify: `plugins/orchestra/scripts/models.mjs` (`benchmarks` subcommand)
- Test: `test/benchmarks.test.mjs`, fixtures `test/fixtures/aa-models.json`, `test/fixtures/benchlm/*.md`

**Interfaces:**
- Consumes: `updateCatalog`, `readCatalog` (Task 1).
- Produces:
  - `refreshBenchmarks({ force = false, fetch = globalThis.fetch, key } = {}): Promise<{ matched: string[], unmatched: string[], source: string[], warnings: string[] }>`; skipped when `benchmarksAt` is younger than 7 days unless `force` or a catalog entry has no `public` yet.
  - `matchModel(publicName: string, creator: string, catalog): string|null` (returns an entry id or `null`).
  - CLI: `node scripts/models.mjs benchmarks [--force]`; key from `ORCHESTRA_AA_KEY` or config `artificialAnalysisKey`.

- [ ] **Step 1: Write failing tests:**
  - `AA data fills codingIndex, livecodebench, price and speed with source and date` (fixture with `artificial_analysis_coding_index`, `livecodebench`, `price_1m_input_tokens`, `price_1m_output_tokens`, `median_output_tokens_per_second`).
  - `no key → BenchLM only, warning "no Artificial Analysis key"`.
  - `401, 429 and network errors keep previous public data and its old date` (Review Focus 2).
  - `matchModel never matches a look-alike`: `GPT-6 Sol` ≠ `gpt-6.1-sol`, `GPT-6.1 Sol` = `gpt-6.1-sol`, `Claude Sonnet 5.5` = `claude:sonnet` only when discovery resolved `sonnet` to `claude-sonnet-5-5` (Review Focus 3).
  - `unmatched models get public: { source: null, note: "no public data" }`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. AA endpoint `https://artificialanalysis.ai/api/v2/data/llms/models` with header `x-api-key`, one request per refresh. BenchLM: fetch the raw README of `leoncuhk/awesome-llm-bench` (check its current file layout once) and parse the SWE-bench Verified and Terminal-Bench tables. Normalization: lowercase, drop vendor prefix, spaces and dots to `-`; then exact match against catalog ids, then the alias file; nothing fuzzy.
- [ ] **Step 4:** Run → PASS; full suite PASS.
- [ ] **Step 5:** Commit `feat(models): public benchmarks`.

### Task 5: Shared runner and Gemini runner

**Executor:** Codex

**Files:**
- Create: `plugins/orchestra/lib/runner.mjs`, `plugins/orchestra/scripts/gemini-task.mjs`
- Modify: `plugins/orchestra/scripts/codex-task.mjs` (use `lib/runner.mjs`), `plugins/orchestra/lib/collect.mjs` (read `jobs/` and `codex-jobs/`)
- Test: `test/gemini-task.test.mjs`, fake `test/fixtures/bin/gemini-stream`; existing `test/core.test.mjs`, `test/codex-task*.test.mjs` must stay green

**Interfaces:**
- Consumes: CONTRACT sections 11 and 15 (job file, footer, memory prefix, `## Findings`), `paths.jobsDir()` (Task 1).
- Produces:
  - `runTask({ provider, buildArgs, parseEvent, argv, prompt }): Promise<number>` in `lib/runner.mjs`: shared job file writes, `--detach`/`wait`, memory prefix, findings, signals, footer. Job files go to `jobs/<id>.json` with `provider`; ids `cx-…` for Codex, `gm-…` for Gemini.
  - `scripts/gemini-task.mjs`: same flags as `codex-task.mjs`; spawns `gemini -m <model> -p - --output-format stream-json --approval-mode yolo --sandbox` with `--write`, `--approval-mode plan` without; `cwd` = `--cwd`.
  - `collectCodexJobs` keeps its name and also returns Gemini jobs (`executor: 'gemini'`, `kind: 'gemini'`).

- [ ] **Step 1:** Run one real `gemini -p "Reply OK" --output-format stream-json` in a temp dir and save its stdout as `test/fixtures/gemini-stream.jsonl` (the event shapes). This is the only real call.
- [ ] **Step 2: Write failing tests:**
  - `gemini-task maps stream-json events to activity and tokens` (from the fixture).
  - `gemini-task passes --sandbox and yolo only with --write`.
  - `gemini jobs appear in the snapshot with executor gemini`.
  - `codex-task behaves exactly as before` (existing suites).
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Extract the shared parts of `codex-task.mjs` into `lib/runner.mjs`, then write `gemini-task.mjs` on top of it. Add `gemini` to `executorColors` (`#4285F4`) and `executorName` in `render.mjs`.
- [ ] **Step 5:** `node --test test/` twice → PASS.
- [ ] **Step 6:** Commit `feat(runner): shared runner and Gemini runner`.

### Task 6: Board attempts and task types

**Executor:** Codex

**Files:**
- Modify: `plugins/orchestra/scripts/board.mjs`, `plugins/orchestra/lib/collect.mjs`, `plugins/orchestra/lib/render.mjs`
- Test: `test/attempts.test.mjs`

**Interfaces:**
- Produces:
  - `board add <id> "<title>" --exec <provider> [--model <m>] [--effort <e>] [--type <type>]` (`type` ∈ `TASK_TYPES`).
  - `board exec <id> <provider> [--model <m>] [--effort <e>]` changes the executor of the next attempt.
  - Task gains `type` and `attempts: [{ n, provider, model, effort, startedAt, endedAt, outcome: 'accepted'|'rework'|'failed'|null, tokens }]`; the old numeric `attempts` becomes `attempts.length` in the snapshot (`Task.attemptCount`).
  - `set running` opens a new attempt; `set done|rework|failed` closes the open one with its outcome and its tokens (sum of agents/jobs with this task id that started after `startedAt`, from `collectSession`).
  - `history(): Promise<Record<entryId, Record<type, { tasks, firstTry, avgTokens }>>>` exported from `lib/collect.mjs`, read from all boards and their archives.
  - Render: executor column shows the short model with effort, e.g. `6.1-sol@high`, `sonnet`.

- [ ] **Step 1: Write failing tests:**
  - `set running/rework/running/done records two attempts with outcomes rework then accepted`.
  - `an escalated task keeps the failed attempt of the cheaper model` (`exec` to a new model between attempts).
  - `history counts first-try acceptance per model and type`.
  - `old boards without attempt records still load` (numeric `attempts`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; keep `show` columns aligned (existing alignment tests stay green).
- [ ] **Step 4:** `node --test test/` → PASS.
- [ ] **Step 5:** Commit `feat(board): attempts with model, effort and type`.

### Task 7: Own benchmark

**Executor:** Codex

**Files:**
- Create: `plugins/orchestra/bench/{bug,logic,refactor,tests,docs,multi}/` (each: `repo/`, `brief.md` starting with `#B-<type>`, `check.mjs` exiting 0 on pass), `plugins/orchestra/lib/bench.mjs`
- Modify: `plugins/orchestra/scripts/models.mjs` (`bench` subcommand)
- Test: `test/bench.test.mjs`

**Interfaces:**
- Consumes: runners (Task 5), `readLimits`/`maxUsedPercent` (Task 2), `updateCatalog` (Task 1).
- Produces:
  - `runBench({ models: string[], auto = false, cap = 150000, runner }): Promise<Record<entryId, { done: boolean, reason?: string, byType }>>`.
  - `benchPostponeReason(provider): Promise<string|null>`: `"board active"` when any unfinished board was updated in the last 30 min, `"low limit"` when the provider is above 70% of any window.
  - CLI: `models.mjs bench --models a,b` (explicit, ignores the auto rules except the cap), `models.mjs bench --new` (auto: only entries with `own == null` and `benchAuto: true` in config), `models.mjs bench --estimate` (prints tokens per model, nothing runs).
  - Claude models run through `claude -p --model <alias> --output-format json` in the temp repo.

- [ ] **Step 1: Write failing tests:**
  - `each fixture's check fails on the untouched repo and passes on its reference fix` (reference fixes live next to the tests, not in the plugin).
  - `bench --new is postponed while a board is active` (Review Focus 4).
  - `bench --new does nothing without benchAuto: true`.
  - `the 150k cap stops a run and marks it partial`.
  - `results land in the catalog under own.byType with tokens and seconds`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; runs strictly one model and one task at a time.
- [ ] **Step 4:** `node --test test/` → PASS.
- [ ] **Step 5:** Commit `feat(models): own benchmark`.

### Task 8: Routing summary

**Executor:** Codex

**Files:**
- Create: `plugins/orchestra/lib/route.mjs`
- Modify: `plugins/orchestra/scripts/models.mjs` (`brief` subcommand)
- Test: `test/route.test.mjs`

**Interfaces:**
- Consumes: `readCatalog` (1), `readLimits`, `maxUsedPercent` (2), `history` (6).
- Produces:
  - `score(entry, type, history): { value: number, evidence: string }`: public coding index (0-100) as the prior, own pass rate for the type adjusts it, history first-try rate replaces it at ≥ 5 tasks. `evidence` names the sources, e.g. `own 6/6 · AA 74` or `history 9 tasks, 89% first try`.
  - `costClass(entry): '$'|'$$'|'$$$'|'$$$$'` from blended price; subscription-only entries use the provider default in `data/model-aliases.json`.
  - `ladder(type, catalog, limits, history): Array<{ rung: 1|2|3, id, effort, score, cost, lowLimit }>` with the rules in Global Constraints.
  - CLI: `models.mjs brief [--types bug,docs]` prints the ladder for each type, at most 20 lines total, plus one line with the limits.

- [ ] **Step 1: Write failing tests** with a synthetic catalog:
  - `rung 1 is the cheapest candidate at or above 85% of the best`.
  - `rung 2 is at least 5 points higher or one cost class up`.
  - `a provider above 90% is marked low limit and skipped for rung 1`.
  - `history with 5 tasks overrides public scores` (a model with AA 80 but 2/5 first try ranks below a model with AA 70 and 5/5).
  - `fable never appears unless allowFable`; `opus never appears`; `unavailable models never appear`.
  - `brief output is at most 20 lines`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `node --test test/` → PASS.
- [ ] **Step 5:** Commit `feat(models): routing summary`.

### Task 9: Skill, setup, README and contract

**Executor:** Sonnet (writing follows the no-ai-slop skill)

**Files:**
- Modify: `plugins/orchestra/skills/orchestrate/SKILL.md`, `plugins/orchestra/skills/setup/SKILL.md`, `README.md`, `docs/CONTRACT.md` (new sections 17-20 for catalog, discovery, benchmarks, routing)

**Interfaces:**
- Consumes: every CLI from Tasks 1-8, exactly as named there.

- [ ] **Step 1:** Orchestrate skill:
  - Step 0: check the session model; if it is not Opus 5.5, say that the final review goes to an `Agent` with `model: "opus"`. Run `models.mjs discover` (it skips itself within 24 h) and `models.mjs brief`.
  - Plan table columns: `# · task · type · executor · model@effort · why (evidence)`.
  - Remove every place where Opus edits code. Escalation climbs the ladder; the last rung is the strongest hand.
  - Sub-agents only when the brief allows them and names model and effort.
  - Prompting notes per family, 2-3 lines each (Codex, Claude, Gemini).
  - `board add … --model --effort --type` in the examples.
- [ ] **Step 2:** Setup skill: run `discover --force`, ask for the optional AA key (store as `artificialAnalysisKey`), show `bench --estimate`, run `bench --models <picked>`, then set `benchAuto: true`.
- [ ] **Step 3:** README: the routing feature in Features, the new `models.mjs` commands, the AA attribution line, Fable opt-in and Kimi status in Configuration.
- [ ] **Step 4:** Check: `grep -rnP '[\x{0400}-\x{04FF}]'` over changed files is empty except the documented exceptions; no banned no-ai-slop words; `claude plugin validate` passes for both manifests.
- [ ] **Step 5:** Commit `docs: routing in the skill, setup, README and contract`.

### Task 10: Web graph additions

**Executor:** Sonnet (designer)

**Files:**
- Modify: `plugins/orchestra/web/index.html`, `plugins/orchestra/web/mock-snapshot.json`

**Interfaces:**
- Consumes: `Task.type`, `Task.attemptCount`, per-attempt `model`/`effort` (Task 6), executor `gemini` with color `#4285F4` (Task 5).

- [ ] **Step 1:** Show `model@effort` under each task label and the attempt list (model, outcome, tokens) in the details popover; add the Gemini color and name; an "Artificial Analysis" credit link in the footer.
- [ ] **Step 2:** Mock: one Gemini task, one escalated task with a failed cheap attempt.
- [ ] **Step 3:** Check light/dark, desktop/390 px, `?mock=1` and the live server; no overlaps, no console errors.
- [ ] **Step 4:** Commit `feat(web): models, attempts and Gemini on the graph`.

## Order and parallelism

Task 1 first. Then 2, 3, 5 and 6 in parallel (separate files). Task 4 after 3 (it needs resolved Claude versions). Task 7 after 2, 5 and 1. Task 8 after 2, 4 and 6. Task 9 and 10 last. Opus 5.5 reviews each task's diff and runs `node --test test/` before accepting; the whole branch gets a final review and one real orchestration run on the demo repo.
