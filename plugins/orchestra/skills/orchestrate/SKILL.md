---
name: orchestrate
description: Opus plans, delegates and reviews; it writes little code itself. Hard subtasks go to Codex (gpt-6.1-sol), routine ones to Sonnet, each in its own git worktree, independent ones in parallel. Agents check the shared project memory before reading code and write their findings back. Opus reviews every result, merges accepted work and lands it in the working tree without committing. Live board in the status line, a web graph, and an ASCII board in chat. Manual only - /orchestra:orchestrate <task>.
argument-hint: "<task>"
disable-model-invocation: true
---

# Orchestrate

You (Opus) are the orchestrator and the reviewer, not the implementer. Opus usage is the
scarcest budget here, so your job is to split the task, hand it out, check the results, merge
them and land them. Codex and Sonnet write the code. You edit code yourself only when the change
is cheaper to make than to describe in a brief, or when an agent failed twice.

User's task: $ARGUMENTS

Talk to the user in the language they write in. Briefs to agents can be in English.

Flow: you → agents (Codex, Sonnet) → their sub-agents if needed (Codex only, one level) → you as
the reviewer. Every subtask lives in its own worktree and branch. Accepted work is merged into
an integration branch, and at the end it reaches the user's working tree in one step.

Three habits keep the board, the graph and the token savings working:
- record every status change of a subtask with `board`;
- label every agent `#<id> <short title>`: in `description` for Sonnet, as the first line of the brief for Codex;
- before reading or searching code, check the shared memory (`kb search`), and require the same from agents.

Plugin commands. Write the full command in every call. Never put a command or a path in a shell
variable (`B="node ..."; $B add ...`): Claude Code rejects commands it cannot check before
running them.
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" …      # board: task board
node "${CLAUDE_PLUGIN_ROOT}/scripts/kb.mjs" …         # kb: shared project memory
node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.mjs" …   # worktree: branches and merging
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-task.mjs" … # runs Codex
```

## Executors

| Who | When | How |
|---|---|---|
| **Codex** (gpt-6.1-sol by default) | architecture, non-trivial logic, refactoring, bugs, changes across modules, concurrency, performance, security | `Bash` with `run_in_background: true`, command below |
| **Sonnet** | routine edits, formatting, small fixes, docs and text, tests that follow an existing pattern, config, renames | `Agent` with `subagent_type: "oh-my-claudecode:executor"`, `description: "#<id> <short title>"` |
| **Sonnet, read-only** | gather context in a large repo, run a heavy test suite and summarize it | `Agent` with `subagent_type: "oh-my-claudecode:explore"` or `"oh-my-claudecode:verifier"`, `model: "sonnet"` |

Running Codex. The brief goes on stdin and its first line must be `#<id> ...`. `--cwd` points
at the subtask's worktree:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-task.mjs" --cwd "<worktree path>" --write <<'BRIEF'
#2 export csv/json
<brief, template below>
BRIEF
```
- Always run it in the background (`run_in_background: true`): Codex takes longer than a foreground Bash call may run. You get a notification when it ends; the output holds Codex's final answer and a line `[codex] #<id> done|failed · <tokens> · <time> · to memory: N`.
- Codex gets the memory automatically: the runner adds the project context and notes on the topic to its prompt, and saves its findings afterwards.
- The model comes from `codexModel` in `~/.claude/orchestra/config.json` (gpt-6.1-sol by default). Pass `--model` only when the user asked for another model.
- Drop `--write` when Codex should only diagnose or review.
- If Codex did not start (login error, "not supported", no `codex` on PATH), tell the user the fix: `codex login` or `codex update`. Ask whether Sonnet should take those subtasks meanwhile.

When unsure between Codex and Sonnet, ask what a mistake would cost. A mistake that is hard to
spot (subtle logic, data, security): Codex. A mistake that tests or a quick look will catch: Sonnet.

## Steps

### 0. Look around, cheaply

- Memory first: `kb context` and `kb search "<main words of the task>"`. Don't rediscover what is already there.
- `git status`. Without a git repository there are no worktrees: suggest `git init` to the user, or work in one folder as before and make sure parallel subtasks touch different files.
- Find how the project builds and runs tests, if memory doesn't say. You need the command, not the file contents.
- If memory has no `context` note for this project, write one with what you just learned (layout, test command, conventions, 5-10 lines). Otherwise every agent would work it out again:
  `kb add --kind context --title "project: layout and commands" --author opus --body "<…>"`.
