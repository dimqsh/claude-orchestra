# claude-orchestra: shared contract

Single source of truth for everyone building this repo. If your code disagrees with this
file, the file wins; if the file is wrong, say so in your report instead of silently diverging.

Runtime: Node >= 20, ES modules (`.mjs`), **no npm dependencies** (node builtins only). The shared
memory (section 12) needs Node >= 22.13 for `node:sqlite`; everything else must keep working without it.
User-facing text (ASCII board, web UI, README, skills) is **English** (Part 3). Code, comments and
this contract are English.

## 1. Repository layout and ownership

```
.claude-plugin/marketplace.json          A
plugins/orchestra/
  .claude-plugin/plugin.json             A
  hooks/hooks.json                       A
  skills/orchestrate/SKILL.md            OPUS (do not touch)
  skills/setup/SKILL.md                  A
  skills/board/SKILL.md                  A
  lib/paths.mjs                          C
  lib/collect.mjs                        C
  lib/render.mjs                         C
  hud/statusline.mjs                     C
  hud/subagent-rows.mjs                  C
  scripts/board.mjs                      C
  scripts/codex-task.mjs                 C
  scripts/install-hud.mjs                A
  web/server.mjs                         A
  web/index.html                         D
  web/mock-snapshot.json                 D
test/**                                  C (A may add test/server.test.mjs, test/install-hud.test.mjs)
docs/CONTRACT.md                         OPUS
README.md                                A
```

C = Codex, A = Sonnet executor, D = Sonnet designer. Touch only your own files.
Never commit, push, or edit anything outside this repo. Tests must not write to the real
`~/.claude` — always set `ORCHESTRA_HOME` / `CLAUDE_CONFIG_DIR` to a temp dir in tests.

## 2. Paths (`lib/paths.mjs`)

```js
export const claudeConfigDir   // env.CLAUDE_CONFIG_DIR || ~/.claude
export const orchestraHome     // env.ORCHESTRA_HOME   || <claudeConfigDir>/orchestra
export const codexHome         // env.CODEX_HOME       || ~/.codex
export function projectSlug(cwd)        // cwd.replace(/[^a-zA-Z0-9]/g, '-')  (Claude's projects/ dir naming)
export function projectDir(cwd)         // <claudeConfigDir>/projects/<projectSlug(cwd)>
export function boardPath(cwd)          // <orchestraHome>/boards/<projectSlug(realpath(cwd))>.json
export function cacheDir()              // <orchestraHome>/cache
export function jobsDir()               // <orchestraHome>/jobs   (job records of every runner, written by lib/runner.mjs, section 11)
export function codexJobsDir()          // <orchestraHome>/codex-jobs   (legacy: still read, no longer written)
export function catalogPath()           // <orchestraHome>/models.json  (section 17)
export function limitsPath()            // <orchestraHome>/limits.json  (section 17)
export function codexStateRoots()       // [<claudeConfigDir>/plugins/data/codex-openai-codex/state,
                                        //  <os.tmpdir()>/codex-companion]  (optional: jobs started via the codex plugin)
export function orchestraConfig()       // parsed <orchestraHome>/config.json or {}
                                        // keys: chain, chainOriginal, codexModel, allowFable, artificialAnalysisKey, benchAuto (section 17)
```

Install layout: `scripts/install-hud.mjs install` copies `lib/`, `hud/` and `data/` into
`<orchestraHome>/lib`, `<orchestraHome>/hud` and `<orchestraHome>/data`, so `hud/*.mjs` must
import siblings only via relative paths (`../lib/collect.mjs`). Nothing that `hud/` imports,
directly or through `lib/`, may depend on files outside `lib/`, `hud/` and `data/`. `lib/` code
reads `data/` through `new URL('../data/<file>', import.meta.url)`, and treats a missing or
malformed data file as empty. `lib/bench.mjs` and `lib/runner.mjs` are the exception: they run from
the plugin folder only (they reach `bench/` and `scripts/`) and are never imported by the HUD.

## 3. Data sources (all read-only)

Claude Code (observed on this machine, Claude Code 2.1.308):
- Main transcript: `<projectDir(cwd)>/<sessionId>.jsonl`.
- Subagents: `<projectDir(cwd)>/<sessionId>/subagents/agent-<agentId>.jsonl`, sidecar
  `agent-<agentId>.meta.json` with `agentType`, `description`, `toolUseId`, `model`.
- Assistant lines: `message.model`, `message.usage{input_tokens, cache_creation_input_tokens,
  cache_read_input_tokens, output_tokens}`. One API response spans several lines with the same
  `message.id` and identical usage: **dedupe by `message.id`** before summing.
- Main-thread lines have `isSidechain: false`.
- Agent launch = `tool_use` named `Agent` (or legacy `Task`) with `input.description`,
  `input.subagent_type`, `input.model`. Background launch result text contains
  `agentId: <id>`. Completion of a background agent = a later record containing
  `<task-notification>` with `<task-id>ID</task-id>` and `<status>completed|failed|...</status>`.
  Foreground agents complete when their `tool_result` arrives. Inspect real transcripts under
  `~/.claude/projects/` to confirm shapes; handle unknown shapes gracefully.

Codex, primary source: our own job files `<jobsDir()>/<jobId>.json` written live by
`scripts/codex-task.mjs` (section 11). They already carry status, activity and tokens. The
collector also reads the legacy `<codexJobsDir()>` folder, and a job file without a `provider`
field counts as a Codex job.

Codex, secondary source (only for jobs started through the codex plugin / `codex:codex-rescue`):
- Job index: `<codexStateRoot>/<workspace-slug>-<hash>/state.json` → `jobs[]` with `id`,
  `status` (queued|running|completed|failed), `phase`, `summary` (first meaningful prompt line),
  `workspaceRoot`, `threadId`, `createdAt`, `updatedAt`, `completedAt`, `logFile`.
  Full record: `jobs/<id>.json`, progress log `jobs/<id>.log`.
- Tokens: `<codexHome>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`. Use the last line
  with `type:"event_msg"` and `payload.type:"token_count"` where `payload.info` is non-null:
  `payload.info.total_token_usage{input_tokens, cached_input_tokens, output_tokens,
  reasoning_output_tokens, total_tokens}`. Model: `turn_context.payload.model`.

## 4. Token accounting

```
tokens = { input, cacheWrite, cacheRead, output, spent }
Claude: spent = input_tokens + cache_creation_input_tokens + output_tokens   (cache reads excluded)
Codex:  spent = (input_tokens - cached_input_tokens) + output_tokens
```
`cacheRead` is still reported (Codex: `cached_input_tokens`) for tooltips.
Format for display: `512`, `18.2k`, `1.4M` (one decimal, drop `.0`).

Executor classification of an agent:
- Codex job → `codex`.
- Claude subagent of type containing `codex` (e.g. `codex:codex-rescue`) is a forwarder: if a
  Codex job overlaps its lifetime in the same workspace, merge it into that job (job wins) and do
  not list it separately; otherwise list it as `codex` with its own Claude tokens.
- Otherwise by `message.model`: contains `opus`→`opus`, `sonnet`→`sonnet`, `haiku`→`haiku`,
  `fable`→`fable`, else `other`.

## 5. Board file (`scripts/board.mjs` writes, everyone reads)

Path: `boardPath(cwd)`. Written atomically (write temp + rename).

