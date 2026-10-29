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
export function codexJobsDir()          // <orchestraHome>/codex-jobs   (written by scripts/codex-task.mjs, section 11)
export function codexStateRoots()       // [<claudeConfigDir>/plugins/data/codex-openai-codex/state,
                                        //  <os.tmpdir()>/codex-companion]  (optional: jobs started via the codex plugin)
export function orchestraConfig()       // parsed <orchestraHome>/config.json or {}  (keys: chain, chainOriginal, codexModel)
```

Install layout: `scripts/install-hud.mjs install` copies `lib/` and `hud/` into
`<orchestraHome>/lib` and `<orchestraHome>/hud`, so `hud/*.mjs` must import siblings only via
relative paths (`../lib/collect.mjs`). Nothing in `lib/` or `hud/` may depend on files outside
those two folders.

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

Codex, primary source: our own job files `<codexJobsDir()>/<jobId>.json` written live by
`scripts/codex-task.mjs` (section 11). They already carry status, activity and tokens.

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
    { "id": "1", "title": "sorting bug", "executor": "codex",
      "status": "running", "attempts": 1, "dependsOn": [], "note": "", "updatedAt": "ISO" }
  ]
}
```
`executor`: codex | sonnet | opus | haiku. `status`: queued | running | review | rework | done | failed.

CLI (cwd = `--cwd <dir>` or `process.cwd()`; several commands may be chained with ` && `):
```
board.mjs init "<title>" [--session <id>]   new board; previous file moved to boards/archive/<slug>-<ts>.json
board.mjs add <id> "<title>" --exec <executor> [--deps 1,2]
board.mjs set <id> <status> [--note "<text>"]   queued|rework -> running increments attempts
board.mjs exec <id> <executor>               reassign (escalation)
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

```
node codex-task.mjs [--cwd <dir>] [--model <m>] [--effort <e>] [--write] [--resume-last] < prompt
```
- Model: `--model`, else `orchestraConfig().codexModel`, else env `ORCHESTRA_CODEX_MODEL`, else `gpt-6.1-sol`.
- The first non-empty stdin line must start with `#<id>`; otherwise exit 1 with an English message.
- Job id `cx-<base36 ms>-<4 random base36>`. Job file `<codexJobsDir()>/<jobId>.json`, atomic writes,
  throttled to at most one write per second plus a final write:
  ```json
  { "version": 1, "id": "cx-…", "taskId": "2", "label": "#2 export csv", "cwd": "/abs (realpath)",
    "model": "gpt-6.1-sol", "effort": null, "write": true, "pid": 123,
    "status": "running|completed|failed", "startedAt": "ISO", "endedAt": null,
    "threadId": null, "activity": "Bash pytest -q",
    "tokens": { "input": 0, "cacheWrite": 0, "cacheRead": 0, "output": 0, "spent": 0 },
    "finalMessage": null, "error": null }
  ```
- Spawn `codex exec --json --skip-git-repo-check -m <model> [-c model_reasoning_effort=<e>]
  -s <workspace-write|read-only> -C <cwd> -` with the prompt on stdin. `--resume-last`: take the
  `threadId` of the newest job in codexJobsDir with the same cwd and use the CLI's resume form of
  `codex exec` (check `codex exec --help` / `codex exec resume --help` for the exact syntax).
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

The collector treats every job file as an Agent (`kind: "codex"`, `id` = job id, `type: "codex"`,
`executor: "codex"`, `description` = `label`). A job whose `status` is `running` but whose `pid` is
no longer alive is reported as `stopped`.

## 10b. Web page

`web/index.html`: single self-contained file (inline CSS/JS/SVG, no external requests, works
offline). Consumes `/events` (fallback: poll `/api/snapshot` every 2 s). `?mock=1` loads
`mock-snapshot.json` and animates it (tokens grow, statuses advance) for demos. `mock-snapshot.json`
must validate against section 7 and contain 2 sessions (two projects), one with a board of 5 tasks
across codex/sonnet/opus including a rework and a failed attempt.

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

The findings parser accepts `## Findings` (and still `## Находки`, so older runs keep working);
everything the plugin itself prints or asks for is English.
