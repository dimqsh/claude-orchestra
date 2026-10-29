# claude-orchestra

A Claude Code plugin where Opus plans the work and reviews the result, Codex (`gpt-6.1-sol`)
takes the hard subtasks and Sonnet takes the easy ones. While the agents run, a live board
shows who is doing what and how many tokens each one has spent, in the Claude Code status
line and in a web graph.

Opus limits are the scarce resource, so Opus only splits the task, hands it out and checks the
results. Codex and Sonnet write the code, each in its own git worktree, and a shared project
memory keeps them from reading the same files twice.

## Requirements

- Claude Code. Agent rows in the status line need 2.1.293 or newer.
- Node 20 or newer, no npm dependencies. The shared memory needs Node 22.13 or newer (built-in `node:sqlite`); on older Node everything else still works.
- A git repository, because every subtask gets a worktree.
- The `oh-my-claudecode` plugin. Installing `orchestra` installs it too.
- Codex CLI 0.165.0 or newer, logged in with `codex login`. The codex plugin is not needed: tasks go straight through `codex exec`.

## Install

In Claude Code:

```
/plugin marketplace add Yeachan-Heo/oh-my-claudecode
/plugin marketplace add dimqsh/claude-orchestra
/plugin install orchestra@claude-orchestra
/orchestra:setup
```

To work on the plugin itself, add your local clone instead: `/plugin marketplace add /path/to/claude-orchestra`.

`/orchestra:setup` checks Node, the plugin, the Codex CLI version and login. It then shows the
planned changes to `~/.claude/settings.json` (`install-hud.mjs install --dry-run`) and, after you
confirm, installs the status line and starts the web graph. A backup is saved next to the file as
`settings.json.orchestra-backup-<timestamp>`. An existing status line of yours stays: its output
comes first and the board is printed below it.

## Usage

```
/orchestra:orchestrate <task>
```

Opus splits the task into subtasks, gives them to Codex and Sonnet, runs independent ones in
parallel, checks every result itself and writes a short report. Each subtask goes on the board
with its executor, status and number of attempts.

```
orchestrator (Opus): splits the task, creates the board and a worktree per subtask
   ▼
agents (Codex / Sonnet): one worktree each, they check the shared memory first
   └─ Codex sub-agents (#2.1), one level deep
   ▼
reviewer (Opus): reads the diff, runs the tests itself, then accepts or sends back for rework
   ▼
land: accepted work is staged in your working tree, not committed
```

```
/orchestra:board
```

Opens the web graph (`http://127.0.0.1:7377/`, bound to 127.0.0.1) and prints the ASCII board
in the chat.

## What the status line shows

```
◆ acme-shop  ⎇ feat/export  ·  Opus 18.2k · Codex 41.7k · Sonnet 14.0k  ·  Σ 73.9k
  tasks  ✓ 1 done   ◐ 2 running   ○ 1 queued
├─ ◐ #1 sort bug              Codex    24.1k   editing cli.py
├─ ✓ #2 export csv/json       Codex    17.6k   done · 2 attempts
├─ ◐ #4 export tests          Sonnet    9.8k   Bash pytest tests/
╰─ ○ #5 docstrings            Sonnet       —   waits on #2
```

- First line: project, branch, tokens per executor and the total. With a project memory it ends in `· memory 34 · ≈18k saved`, and after `land` in `· landed`.
- Below it: the tasks from the board, or the agents when there is no board. Each row has status, executor, tokens and the current activity. Sub-tasks sit under their parent, indented (`│  ╰─ ◐ #4.1 …`). A task merged into the integration branch is marked `merged`.
- Statuses: `○` queued, `◐` running, `◑` review, `↻` rework, `✓` done, `✗` failed.
- Task rows disappear 10 minutes after the board finishes, unless an agent is still running. At most six rows are shown, the rest is a count.
- Tokens do not include cache reads. For Claude that is input, cache writes and output; for Codex it is uncached input plus output.

## Shared memory

`scripts/kb.mjs` keeps notes about the project: files, facts, commands, gotchas, decisions. They
live in a SQLite database under `~/.claude/orchestra/kb/`, one per repository, so all worktrees
of a repo share it.

```
node "<plugin path>/scripts/kb.mjs" search "task sorting"
node "<plugin path>/scripts/kb.mjs" add --kind gotcha --title "..." --paths a.py,b.py --body "..."
node "<plugin path>/scripts/kb.mjs" context     # the main facts about the project
node "<plugin path>/scripts/kb.mjs" stats
```

The agents call `kb.mjs` themselves; `<plugin path>` is explained under "Uninstall".