```json
{
  "version": 1,
  "title": "export + sorting bug",
  "cwd": "/abs/project",
  "sessionId": null,
  "createdAt": "ISO", "updatedAt": "ISO", "finishedAt": null,
  "tasks": [
    { "id": "1", "title": "sorting bug", "executor": "codex", "model": "gpt-6.1-sol", "effort": "medium", "type": "bug",
      "status": "running", "attempts": [ /* one record per attempt, section 20 */ ],
      "dependsOn": [], "note": "", "updatedAt": "ISO" }
  ]
}
```
`executor` is the provider: codex | claude (gemini | kimi are accepted but never receive a task;
sonnet | opus | haiku | fable are legacy values, read as `claude`). `model`, `effort` and `type`
may be null. `status`: queued | running | review | rework | done | failed. Section 20 defines
`type` and the attempt records; the example omits the sub-task, branch and merge fields of
sections 13 and 14.

CLI (cwd = `--cwd <dir>` or `process.cwd()`; several commands may be chained with ` && `):
```
board.mjs init "<title>" [--session <id>]   new board; previous file moved to boards/archive/<slug>-<ts>.json
board.mjs add <id> "<title>" --exec <provider> [--model <m>] [--effort <e>] [--type <t>] [--deps 1,2]
board.mjs set <id> <status> [--note "<text>"]   -> running opens an attempt record; done|rework|failed closes it (section 20)
board.mjs exec <id> <provider> [--model <m>] [--effort <e>]   reassign (escalation); model and effort become null when omitted
board.mjs show [--width N] [--color]         ASCII board (render.mjs renderBoard), no ANSI unless --color
board.mjs finish
board.mjs json
```
Errors go to stderr with exit code 1 and a one-line English message.

## 6. Linking agents to tasks

Every agent the orchestrator starts carries the task id at the start of its label:
- Claude subagent: Agent `description` = `#<id> <short title>`, e.g. `#2 export csv`.
- Codex job: first prompt line = `#<id> <short title>` (becomes the job `summary`).
Parse with `/^#([\w.-]+)\b/`. Several agents may map to one task (attempts, escalation).

## 7. Snapshot schema (`lib/collect.mjs` output)

```ts
type Tokens = { input: number; cacheWrite: number; cacheRead: number; output: number; spent: number };
type Executor = "opus" | "codex" | "sonnet" | "haiku" | "fable" | "other";

type Agent = {
  id: string;                      // Claude agentId or Codex job id
  kind: "claude" | "codex";
  type: string;                    // agentType / subagent_type, or "codex"
  executor: Executor;
  model: string | null;            // "claude-sonnet-5-5", "gpt-6.1-sol", ...
  description: string;             // "#2 export csv" (raw label)
  taskId: string | null;           // "2"
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: string; endedAt: string | null;   // ISO
  activity: string;                // what it is doing now, glossary words or tool form: "Edit cli.py", "Bash pytest -q", "codex: running"
  tokens: Tokens;
};

type Task = { id; title; executor; status; attempts; dependsOn; note; updatedAt;   // from board
              tokens: Tokens; agentIds: string[] };                                 // aggregated from agents

type Session = {
  sessionId: string;
  project: { name: string; cwd: string; branch: string | null };
  updatedAt: string;               // transcript mtime
  orchestrator: { model: string | null; tokens: Tokens };   // main thread only
  agents: Agent[];                 // newest first
  board: { title: string; createdAt: string; finishedAt: string | null; tasks: Task[] } | null;
  totals: {
    byExecutor: Partial<Record<Executor, number>>;   // spent tokens incl. orchestrator
    spent: number;
    tasks: { done: number; running: number; review: number; queued: number; failed: number };
  };
};

type Snapshot = { version: 1; generatedAt: string; sessions: Session[] };
```

Exports:
```js
export async function collectSession({ transcriptPath, cwd, sessionId })  // -> Session
export async function collectActive({ sinceMinutes = 120 } = {})          // -> Snapshot, sessions whose main transcript changed within the window, newest first
export async function findLatestTranscript(cwd)                           // -> { transcriptPath, sessionId } | null
```
CLI: `node lib/collect.mjs --active` prints a Snapshot; `node lib/collect.mjs --cwd <dir>` prints
the Session for the latest transcript of that project. Project `name` = basename of the git
toplevel (or of cwd); `branch` from `git rev-parse --abbrev-ref HEAD` (null if not a repo), cached
for 5 s.

Performance: the status line refreshes every 2 s. Keep an incremental per-file cache in
`cacheDir()` (byte offset, partial last line, running aggregates, keyed by path+inode) so a warm
`collectSession` takes < 150 ms on a session with a 20 MB transcript and 20 subagents.

## 8. Visual language (ASCII and web share it)

Executor colors: opus `#D97757`, codex `#10A37F`, sonnet `#7C6CF2`, haiku `#3BA7E0`,
fable `#C9A227`, other `#8A8F98`.
Status: done `#2E9E5B` `✓`, running `#E0A030` `◐`, review `#3BA7E0` `◑`, rework `#C77DDB` `↻`,
failed `#D9534F` `✗`, queued `#8A8F98` `○`.
Labels: queued `queued`, running `running`, review `review`, rework `rework`, done `done`,
failed `failed`; agents: completed `finished`, stopped `stopped` (full glossary: section 16).

ASCII board (`renderBoard(session, { width = 100, color = false })`), tree like the reference
graph, project → Opus → tasks:
```
◆ acme-shop  ⎇ feat/export  ·  Opus 18.2k · Codex 41.7k · Sonnet 14.0k  ·  Σ 73.9k
  tasks  ✓ 3 done   ◐ 2 running   ○ 1 queued
├─ ◐ #1 sorting bug           Codex    24.1k   editing cli.py
├─ ✓ #2 export csv/json       Codex    17.6k   done · 2 attempts
├─ ◐ #4 export tests          Sonnet    9.8k   Bash pytest tests/
╰─ ○ #5 docstrings            Sonnet       —   waits on #2
```
Without a board, the task rows are replaced by agent rows (`#id`/description, executor, tokens,
activity). Lines are truncated to `width` with `…`. With `color`, use 24-bit ANSI for the
executor name and status glyph only; everything else default color.

## 9. Status lines