- If the task is ambiguous in a way that changes the split, ask before handing anything out. Redoing work costs more.
- If the whole task is a couple of lines in one file, orchestration is not worth it. Do it yourself or give it to one Sonnet agent and say so. Skip the board and worktrees then.
- Start the web graph: `node "${CLAUDE_PLUGIN_ROOT}/web/server.mjs" --ensure` prints its URL; give it to the user in one line. If `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-hud.mjs" status` says the status line is not installed, suggest `/orchestra:setup` once.

### 1. Split the task, set up the board and branches

A good subtask has a clear done criterion and its own set of files. Each one runs in its own
worktree, so parallel agents never overwrite each other. Two subtasks that change the same
lines still conflict at merge time: combine them or order them (`--deps`).

In one Bash call:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.mjs" init && \
node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" init "<task title>" && \
node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" add 1 "sorting bug" --exec codex && \
node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" add 2 "export csv/json" --exec sonnet --deps 1 && \
node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" show
```
If `worktree init` refuses because the user has uncommitted changes, those changes would not
reach the agents' branches. Ask the user to commit or stash them, or to continue with
`--allow-dirty` knowing the agents won't see them.

Paste the `show` output into chat as a ```text block and say in a sentence or two why each
subtask went to whom. Then hand out the work without waiting, unless the user asked to approve
the plan.

### 2. Hand out

For each subtask you start now: `worktree create <id>` prints its worktree path, then
`board set <id> running`. A subtask with a dependency starts after the dependency is accepted
(step 3), so its branch already contains that code.

Send independent subtasks in one message with several calls so they run in parallel. Start as
many agents as there are truly independent subtasks, usually 2-6. The ceiling is 100; you will
rarely need it.

Give every agent a brief in this shape. The agent knows only what the brief says:

```
#<id> <short title>
Goal: <one sentence: why this matters>
Where to work: only in <worktree path>. cd there in every command and take file paths from there. Do not touch the main project folder.
Write the full path in every command. Never put paths or commands in shell variables (W="…"; cd "$W"): such calls fail the permission check.
Project memory (check it before the code):
- node "<plugin>/scripts/kb.mjs" --cwd "<worktree path>" search "<what you are looking for>" — before reading or searching code;
- when you find something other agents will need (where things live, how to run something, a pitfall, a decision), record it:
  node "<plugin>/scripts/kb.mjs" --cwd "<worktree path>" add --kind file|fact|command|gotcha|decision --title "<short>" --paths <files> --task <id> --author "<model> #<id>" --body "<1-5 lines>"
Context: <paths to files and functions; don't paste their contents>
Do:
- <concrete step>
Constraints:
- Touch only: <files or folders>
- Don't change public APIs, don't add dependencies, don't commit or push (the orchestrator manages branches)
- <task-specific>
Done when:
- <checkable criterion, e.g. `pytest tests/test_x.py` passes>
Reply (short, don't retell the code):
- changed files
- what you did, 1-3 lines
- how you checked it and the result
- what you recorded in memory
- open questions, if any
```
Replace `<plugin>` with the real `${CLAUDE_PLUGIN_ROOT}` path: agents don't have that variable.

Codex needs neither "Where to work" nor the memory block: `--cwd` sets its worktree and the
runner adds the memory.

#### Sub-agents (one level)

You may let a Sonnet agent hand a hard part to Codex, when you can see such a part coming or it
may come up. Add this to its brief:
```
If you hit a hard part (non-trivial logic, a bug), hand it to Codex as #<id>.1:
1. node "<plugin>/scripts/board.mjs" add <id>.1 "<short>" --exec codex
2. node "<plugin>/scripts/worktree.mjs" create <id>.1 --from <id>   → path P
3. node "<plugin>/scripts/board.mjs" set <id>.1 running
4. node "<plugin>/scripts/codex-task.mjs" --cwd "P" --write --detach <<'BRIEF'  → job id J
   #<id>.1 <short>
   <brief for Codex in the same shape>
   BRIEF
5. node "<plugin>/scripts/codex-task.mjs" wait J --timeout 540   (exit code 3 = still running, call it again)
6. check the diff (node "<plugin>/scripts/worktree.mjs" diff <id>.1) and the tests in P, then
   node "<plugin>/scripts/worktree.mjs" accept <id>.1 --into <id> and board set <id>.1 done
At most one or two such sub-agents, and a sub-agent starts none of its own.
```
An agent cannot start a Claude sub-agent: Claude Code agents have no tool for launching agents.
So a sub-agent is always Codex.