- An agent searches the memory before reading code and saves what it learned when it finishes.
- A note stores hashes of the files it refers to. When those files change, the note is marked `stale`, ranks after fresh ones and does not count as savings.
- Codex gets the memory automatically: `codex-task.mjs` prepends a `## Project memory` section to its prompt, and the `## Findings` section of its answer is saved back.
- `≈18k saved` in the status line and the graph is an estimate of the file-reading tokens the notes made unnecessary.

## Worktrees and merging

Every subtask works in `<project>/.orchestra/worktrees/` on a branch named
`orchestra/<name>/<id>`. `.orchestra/` is added to `.git/info/exclude`, not to `.gitignore`.
Commits are made only on `orchestra/*` branches; your own branch is never touched. The
`scripts/worktree.mjs` commands:

- `init` creates the integration branch. It refuses if your working tree has uncommitted changes, unless you pass `--allow-dirty`.
- `create <id>` makes the branch and worktree of a subtask; `diff <id>` shows what the agent changed.
- `accept <id>` commits the work and merges it into the integration branch. `refresh <id>` merges the current integration branch into the task branch; a conflict stays in the agent's worktree.
- `land` runs `git merge --squash` in your working tree: the changes are staged, nothing is committed. It refuses if your uncommitted changes touch files the merge changes. You make the commit yourself.
- `cleanup` removes the branches and worktrees (unmerged work only with `--force`). `status` lists branches and what is merged.

## Sub-agents

A Claude Code agent has no tool for starting other agents, so Claude agents never have
sub-agents. The nesting is one level deep and only towards Codex: a Sonnet agent can hand a
piece of its work to Codex as task `#2.1`. `codex-task.mjs --detach` starts the job and prints
its id; `codex-task.mjs wait <id>` waits for the result (exit code 3 means the job is still
running, call `wait` again). That keeps the sub-agent within the 10-minute Bash limit. Opus
reviews sub-tasks like any other task.

## How it works

- The task board is `~/.claude/orchestra/boards/<project>.json`, written by `scripts/board.mjs`.
- Agents are tied to tasks by a `#<id>` label (`#2.1` for a sub-task): at the start of the description for Sonnet, on the first line of the prompt for Codex.
- Tokens and activity come from the Claude Code transcripts (`~/.claude/projects`) and the Codex job files (`~/.claude/orchestra/codex-jobs`). The plugin never modifies the transcripts.
- `install-hud.mjs` copies `lib/` and `hud/` to `~/.claude/orchestra`, so the status line does not depend on the plugin cache path. A session-start hook runs `install-hud.mjs sync` to keep the copy current. `install-hud.mjs status` shows the state.
- Web graph: `node web/server.mjs [--port 7377] [--ensure] [--stop] [--mock]`. Data arrives over SSE (`/events`). `?mock=1` shows a demo without real sessions.

## Troubleshooting

- Codex answers "not supported when using Codex with a ChatGPT account": the Codex CLI is too old for gpt-6.x models. Run `codex update` (0.165.0 or newer, check with `codex --version`).
- To change the Codex model, add `codexModel` to `~/.claude/orchestra/config.json`, for example `{ "codexModel": "gpt-6.1-sol" }` (the default). Leave the other keys alone; installing and uninstalling the HUD keeps them.
- Strict permission settings: the agents need Bash for `node` (memory, board) and for your project's test command, for example `Bash(node:*)` and `Bash(pytest:*)` in `permissions.allow`. Agents must write commands with full paths and no shell variables, otherwise the permission may not match.
- Memory fails or `kb.mjs` crashes: check `node --version`; the memory needs 22.13 or newer.
- No board in the status line: run `/orchestra:setup` (or `install-hud.mjs status`). Per-agent rows need Claude Code 2.1.293 or newer (`claude --version`, `claude update`).

## Uninstall

1. Restore your previous status line:
   ```
   node "<plugin path>/scripts/install-hud.mjs" uninstall
   ```
   The plugin path is `~/.claude/plugins/cache/claude-orchestra/orchestra/<version>`, or `plugins/orchestra` in this repository. Files in `~/.claude/orchestra` stay; delete them by hand if you do not need them.
2. If agent branches and worktrees are left, run `node "<plugin path>/scripts/worktree.mjs" cleanup` in the project. Delete the memory in `~/.claude/orchestra/kb/` by hand if you do not need it.
3. Stop the graph: `node "<plugin path>/web/server.mjs" --stop`.
4. Remove the plugin: `/plugin uninstall orchestra@claude-orchestra`.
5. Remove dependencies nothing else uses: `claude plugin prune`.

## Development

```
node --test test/
claude plugin validate . && claude plugin validate plugins/orchestra
```

Tests use temporary `CLAUDE_CONFIG_DIR` and `ORCHESTRA_HOME` and never touch the real `~/.claude`.
The module contract is `docs/CONTRACT.md`.