`hud/statusline.mjs` (Claude Code `statusLine`, stdin = statusline JSON with `session_id`,
`transcript_path`, `cwd`, `workspace.project_dir`):
1. If `<orchestraHome>/config.json` has `chain` (the user's previous statusLine command), run it
   with the same stdin (timeout 700 ms) and print its non-empty output first.
2. Print the header line always; print the task/agent rows only while a board is unfinished, or
   finished < 10 min ago, or an agent is running. Max 6 rows, then `… N more`.
3. Width: `process.env.COLUMNS` or 100. Colors on. Must always exit 0 and print something sane
   on any error (fall back to just the header, or nothing).

`hud/subagent-rows.mjs` (Claude Code `subagentStatusLine`, stdin has `columns` and `tasks[]`
with `id`, `name`, `type`, `agentType`, `status`, `description`, `startTime`, `model`,
`tokenCount`, `cwd`): print one JSON line per task: `{"id":"<task.id>","content":"<row>"}`.
Row: `◐ Codex  #1 sorting bug   editing cli.py   2m14s  24.1k`. For codex forwarder rows use
the merged Codex job tokens/activity when found, else `tokenCount`. Exit 0 always.

## 10. Web graph

`web/server.mjs`: `node web/server.mjs [--port 7377] [--ensure] [--stop] [--mock]`, binds
127.0.0.1 only. `--ensure`: if `GET /health` answers, print the URL and exit 0; else start itself
detached (pid in `<orchestraHome>/server.pid`, log `<orchestraHome>/server.log`), wait ≤ 3 s for
health, print the URL. Endpoints: `/` → `index.html`; `/mock-snapshot.json`; `/api/snapshot` →
`collectActive()` (or the mock with `--mock`); `/events` → SSE, recompute every 1000 ms, send
`data: <Snapshot JSON>\n\n` only when it changed, `: ping` every 15 s; `/health` → `{"ok":true}`.
Imports `../lib/collect.mjs`.

`web/index.html` is specified at the end of this section.

## 11. Codex runner (`scripts/codex-task.mjs`)

The orchestrator runs Codex through this wrapper with a background Bash call. It talks to the
Codex CLI directly (`codex exec --json`), not through the codex plugin's app-server broker: the
broker is long-lived and keeps using an old Codex binary after `codex update`, which breaks new
models. Requires Codex CLI >= 0.165.0 on PATH.

Since executor routing, `scripts/codex-task.mjs` is a provider definition on the shared runner
`lib/runner.mjs`. The shared runner owns the job file, memory, `--detach`, `wait` and the footer
(section 15); the provider definition owns the CLI arguments, event parsing and token reading. A
second CLI would be one more provider definition. The Gemini one is deferred (section 18).

```
node codex-task.mjs [--cwd <dir>] [--model <m>] [--effort <e>] [--write] [--resume-last] < prompt
```
- Model: `--model`, else `orchestraConfig().codexModel`, else env `ORCHESTRA_CODEX_MODEL`, else `gpt-6.1-sol`. The orchestrator passes `--model` and `--effort` for every task (section 20), so the fallback only matters for manual runs.
- Effort: `--effort` is passed as `-c model_reasoning_effort=<e>`; without it the CLI default applies and the job records `null`.
- The first non-empty stdin line must start with `#<id>`; otherwise exit 1 with an English message.
- Job id `cx-<base36 ms>-<4 random base36>`. Job file `<jobsDir()>/<jobId>.json`, atomic writes,
  throttled to at most one write per second plus a final write. Job files written before routing
  live in `<codexJobsDir()>` and have no `provider` field; they stay readable (section 3):
  ```json
  { "version": 1, "provider": "codex", "id": "cx-…", "taskId": "2", "label": "#2 export csv", "cwd": "/abs (realpath)",
    "model": "gpt-6.1-sol", "effort": "medium", "write": true, "pid": 123,
    "status": "running|completed|failed", "startedAt": "ISO", "endedAt": null,
    "threadId": null, "activity": "Bash pytest -q",
    "tokens": { "input": 0, "cacheWrite": 0, "cacheRead": 0, "output": 0, "spent": 0 },
    "finalMessage": null, "error": null, "memoryCount": 0 }
  ```
- Spawn `codex exec --json --skip-git-repo-check -m <model> [-c model_reasoning_effort=<e>]
  -s <workspace-write|read-only> -C <cwd> -` with the prompt on stdin. `--resume-last`: take the
  `threadId` of the newest Codex job (in `jobsDir()`, then the legacy folder) with the same cwd and
  use the CLI's resume form of `codex exec` (check `codex exec --help` / `codex exec resume --help`
  for the exact syntax). The resumed run takes its own `--model` and `--effort`.
- Before coding, run `codex exec --json` on a trivial read-only prompt to confirm the event shapes
  in this CLI version. Expected: `thread.started{thread_id}`, `turn.started`,
  `item.started|item.updated|item.completed{item:{type, ...}}` with item types such as
  `command_execution{command}`, `file_change{changes[{path}]}`, `agent_message{text}`, `reasoning`,
  `mcp_tool_call`, `web_search`, `todo_list`; `turn.completed{usage{input_tokens,
  cached_input_tokens, output_tokens}}`; `turn.failed{error}` / `error{message}`.
- `activity`: command → `Bash <command, 40 chars>`, file change → `editing <basename>`, agent
  message → `answering`, reasoning → `thinking`, else the item type.
- Tokens: sum `turn.completed.usage`: `input = input_tokens - cached_input_tokens`,
  `cacheRead = cached_input_tokens`, `output = output_tokens`, `spent = input + output`.
  While a turn is running, you may refresh tokens from the rollout `token_count` events of the
  thread (section 3) if that is cheap; otherwise tokens update at turn end.
- On exit, print to stdout the final agent message (or the error), then one footer line:
  `[codex] #<id> done|failed · <spent> tokens · <m>m<s>s`. Exit 0 when completed, 1 when failed.
  If the error mentions "not supported", add the hint `update the Codex CLI: codex update`.
- SIGINT/SIGTERM: forward to the child, mark the job `failed` with error `stopped`.

The collector treats every job file as an Agent (`id` = job id, `kind`, `type` and `executor` =
the job's `provider`, `codex` when the field is missing, `model` = the job's model, `description` =
`label`). A job whose `status` is `running` but whose `pid` is no longer alive is reported as
`stopped`.

## 10b. Web page

`web/index.html`: single self-contained file (inline CSS/JS/SVG, no external requests, works
offline). Consumes `/events` (fallback: poll `/api/snapshot` every 2 s). `?mock=1` loads
`mock-snapshot.json` and animates it (tokens grow, statuses advance) for demos. `mock-snapshot.json`
must validate against section 7 and contain 2 sessions (two projects), one with a board of 7 tasks
across codex/sonnet/haiku including a rework and a failed attempt. An escalation goes to Codex
(`gpt-6.1-sol`), never to Opus, because Opus is never a hand.

---

# Part 2: shared memory, worktrees, hierarchy

The flow becomes: orchestrator (Opus) → agents (Codex / Sonnet) → optional sub-agents (Codex
only, one level) → reviewer (Opus) who merges accepted work into an integration branch and
finally lands it in the user's working tree. Agents look things up in the shared memory before
reading or searching code, and write useful findings back, so the next agent does not pay
for the same exploration again.

Ownership for part 2 (in addition to section 1):
```
plugins/orchestra/lib/kb.mjs            K (Codex)
plugins/orchestra/scripts/kb.mjs        K
test/kb.test.mjs                        K
plugins/orchestra/lib/git.mjs           W (Codex)
plugins/orchestra/scripts/worktree.mjs  W
test/worktree.test.mjs                  W
lib/collect.mjs, lib/render.mjs, scripts/board.mjs, hud/*   H (Codex), test/hierarchy.test.mjs
scripts/codex-task.mjs                  C (Codex), test/codex-task2.test.mjs
web/index.html, web/mock-snapshot.json  D (Sonnet designer)
skills/orchestrate/SKILL.md, docs/CONTRACT.md   OPUS
```
`test/index.mjs` imports every test file into one process: never mutate `process.env` or
`process.cwd()` at module level in a test; pass env explicitly to child processes.

## 12. Shared memory (`lib/kb.mjs`, `scripts/kb.mjs`)

Location. `projectRoot(cwd)`: inside git, the parent of
`git rev-parse --path-format=absolute --git-common-dir` (so every worktree of a repo shares one
memory); otherwise `canonicalPath(cwd)`. Database:
`<orchestraHome>/kb/<projectSlug(projectRoot)>.sqlite`, opened with `node:sqlite`
(`DatabaseSync`), `journal_mode=DELETE` (read-only opens must work), `busy_timeout=3000`.
Silence Node's SQLite ExperimentalWarning so CLI output stays clean.