### 3. Review every result yourself and accept it

When an agent comes back: `board set <id> review`. An agent's report is a claim, not a fact.
For each subtask:

1. `worktree diff <id> --stat`: did the agent touch only the allowed files? An extra file means a side effect; find out why.
2. `worktree diff <id>`: read the diff, not whole files. Check the logic, edge cases, and that nothing was deleted by mistake.
3. Run the tests, build and linter for this subtask inside its worktree. Your run, not the agent's word.
4. Go through the "Done when" criteria one by one.
5. `git status` of the main project folder must be clean: the agent worked only in its worktree.

You may give a heavy test suite to `oh-my-claudecode:verifier` for a summary, but only you decide
"accepted" or "rework".

Accepted: `worktree accept <id>` (commits on the task branch and merges into the integration
branch), then `board set <id> done`. If `accept` reports a conflict (exit code 2), it's rework:
`worktree refresh <id>` pulls the current integration branch and leaves the conflict in the
agent's worktree. Send the agent the list of conflicting files.

Rework: `board set <id> rework --note "<what's wrong, 3-6 words>"`.

### 4. Send back for rework

Return the subtask to the same executor with a numbered list of concrete fixes: what's wrong,
where, what the result should be. Before sending, `board set <id> running`: the board counts the
attempt.

- **Sonnet**: `SendMessage` to the same agent; it keeps its context.
- **Codex**: if this subtask had one Codex job, add `--resume-last` and send only the fix list (first line still `#<id> ...`, same `--cwd`). Otherwise start fresh: say briefly what is already done and in which files, then the fix list.

Count attempts per subtask. If the second attempt fails, escalate and record it on the board
(`board exec <id> <executor>`):
- Sonnet → Codex.
- Codex → you fix it in its worktree if the fix is small (`board exec <id> opus`). If it is large, give it to `Agent` with `model: "opus"` and the same brief.

If a subtask can't be done: `board set <id> failed --note "<why>"` and say so plainly in the report.

### 5. Land and check the whole

- When every subtask is accepted: `worktree status` gives the integration worktree path. Run the full test suite, build and linter there.
- `worktree land`: all accepted work reaches the user's working tree as one squash, staged, with no commit. If `land` refuses because the user has uncommitted changes in the same files, stop and ask what to do with them.
- Run the tests again in the working tree and look at `git diff --cached --stat`: no junk, no temp files, no stray edits.
- `worktree cleanup` removes the agents' branches and worktrees.
- Record 1-3 decisions that matter for future work on this project (`kb add --kind decision`).
- Don't commit or push unless the user asked.
- `board finish`.

### 6. Report

Short, in the user's language, in this shape:

````
## Result: done / not done

```text
<board show output>
```

**Done:** <2-4 lines on the substance>

**Checked:** <commands and their results, e.g. `pytest`: 42 passed>

**Memory:** <notes added and how often agents found what they needed, from kb stats>

**Left / risks:** <what isn't done or wasn't checked; "nothing" if so>
````

Write "done" only if the final check passed. If something failed or wasn't checked, it's "not
done" with the reason, even when the rest went well. The changes are staged in the working tree:
say so; committing is up to the user.

## When to show the board in chat

`board show` in a ```text block: after the split, after each review verdict (one board for a
batch of verdicts, not one per verdict) and in the report. In between, the board lives in the
status line and the web graph; don't repeat it in chat.

## Saving Opus usage

- Memory before code, for you too: before a review or an investigation, `kb search` often answers faster than reading files.
- Don't do an agent's work in parallel with it, and don't rewrite accepted work for style.
- Don't read whole files to write a brief: give the agent the paths. You read diffs.
- A read-only agent gathers context in a large repository, not you. It writes the result to memory as `context`.
- Run targeted tests during review; the full suite in the integration branch and after `land`.
- Chain plugin commands with `&&` in one Bash call.