Schema. Table `notes`: `id` integer pk, `kind` (context | file | symbol | fact | command |
gotcha | decision), `title`, `body` (≤ 2000 chars; longer → error), `paths` (JSON array of
repo-relative paths), `refs` (JSON `{path: sha1}` of those files at write time), `author`
(e.g. `sonnet #2`, `codex #1`, `opus`), `task_id`, `created_at`, `updated_at`, `hits`,
`saved_tokens`. FTS5 table over `title, body, paths, terms` with
`tokenize='unicode61 remove_diacritics 2'`; `terms` = identifiers from title/body/paths split on
camelCase, snake_case, `.`, `/`, `-`, plus the originals, lowercased.

Upsert. Same `kind` + normalized title (lowercase, collapsed whitespace) + same set of paths →
update body/refs/author/updated_at instead of inserting.

Freshness. `refs` are hashed relative to the writer's repo root (`git rev-parse --show-toplevel`
of its cwd, else cwd). On search, hash the same paths under the searcher's repo root; a note is
`stale` if any ref is missing or differs. Stale notes rank after fresh ones and are labelled.

Token accounting. Each fresh note returned by `search` adds 1 to `hits` and
`max(200, Σ size(referenced files)/4)`, capped at 8000, to `saved_tokens`: an estimate of the
reading it spared. Stale notes earn nothing.

API:
```js
export function projectRoot(cwd)
export function kbPath(cwd)
export function openKb(cwd, { readOnly = false } = {})   // returns null in readOnly mode when the DB does not exist
kb.add({ kind, title, body, paths = [], author = null, taskId = null })  // -> { id, updated }
kb.search(query, { limit = 5, kind, path, cwd })   // -> [{ id, kind, title, body, paths, author, taskId, updatedAt, stale, score }]
kb.context({ limit = 8, cwd })     // kind=context first, then most-hit decision/command/gotcha notes
kb.stats()                          // -> { notes, hits, savedTokens, recent: [{ id, kind, title, author, taskId, stale, updatedAt }] (≤ 8, newest first) }
kb.get(id); kb.list({ recent = 20 }); kb.prune({ stale: true, cwd })
kb.close()
```
CLI `scripts/kb.mjs [--cwd dir]` (English messages, exit 1 on errors):
```
search "<query>" [--limit N] [--kind k] [--path p] [--json]
add --kind k --title "<t>" [--paths a,b] [--task id] [--author name] [--body "<text>"]   (body from stdin if --body absent)
context [--json]
get <id> | list [--recent N] | stats [--json] | prune --stale
```
`search` must still work when the DB is not writable (e.g. inside a Codex sandbox): fall back to
a read-only open and skip hit counting. Compact plain output, at most 300 body chars per hit:
```
[12] file · core.py: task sorting  (tasklist/core.py) · sonnet #2 · 5 min ✓
     sort_tasks(tasks) sorts by (done, due); tasks without a due date…
```
Stale hits end with `stale` instead of `✓`. Nothing found → `Nothing found`.

## 13. Worktrees and landing (`lib/git.mjs`, `scripts/worktree.mjs`)

All agent work happens in git worktrees under `<projectRoot>/.orchestra/worktrees/`; `.orchestra/`
is added to `.git/info/exclude` (never to `.gitignore`). Branch names:
`orchestra/<slug>/<id>`, where `<slug>` is a short slug of the board title plus a 4-char random
suffix fixed at `init`. The integration branch is `orchestra/<slug>/main` with worktree
`.orchestra/worktrees/_main`.

CLI `scripts/worktree.mjs [--cwd dir]`, English messages, prints paths/results on stdout:
```
init [--allow-dirty]       create the integration branch from HEAD and its worktree. If the user's tree has
                           uncommitted changes: exit 2 with a message listing them (they would not be in
                           the agents' base) unless --allow-dirty.
create <id> [--from <id>]  branch + worktree for task <id> from the integration tip (or from task <from>'s
                           branch tip, for a sub-task). Prints the worktree path. Idempotent.
path <id>                  print the worktree path
diff <id> [--stat]         diff of the task worktree (committed + uncommitted + untracked) against the
                           commit it was created from
refresh <id>               merge the integration tip (or the parent task's tip) into the task branch;
                           on conflict leave the conflict in the worktree, exit 2, list the files
accept <id> [--into <id>]  commit pending changes in the task worktree ("#<id> <title>"), then merge
                           --no-ff into the integration branch (or into the parent task's branch for a
                           sub-task). On conflict: abort the merge, exit 2, list conflicting files.
                           On success update the board (`board meta <id> merged=true`).
land                       in the user's working tree: `git merge --squash <integration>` (changes staged,
                           nothing committed). Refuse with exit 2 if the user's tree has uncommitted
                           changes in files the merge touches. Then `board integration landedAt=<ISO>`.
cleanup [--force]          remove all task and integration worktrees and branches of this board
                           (refuse if a task worktree has unmerged changes, unless --force)
status [--json]            per task: branch, worktree, ahead/behind, dirty, merged
```
Board fields written via the board CLI only (section 14): task `branch`, `worktree`, `merged`;
board `integration { branch, worktree, base, landedAt }`. Agents never commit on the user's
branch; commits happen only on `orchestra/*` branches.

## 14. Task hierarchy and board additions (`scripts/board.mjs`, render, collect)

Task ids may be dotted: `2.1` is a sub-task of `2` (one level only; `2.1.1` is rejected).
`board add 2.1 "<title>" --exec codex` requires task `2` to exist; `parent` is derived from the
id. New commands:
```
board meta <id> key=value…           keys: branch, worktree, merged (true|false)
board integration key=value…         keys: branch, worktree, base, landedAt
```
Render: sub-tasks are printed right after their parent, indented: `│  ╰─ ◐ #2.1 …`; parent token
totals do not include children. Header counts include sub-tasks. A merged task shows `merged`
when it has no note. When `integration.landedAt` is set, the header shows `· landed`.

Snapshot additions (section 7): `Task.parentId: string | null`, `Task.branch: string | null`,
`Task.merged: boolean`; `board.integration: { branch, worktree, base, landedAt } | null`;
`Session.kb: { notes, hits, savedTokens, recent: [...] } | null` from `kb.stats()` of the
session's project root, opened read-only (the collector never creates a database).
Codex jobs whose `cwd` is inside the session's project root (for example
`.orchestra/worktrees/*`) belong to that session. Status line header appends
`· memory 34 · ≈18k saved` when the session has a memory.

## 15. Codex runner additions (`scripts/codex-task.mjs`, round 3)

- `--detach`: start the job, print the job id, exit 0 immediately; the job keeps running.
  `codex-task.mjs wait <jobId> [--timeout 540]` blocks until the job ends or the timeout, then
  prints the same final output and footer; exit 0 completed, 1 failed, 3 timeout (job still
  running; call `wait` again). This lets a Sonnet agent run a Codex sub-agent within its 10-minute
  Bash limit.
- Memory before work: before spawning Codex, open the memory for `--cwd` and prepend to the
  prompt a section `## Project memory` with `kb.context()` and `kb.search(<task title>)` (top 5,
  compact format). Skip silently when there is no memory.
- Memory after work: append to the prompt a short instruction to end the final answer with a
  section `## Findings` of lines `- [kind] title | path1,path2 | text`. After the job, parse that
  section and `kb.add` each line with `author: "codex #<id>"` and the task id. Malformed lines
  are skipped. The footer gains `· to memory: N`.

---

# Part 3: English only

All user-facing text is English: CLI messages and errors, the ASCII board, both status lines,
the web page, skills, README, manifests, test expectations. No Russian strings remain anywhere in
the plugin. Keep the wording below exactly, so every surface uses the same words.

## 16. Glossary

| Concept | Text |
|---|---|
| task status queued / running / review / rework / done / failed | `queued` / `running` / `review` / `rework` / `done` / `failed` |
| agent finished / failed / stopped | `finished` / `failed` / `stopped` |
| task merged into the integration branch | `merged` |
| integration landed in the working tree | `landed` (web: `landed in working tree`) |
| waiting on dependencies | `waits on #1, #2` |
| attempts on a done task | `done · 2 attempts` |
| board counts line | `tasks  ✓ 3 done   ◐ 2 running   ◑ 1 review   ○ 1 queued   ✗ 1 failed` (rework tasks count as running) |
| header memory part | `· memory 34 · ≈18k saved` (short form `· memory 34 · ≈18k`) |
| header landed part | `· landed` |
| tokens | `tokens`, numbers `512`, `18.2k`, `1.4M` |
| relative time (kb CLI) | `just now`, `5 min`, `2 h`, `3 d` |
| stale memory note | `stale` |
| empty search | `Nothing found` |
| kb stats | `Notes: 3 · hits: 2 · ≈400 tokens saved` |
| kb add result | `[12] added` / `[12] updated` |
| Codex activity | `Bash <cmd>`, `editing <file>`, `answering`, `thinking` |
| Codex footer | `[codex] #2 done · 12.3k tokens · 1m2s · to memory: 2` (`failed` on failure) |
| Codex prompt sections | `## Project memory` (prefix), `## Findings` (requested at the end) |
| error prefix | `Error: <message>` |
| executor names | `Opus`, `Codex`, `Sonnet`, `Haiku`, `Fable`, `Other` |
| web: page | `Sessions`, `N active projects · M sessions · Σ X tokens`, `Tasks`, `Agents`, `Other sessions · N`, `Project memory: N notes · M hits · ≈X tokens saved`, `orchestrator`, `no git`, `live`, `demo · simulated data`, `Collapse` |
| model on a task row | `<model>[@<effort>]` with a leading `gpt-` or `claude-` and a trailing `-YYYYMMDD` removed: `6.1-sol@high`, `sonnet` |
| attempt outcome | `accepted` / `rework` / `failed` |
| provider close to its limit (routing) | `low limit` |
| model without public scores | `no public data` |
| model that never gets a task | `disabled: no sandbox` (Kimi), `disabled: allowFable is false` (Fable) |

The findings parser accepts `## Findings` (and still `## Находки`, so older runs keep working);
everything the plugin itself prints or asks for is English.

---

# Part 4: executor routing

Opus is the brain and the reviewer; every other model is a hand. The plugin finds the models the
user can use, records what each costs and how well it does each kind of task, and gives Opus a
short ranking before it splits a task. Opus decides; the plugin supplies information. Design:
`docs/superpowers/specs/2026-10-29-executor-routing-design.md`.

```
plugins/orchestra/lib/catalog.mjs         model catalog store                       section 17
plugins/orchestra/lib/limits.mjs          limit windows                             section 17
plugins/orchestra/lib/discover.mjs        discovery and access probes               section 18
plugins/orchestra/lib/benchmarks.mjs      public benchmarks, name matching          section 18
plugins/orchestra/lib/bench.mjs           own benchmark                             section 19
plugins/orchestra/lib/route.mjs           score, cost class, ladder                 section 20
plugins/orchestra/lib/runner.mjs          shared runner behind codex-task.mjs       sections 11 and 15
plugins/orchestra/scripts/models.mjs      CLI for all of the above
plugins/orchestra/data/model-aliases.json public name aliases, model and provider cost classes
plugins/orchestra/bench/<fixture>/        six fixture repositories                  section 19
```

## 17. Model catalog, limits and configuration

**Catalog.** `catalogPath()` = `<orchestraHome>/models.json`, one entry per provider and model:

```json
{
  "version": 1, "updatedAt": "ISO", "discoveredAt": "ISO|null", "benchmarksAt": "ISO|null",
  "models": {
    "codex:gpt-5.6-terra": {
      "id": "codex:gpt-5.6-terra", "provider": "codex", "model": "gpt-5.6-terra",
      "runner": "codex-task.mjs", "efforts": ["low", "medium", "high", "xhigh"],
      "description": "…", "access": "", "notes": "first seen 2026-10-29",
      "available": { "ok": true, "probed": true, "checkedAt": "ISO" },
      "public": { "source": "artificialanalysis.ai", "date": "2026-10-28", "codingIndex": 61.2,
                  "livecodebench": 78.0, "outputTokensPerSecond": 140,
                  "price": { "input": 1.25, "output": 10.0, "unit": "USD per 1M tokens" } },
      "own": { "date": "2026-10-29", "partial": false, "overCap": false,
               "completed": ["bug", "logic", "refactor", "tests", "docs", "multi"],
               "byType": { "bug": { "passed": 1, "total": 1, "tokens": 18200, "seconds": 41 } } }
    }
  }
}
```
- `id` is `<provider>:<model>`. `provider`: claude | codex | gemini | kimi.
- `model` is what the runner gets: a Claude alias (`haiku`, `sonnet`, `fable`), a Codex slug, a Gemini model or `default`, or Kimi's `default`. Claude entries also carry `resolved`, the concrete model id seen in recent transcripts (or null).
- `runner`: `Agent` (Claude), `codex-task.mjs`, `gemini-task.mjs`, `kimi-task.mjs`. `efforts`: the levels the CLI reports; empty for Claude.
- `available`: `{ ok, error?, probed, checkedAt }`. `probed` is true when a real model request was made. An unavailable entry stays in the catalog with its error.
- `public`: `null` before the first refresh; `{ source: null, note: "no public data" }` for a model nothing matched. Otherwise the figures of one source: `codingIndex`, `livecodebench`, `outputTokensPerSecond`, `price` (Artificial Analysis, source `artificialanalysis.ai`) or `swebench`, `terminalbench`, `livecodebench` (BenchLM, source `benchlm.ai`). `livecodebench` is a percentage (0 to 100) from either source. Every public figure carries its `source` and `date`.
- `own`: `null` (never benchmarked), `{ skipped: "not picked", date }`, or a result (section 19).
- `access` is free text, empty unless set by hand. `notes` starts with `first seen <date>`.

**Reading and writing.** `readCatalog()` returns an empty catalog when the file does not exist.
`updateCatalog(mutator)` reads, lets a synchronous `mutator` change the object, and writes it
atomically; callers in several processes are serialized, so no update is lost. The lock is
`models.json.lock`, created exclusively and holding an owner token. A lock older than 10 s counts
as abandoned; a waiter gives up after 2 s with `Model catalog is locked by another process`. A
mutator that returns a promise is rejected, so probes, fetches and model runs happen before the call.

**Limits.** `lib/limits.mjs`:
- Claude: `hud/statusline.mjs` hands the `rate_limits` of its stdin to `recordClaudeLimits`, which writes `limitsPath()` = `<orchestraHome>/limits.json` as `{ "claude": <raw rate_limits>, "recordedAt": "ISO" }` at most once a minute. Windows: `five_hour` → `5h`, `seven_day` → `7d`; the percentage comes from `used_percentage`, `used_percent` or `utilization`, the reset time from `resets_at` (epoch seconds or ISO).
- Codex: the last `token_count` event with `rate_limits` in the newest `<codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl`. `primary` and `secondary` are named by `window_minutes`: 300 → `5h`, 10080 → `week`.
- `readLimits()` returns `{ claude, codex, gemini: null, kimi: null }`. Each value is `null` (unknown, never read as zero use) or `[{ name, usedPercent, resetsAt }]`. A window whose `resetsAt` has passed counts as 0%. `maxUsedPercent(limits, provider)` is the highest percentage or `null`.
- Thresholds: above 90% the provider is `low limit` in routing (section 20); above 70% an automatic benchmark is postponed (section 19).

**Configuration** (`orchestraConfig()`, `<orchestraHome>/config.json`):

| Key | Type | Meaning |
|---|---|---|
| `chain`, `chainOriginal` | string | the user's previous status line command (`install-hud.mjs`) |
| `codexModel` | string | Codex model when a run passes no `--model` (section 11) |
| `allowFable` | boolean | Fable is discovered and may be a hand only when `true`; default off because it costs more |
| `artificialAnalysisKey` | string | Artificial Analysis API key; the environment variable `ORCHESTRA_AA_KEY` wins |
| `benchAuto` | boolean | allows `models.mjs bench --new`; set by `/orchestra:setup` |

**Files under `<orchestraHome>`:**

| Path | Written by | Content |
|---|---|---|
| `models.json`, `models.json.lock` | discover, benchmarks, bench | the catalog and its lock |
| `limits.json` | the status line | Claude limit windows |
| `jobs/<jobId>.json` | runners | job records, `provider` field (section 11) |
| `codex-jobs/` | nothing | legacy job records, read only |
| `bench.lock` | `bench` | `{ "pid": 123, "startedAt": "ISO" }` while a benchmark runs |
| `boards/`, `kb/`, `cache/`, `lib/`, `hud/`, `data/` | as before | sections 5, 12, 7 and 2 |

## 18. Discovery and public benchmarks

```
models.mjs discover [--force]
models.mjs benchmarks [--force]
```
Errors go to stderr as `Error: <message>` with exit code 1.

**Discovery.** `discover` skips itself when `discoveredAt` is under 24 hours old, unless `--force`.
It builds a candidate list per provider, probes access one model at a time (each probe is one
short request with stdin closed and a 30 s timeout) and merges only the fields it owns, so
benchmark data survives. It prints `added: <ids>` and `unavailable: <ids>`. Nothing local starts:
discovery reads files and sends at most one tiny request per model.

| Provider | Listed from | Access check |
|---|---|---|
| Claude | aliases `haiku` and `sonnet`, plus `fable` only with `allowFable: true`. `opus` is never listed. `resolved` is the newest `message.model` containing the alias in Claude transcripts changed in the last 7 days | none, always `ok` |
| Codex | `codex debug models` (JSON), only entries with `visibility: "list"`; efforts from `supported_reasoning_levels`. `~/.codex/models_cache.json` is not used, because an old app-server process can leave it stale | `codex exec -m <model> -s read-only --skip-git-repo-check "Reply OK"` |
| Gemini | `default` (the CLI's own default) plus up to three `gemini-*` catalog entries that already have public data, newest first; on a first run that is `default` alone | `gemini [-m <model>] -p "Reply OK"`; skipped with `missing ~/.gemini/oauth_creds.json` when that file is absent |
| Kimi | one entry, `default` | never probed; always `ok: false` with `disabled: no sandbox` |

- A Codex model that passed its probe is not probed again until its listing changes. A failed probe, and every Gemini probe, repeats after 24 hours. `--force` does not re-probe a reusable result.
- A Codex model that disappears from the list becomes unavailable with `not listed by codex debug models`. When `codex debug models` itself fails, every known Codex entry becomes unavailable with the error text.
- With `allowFable` off, an existing `claude:fable` entry becomes unavailable with `disabled: allowFable is false`.
- **Gemini has no runner.** `gemini-task.mjs` is deferred: the Gemini CLI rejects this account type (`IneligibleTierError`, it asks to migrate to Antigravity), so a runner cannot be verified. Gemini stays in the catalog with the probe's error. Only providers with a runner (codex, claude) are ranked or listed as untested, so Gemini never appears in `brief` and no task goes to it.
- **Kimi gets no task.** Its headless `--print` mode approves every command on the whole machine. It becomes a hand only when it offers a sandbox and gets a runner.
- Not used: opencode (same OpenAI account as Codex), llama.cpp and any local model, DeepSeek.

**Public benchmarks.** `benchmarks` refreshes when forced, when `benchmarksAt` is over a week
old, or when a catalog entry has no `public` value (a new model). Each source is fetched once per
refresh, outside the catalog lock, with a 15 s timeout. It prints `matched:`, `unmatched:` and
`source:` lines; warnings go to stderr as `Warning: <text>`.
- **Artificial Analysis:** `GET https://artificialanalysis.ai/api/v2/data/llms/models` with header `x-api-key`. The key is `ORCHESTRA_AA_KEY` or `artificialAnalysisKey`; without one the source is skipped with the warning `no Artificial Analysis key`. Fields: `evaluations.artificial_analysis_coding_index` → `codingIndex`, `evaluations.livecodebench` → `livecodebench`, `median_output_tokens_per_second` → `outputTokensPerSecond`, `pricing.price_1m_input_tokens` and `price_1m_output_tokens` → `price`. A per-evaluation value of 1 or less is a fraction and is stored ×100 (`0.717` becomes 71.7), so `livecodebench` is a percentage from both sources; the coding index is already 0 to 100. A name loses one trailing parenthesized qualifier before matching (`GPT-5 (high)` becomes `GPT-5`) and is also tried against the `slug`; of several rows that map to the same model, the one with the highest coding index wins. No live response has been recorded yet: the parser has only run against a synthetic fixture. The free tier allows 1000 requests a day; one refresh uses one. **Attribution is required**: the README and the web page link https://artificialanalysis.ai.
- **BenchLM:** the tables "SWE-bench Verified", "Terminal-Bench 2.0" and "LiveCodeBench" in the README of the mirror `leoncuhk/awesome-llm-bench` (`https://raw.githubusercontent.com/leoncuhk/awesome-llm-bench/main/README.md`), no key. Fields `swebench`, `terminalbench` and `livecodebench`, in percent, source `benchlm.ai`. SWE-bench and Terminal-Bench are required for a valid response; a missing or malformed LiveCodeBench table is skipped. It fills models Artificial Analysis does not cover and is the only source without a key, but the mirror lists only the top 10 models per benchmark. In a live run it held no coding score for any discovered model, so the free Artificial Analysis key and the own benchmark (section 19) are what give routing its evidence. A row name loses one trailing parenthesized qualifier before matching (`GPT-6.1 Sol (Max)` becomes `GPT-6.1 Sol`; a name that is only brackets stays unmatched), and of several rows that map to the same model and metric the highest score is kept.
- Where both sources know a model, Artificial Analysis wins and BenchLM adds nothing.
- **Matching.** Public names and catalog names are lowercased, a leading vendor or executor prefix is removed, and spaces and dots become `-`. A public name matches an entry only when it equals the `id`, `model` or `resolved` of exactly one entry; otherwise `data/model-aliases.json` is consulted. There is no fuzzy matching. An unmatched entry gets `{ source: null, note: "no public data" }`.
- **Failures.** A failed or keyless source never replaces or re-dates the last good figures of an entry, and a failed refresh does not set `benchmarksAt`, so the next run retries.

`data/model-aliases.json`:
```json
{ "aliases": { "sonnet-5-5": "claude-sonnet-5-5" },
  "modelCostClasses": { "claude:haiku": "$", "claude:sonnet": "$$", "claude:fable": "$$$" },
  "providerCostClasses": { "claude": "$$", "codex": "$$$", "gemini": "$", "kimi": "$$" } }
```
`aliases` maps a public name to a catalog name (used by `benchmarks`). `modelCostClasses` and
`providerCostClasses` give the cost class of a model that has no price (section 20): the model's
entry is checked first, then its provider's. All three are read lazily, and a missing or malformed
file counts as empty.

## 19. Own benchmark (`lib/bench.mjs`, `bench/`)

**Fixtures.** `bench/<name>/` holds `brief.md`, `check.mjs` and `repo/` for `bug`, `logic`,
`refactor`, `tests`, `docs` and `multi`. The brief starts with `#B-<name> <title>`. `check.mjs`
never enters the model's folder; it takes the folder as an argument and exits 0 when the work is
right. `multi` is a multi-file change and counts as a second `refactor` sample, so a finished
model has `byType.refactor.total` 2. `search` has no fixture: it relies on public data and history.

**A task.** Copy `repo/` into a fresh temporary folder, run `git init`, run the model there with
the brief on stdin, run `check.mjs` (10 s), delete the folder. The score of a fixture is
`{ passed: 0|1, total: 1, tokens, seconds }`. The folder is named `orchestra-bench-*`; sessions run
in it are hidden from the web graph.
- Codex: `node scripts/codex-task.mjs --cwd <dir> --model <m> [--effort <e>] --write`; tokens from the footer line.
- Claude: `claude -p --model <alias> --output-format json --permission-mode acceptEdits --allowedTools "Read Edit Write Glob Grep Bash(node:*)"` (headless edits are denied without the permission flags); tokens are input, cache-creation and output tokens from the JSON `usage`.
- Gemini and Kimi do not run. Only entries with `available.ok` run.
- A runner error stops that model's run and is not scored as a model failure: the result is partial with the reason `runner error: <message>`. A `check.mjs` killed by its 10 s limit is a runner error too (`runner error: check timed out`), not a failure.

**Limits.** At most 150000 tokens per model run, checked between tasks, so one task can overshoot;
`overCap` is `true` when the total went over. Each task has a 10-minute timeout. Fixtures run in
the order bug, logic, refactor, tests, docs, multi. One run at a time: `<orchestraHome>/bench.lock`
is created exclusively with `{ pid, startedAt }`; a lock whose process is gone is taken over;
otherwise `bench already running (pid N)` is printed and the exit code is 0.

**Result.** `own` = `{ date, partial, overCap, byType, completed, runnerTokens? }`. `partial` is
`false` or `{ reason }` with `token cap`, `board active`, `low limit` or `runner error:
<message>`. Partial results are kept. `runnerTokens` appears only when runs that ended in a runner
error spent tokens; they count toward the cap but belong to no fixture.

```
models.mjs bench --estimate         one line per available Claude and Codex model: "<id>: 150000 tokens per model (budget estimate)"
models.mjs bench --models a,b       run the named models now; a bare name, or provider:model when the name is ambiguous
models.mjs bench --skip a,b         own = { skipped: "not picked", date } unless the entry already has per-type results (`byType` not empty), which are kept; any other entry, a partial result after a runner error included, becomes skipped
models.mjs bench --new              automatic run, see below
```
`--skip` and `--models` may be combined, but a model cannot be in both. `--estimate` takes no
`--skip`; `--new` takes no `--models`. Output lines: `<id>: done`, `<id>: partial (<reason>)`,
`<id>: skipped (not picked)`, `<id>: kept (already benchmarked)`.

**Automatic runs.** `bench --new` does nothing unless `benchAuto` is `true`. It runs only entries
whose `own` is `null` or a partial result that stopped for `board active`, `low limit` or a
runner error (it resumes at the fixtures not yet completed), and never an entry the user skipped.
Before every fixture it checks two conditions. When one holds the run is postponed: it stops with
that reason in `partial.reason`, and the next `bench --new` picks up where it left off.
- `board active`: a board file in `boards/` is not finished and was updated in the last 30 minutes;
- `low limit`: the provider is above 70% of any limit window.

Nothing starts `bench --new` by itself: the orchestrate skill starts it in the background as the
last command of a run, after `board finish`. While a board is active the run is postponed, so it
does not compete with an orchestration.

**Setup.** `/orchestra:setup` runs `discover --force`; asks for the optional Artificial Analysis
key and stores it as `artificialAnalysisKey`; runs `benchmarks --force`; shows `bench --estimate`;
lets the user pick models (none is fine). It then makes ONE `bench` call, so that a second call
never meets `bench.lock` and loses the skip list: `bench --models <picked> --skip <the rest>`, in
the background. The skip list is written before the first run. `--models` is left out when nothing
was picked and `--skip` when everything was; an empty list is an error. When nothing was picked,
`bench --skip <all>` runs alone, in the foreground, and starts no run. When the estimate lists no
model there is nothing to run or skip, and no call is made. A model in `<the rest>` that already
has per-type results is kept by `--skip`; one with only a runner error is marked skipped. After the call ends, setup sets `benchAuto: true`. The first
benchmark therefore runs only with consent and after the estimate.

## 20. Routing (`lib/route.mjs`, `models.mjs brief`, board attempts)

**Task types.** `TASK_TYPES` in `lib/catalog.mjs`: `bug` (crash, wrong result, failing test),
`logic` (new non-trivial behavior, algorithms, data handling), `refactor` (restructure without
changing behavior, multi-file moves), `tests` (tests that follow an existing pattern), `docs`
(README, comments, text), `search` (find where something lives, explain code; read-only). Every
subtask has exactly one.

**Candidates.** Catalog entries with `available.ok` and a provider with a runner (`codex` or
`claude`), except any Opus entry and Fable unless `allowFable` is `true`. Gemini and Kimi are
filtered by provider, so they are never ranked or listed. A candidate has *evidence* for a type
when it has a public value on the ladder's primary metric, or pooled own and history n of at
least 1 for that type. Only candidates with evidence take part in rungs, the best score and the
85% bar; the others are *untested* for that type (`untested(type, catalog, limits, history)` in
`lib/route.mjs` returns their ids), except a model the user skipped (`own.skipped`), which is
never listed as untested. The primary metric and the neutral prior are still computed
over all candidates, tested or not.

**Score** (0 to 100, per model and task type):
1. *Prior.* One public metric per ladder: the one that most candidates have among `codingIndex` (Artificial Analysis), `swebench`, `terminalbench`, `livecodebench`; ties go in that order. A model without it gets the median of the other candidates' values, or 50 if none has one.
2. *Evidence.* The own benchmark (`own.byType[type]`, passed of total) and the board history (`history()` in `lib/collect.mjs`) pool into n tasks.
3. *History.* With history of at least 5 tasks of that type, the history's first-try rate is the score.
4. *Otherwise* `w = n / (n + 4)` and `score = (1 - w) * prior + w * pass rate`, the pass rate being the pooled passes over n, as a percentage.

History counts a task once per model: it is a first-try success when that model's first attempt
on the task was accepted. Models are keyed like catalog ids; legacy executors `sonnet`, `haiku`,
`opus` and `fable` count as `claude`.

**Cost class** (`$` to `$$$$`). The Artificial Analysis price blended 3:1 input to output,
`(3 * input + output) / 4` USD per 1M tokens: up to 1 is `$`, up to 5 `$$`, up to 15 `$$$`, above
that `$$$$`. A model without a price takes its class from `modelCostClasses` (`claude:haiku` `$`,
`claude:sonnet` `$$`, `claude:fable` `$$$`) and, when it has no entry there, the provider default
from `providerCostClasses` (claude `$$`, codex `$$$`, gemini `$`, kimi `$$`). Without an
Artificial Analysis key no model has a price, so the class always comes from those two tables.

**Ladder.** Candidates are ordered cheapest first: fewer `$`, then lower price (a representative
price per class when there is none), then higher score, then id. A provider above 90% of any limit
window is `low limit`: still listed, skipped for rung 1.
- Rung 1: the cheapest candidate that scores at least 85% of the best score and is not `low limit`.
- Rung 2: the next candidate that scores at least 5 points higher than rung 1, or sits in a higher cost class (any higher class) and scores at least as much as rung 1.
- Rung 3: the best-scoring candidate. When scores tie, the best is the candidate in the higher cost class, then the one with the higher prior, then the one with the lower id. A rung is left out when no candidate fits it or when the model is already on an earlier rung.
- Three equal own results (say 1/1 for `claude:haiku`, `claude:sonnet` and a Codex model) therefore give three rungs, cheapest first.
- Effort: rung 1 medium, rungs 2 and 3 high, each the nearest level the model supports. When rung 1 is also the best candidate, it runs at `high`. Claude models have no effort.
- Opus starts a subtask at rung 1 unless it is risky. Escalation climbs the rungs. The last step re-runs rung 3 at its top supported effort: the last value of that entry's `efforts` array in `models.json`. A Claude entry has no efforts, so for it the last step is a plain re-run.

**Brief.** `models.mjs brief [--types a,b]` prints at most 20 lines: for each type up to three
rungs (or one `no evidence yet` line), then one `untested:` line when it is not empty, then one
limits line.
```
bug 1. claude:sonnet · 73 · own 2/2 · AA 59 (2026-10-28) · $$
bug 2. codex:gpt-5.6-terra@high · 79 · AA 79 (2026-10-28) · $$
bug 3. codex:gpt-6.1-sol@high · 83 · history 6 tasks, 83% first try · $$$
Limits: claude 41% used/5h, 12% used/7d · codex 8% used/5h, 3% used/week · gemini unknown · kimi unknown
```
Line shape: `<type> <rung>. <provider>:<model>[@<effort>] · <score> · <evidence> · <cost>[ · low limit]`.
Evidence parts: `own <passed>/<total>`, `history <n> tasks, <p>% first try`, and the public metric
as `<source> [<metric> ]<value> (<date>)` with `AA` for Artificial Analysis and `BenchLM`
for BenchLM, or `no public data · neutral prior <n>`, which means the model has no value on the
ladder's primary metric and takes the median of the other candidates. The numbers above are made
up.

A type with no candidate that has evidence prints `<type> no evidence yet`. With no eligible model
at all it prints `<type> no available models`. After the type lines and before `Limits:`, one line
lists the models that are untested for every type shown, each once, with the command that would
test them, and is left out when empty. Skipped models (`own.skipped`) never appear on it:
```
bug no evidence yet
logic no evidence yet
refactor no evidence yet
tests no evidence yet
docs no evidence yet
search no evidence yet
untested: claude:haiku, claude:sonnet, codex:gpt-5.6-terra, codex:gpt-6.1-sol (models.mjs bench --models claude:haiku,claude:sonnet,codex:gpt-5.6-terra,codex:gpt-6.1-sol)
Limits: claude unknown · codex unknown · gemini unknown · kimi unknown
```
That is a catalog with no public data and no benchmark result. Types and models mix: with own
results for `claude:sonnet` on five types and none on `search`, the five types print
`<type> 1. claude:sonnet · 60 · own 1/1 · no public data · neutral prior 50 · $$` (the score
depends on the results), `search` prints `no evidence yet`, and `untested:` lists the three models
without any result.

**Board.** Each task stores its choice and one record per attempt:
```json
{ "id": "2", "title": "export csv/json", "type": "logic", "executor": "claude", "model": "sonnet", "effort": null,
  "status": "done",
  "attempts": [
    { "n": 1, "provider": "claude", "model": "sonnet", "effort": null, "startedAt": "ISO", "endedAt": "ISO", "outcome": "rework", "tokens": 9800 },
    { "n": 2, "provider": "codex", "model": "gpt-6.1-sol", "effort": "high", "startedAt": "ISO", "endedAt": "ISO", "outcome": "accepted", "tokens": 17600 }
  ] }
```
- `board set <id> running` opens attempt `n` (the count so far plus one) with the task's current provider, model and effort, unless one is already open. `done` closes it as `accepted`, `rework` as `rework`, `failed` as `failed`.
- `tokens` of an attempt: the spent tokens of all agents and jobs carrying the task id now, minus the tokens of earlier attempts; `null` when an earlier attempt is `null` or nothing is linked to the task, and a negative difference is stored as `null`. `board set` computes the tokens before it re-reads and writes the board, so concurrent board commands do not lose updates.
- `board exec <id> <provider> --model <m> --effort <e>` changes the task's current hand. Run it after `set rework` and before `set running`, so the failed attempt keeps its own model. It sets `model` and `effort` to null when they are omitted.
- Snapshot additions (section 7): `Task.type`, `Task.model`, `Task.effort`, `Task.attemptCount` (number of attempts) and `Task.attemptList` (the records). A job's `Agent.executor` is its `provider`.
- The status line and the ASCII board show the open attempt's model and effort in place of the executor name (glossary, section 16).

**Orchestrator rules** (`skills/orchestrate/SKILL.md` follows these):
- Opus never writes or edits code. It writes briefs and verdicts. A small fix goes to the cheapest suitable hand.
- Hands: Claude models (`haiku`, `sonnet`, `fable` with `allowFable`) as `Agent` with `model` set to the alias; GPT models through `codex-task.mjs --model --effort`. Opus is never a hand. Gemini and Kimi get no task.
- Step 0: check the session model. The final review is always Opus 5.5. When the session is not Opus 5.5, the skill says that the final review and every accept or rework verdict go to a read-only `Agent` with `model: "opus"`, which gets the full review checklist, scope check first. Then `models.mjs discover` and `benchmarks`, each of which skips itself when nothing is due, and `brief`.
- The plan is a table with the columns `# · task · type · executor · model@effort · why (evidence)`. Every row cites the evidence from `brief`.
- Every agent brief lists the files that may change and a checkable done criterion. A hand that finds a problem outside its scope reports it. The review checks scope first and treats extra changes as rework.
- Sub-agents only when the agent brief allows them and names the sub-agent's model and effort: the cheapest Codex line of `models.mjs brief` for the type of the hard part. With no Codex line, no sub-agent. A hand never picks a model. A sub-agent is always Codex, one level deep.
- Escalation: a rung gets two attempts, the first and one rework. Then the next rung; after rung 3, rung 3 once more at its top supported effort (the last value of the entry's `efforts` array; a plain re-run for a Claude entry); then `failed`. `board exec` takes `--effort` for Codex hands only.
- A type with `no evidence yet`: Opus picks the hand itself from the `untested:` line (skipped models never appear there; with no line, Opus picks among the models other types rank), model and effort by its own judgment, and writes `untested: <reason>` in the plan's why column. At the end of the report it suggests `/orchestra:setup` or the `bench --models` command from that line. Board attempts of that hand become history for the next run.
- Nothing ranked: when `brief` ranks no model for any type and prints no `untested:` line (every model skipped, no Artificial Analysis key), Opus chooses by its own judgment among the available hands in `models.json` (`available.ok`, provider `codex` or `claude`, never `opus`, `fable` only with `allowFable`), writes `no evidence` in the why column and ends the report by suggesting the Artificial Analysis key or `bench --models`.
- Last command of a run, after `board finish`: `models.mjs bench --new` in the background. It does nothing without `benchAuto` or new models.
