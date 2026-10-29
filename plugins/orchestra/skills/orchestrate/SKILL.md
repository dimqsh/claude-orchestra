---
name: orchestrate
description: Opus plans, delegates and reviews; it never edits code. Each subtask gets a type and the cheapest model that scores well enough for it, read from the model catalog (Claude agents and Codex), in its own git worktree, independent ones in parallel. Failed work climbs to a stronger model. Agents check the shared project memory before reading code and write their findings back. Opus 5.5 reviews every result, merges accepted work and lands it in the working tree without committing. Live board in the status line, a web graph, and an ASCII board in chat. Manual only - /orchestra:orchestrate <task>.
argument-hint: "<task>"
disable-model-invocation: true
---

# Orchestrate

You (Opus) are the orchestrator and the reviewer, not the implementer. Opus usage is the
scarcest budget here, so your job is to split the task, pick a hand for each subtask, check the
results, merge them and land them. A hand is the model that writes the code. You never write or
edit code, not even one line: a small fix goes to the cheapest hand that can do it, and a hand
that fails gets replaced by a stronger one.

User's task: $ARGUMENTS

Talk to the user in the language they write in. Briefs to agents can be in English.

Flow: you → hands (Claude agents and Codex jobs) → their sub-agents if the agent brief allows them
(Codex only, one level) → you as the reviewer. Every subtask lives in its own worktree and
branch. Accepted work is merged into an integration branch, and at the end it reaches the user's
working tree in one step.

Who may be a hand: Haiku and Sonnet through `Agent`, GPT models through Codex. Fable only when
`allowFable` is `true` in `~/.claude/orchestra/config.json`. Opus never. Only providers with a
runner, Claude and Codex, are ranked or listed. Gemini (no runner yet) and Kimi (no sandbox) get
no task and never appear.

Three habits keep the board, the graph and the token savings working:
- record every status change of a subtask with `board`;
- label every agent `#<id> <short title>`: in `description` for Claude hands, as the first line of the agent brief for Codex;
- before reading or searching code, check the shared memory (`kb search`), and require the same from agents.

Plugin commands. Write the full command in every call. Never put a command or a path in a shell
variable (`B="node ..."; $B add ...`): Claude Code rejects commands it cannot check before
running them.
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" …      # board: task board
node "${CLAUDE_PLUGIN_ROOT}/scripts/kb.mjs" …         # kb: shared project memory
node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.mjs" …   # worktree: branches and merging
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-task.mjs" … # runs Codex
node "${CLAUDE_PLUGIN_ROOT}/scripts/models.mjs" …     # models: catalog, routing brief, benchmarks
```

## Task types

Give every subtask one type. The catalog scores models per type.

| Type | Examples |
|---|---|
| `bug` | crash, wrong result, failing test to fix |
| `logic` | new non-trivial behavior, algorithms, data handling |
| `refactor` | restructure without changing behavior, multi-file moves |
| `tests` | tests that follow an existing pattern |
| `docs` | README, comments, text, typos |
| `search` | find where something lives, explain code, gather context (read-only) |

## Routing

`models.mjs brief` prints the ranking: for each task type, up to three rungs, cheapest first.
Only models with evidence for the type take part: a public score on the primary metric, or at
least one own-benchmark or board task of that type. Example with made-up numbers:
```
bug 1. claude:sonnet · 73 · own 2/2 · AA 59 (2026-10-28) · $$
bug 2. codex:gpt-5.6-terra@high · 79 · AA 79 (2026-10-28) · $$
bug 3. codex:gpt-6.1-sol@high · 83 · history 6 tasks, 83% first try · $$$
Limits: claude 41% used/5h, 12% used/7d · codex 8% used/5h, 3% used/week · gemini unknown · kimi unknown
```
Each line has the rung, `provider:model@effort`, the score (0 to 100), the evidence, and the
cost class. Claude models have no effort, so none is printed. `low limit` marks a provider above
90% of one of its limit windows.

- **Rung 1:** the cheapest candidate that scores at least 85% of the best, skipping providers marked `low limit`. Effort medium.
- **Rung 2:** the next candidate that scores at least 5 points higher than rung 1, or sits in a higher cost class and scores at least as much as rung 1. Effort high.
- **Rung 3:** the best score. On a tie the candidate in the higher cost class wins, then the one with the higher prior, then the one the provider lists first. Effort high.

Equal scores are normal while the own benchmark is the only evidence. Three tied models in three
different cost classes give three rungs, cheapest first. When tied models share a cost class, the
top rung is the one the provider lists first (Codex lists its newest flagship first), because
routing keeps the provider's listing order on a full tie.

Effort is the nearest one the model supports. Use the effort the ranking prints.

Reading the evidence: `AA 59 (2026-10-28)` is a public score with its source and date; `own 2/2`
is the plugin's own benchmark; `history 6 tasks, 83% first try` comes from past boards and, from
5 tasks of that type, is the score itself. `no public data · neutral prior 50` means the model has
no value on this type's primary metric, so it starts from the median of the other candidates.
Cost class `$` to `$$$$` follows the Artificial Analysis price; without a price it is the model's
default (Haiku `$`, Sonnet `$$`, Fable `$$$`) or the provider's (Codex `$$$`).

Start every subtask at rung 1. Start higher only when a mistake would be hard to spot (subtle
logic, data, security, concurrency); say so in the plan. A mistake that tests or a quick look will
catch belongs on rung 1. Write the rung and the reason into the plan table in step 1.

**A type with no evidence.** When public data covers none of your models and the own
benchmark has not run, no model has evidence. `brief` then prints `<type> no evidence yet` for
that type, and one `untested:` line naming the models that have no evidence for any type shown,
with the command that would test them. Models the user skipped never appear on it:
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
Some types can be empty while others have rungs: `search` has no own-benchmark fixture, so without
public data it stays empty until board history builds up. For an empty type, pick the hand yourself
from the `untested:` line, model and effort by your own judgment, and write `untested: <your
reason>` in the plan table's why column. Skipped models never appear on that line. With no
`untested:` line, choose among the models the other types rank (when no type ranks any, see Nothing
ranked below). The hand's attempts go on the board, so the next run has history for it. At the end
of the report, suggest `/orchestra:setup` or the `bench --models` command from the `untested:` line.
`<type> no available models` means no eligible hand exists at all (no available Claude or Codex
model), not that every model was skipped: stop and tell the user to run `/orchestra:setup`.

**Nothing ranked.** When `brief` prints `<type> no evidence yet` for every type and no `untested:`
line (every model skipped, no Artificial Analysis key), choose by your own judgment among the
available hands in `models.json` in the orchestra data folder (`~/.claude/orchestra`, or
`ORCHESTRA_HOME`): entries with `available.ok` true, provider `codex` or `claude`, never `opus`,
`fable` only with `allowFable`. Write `no evidence` in the plan table's
why column. End the report by suggesting the Artificial Analysis key or the `bench --models`
command.

## Hands

| Who | How |
|---|---|
| **Claude hand** (`haiku`, `sonnet`, `fable` when allowed) | `Agent` with `subagent_type: "oh-my-claudecode:executor"`, `model: "<alias>"`, `description: "#<id> <short title>"` |
| **Claude hand, read-only** (type `search`, or a heavy test suite to summarize) | `Agent` with `subagent_type: "oh-my-claudecode:explore"` or `"oh-my-claudecode:verifier"` and `model: "<alias>"` |
| **Codex hand** (any GPT model in the ranking) | `Bash` with `run_in_background: true`, command below |

Running Codex. The agent brief goes on stdin and its first line must be `#<id> ...`. `--cwd` points
at the subtask's worktree:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-task.mjs" --cwd "<worktree path>" --model <model> --effort <effort> --write <<'BRIEF'
#2 export csv/json
<agent brief, template below>
BRIEF
```
- Always run it in the background (`run_in_background: true`): Codex takes longer than a foreground Bash call may run. You get a notification when it ends; the output holds Codex's final answer and a line `[codex] #<id> done|failed · <tokens> · <time> · to memory: N`.
- Codex gets the memory automatically: the runner adds the project context and notes on the topic to its prompt, and saves its findings afterwards.
- Always pass `--model` and `--effort` from the plan. Without `--model` the runner falls back to `codexModel` in `~/.claude/orchestra/config.json` (`gpt-6.1-sol` by default).
- Drop `--write` when Codex should only diagnose or review.
- If Codex did not start (login error, "not supported", no `codex` on PATH), tell the user the fix: `codex login` or `codex update`. Ask whether a Claude hand should take those subtasks meanwhile.

## Steps

### 0. Look around, cheaply

- Check the session model. Your system prompt names it. The final review is always Opus 5.5. On Opus 5.5 you review yourself. On any other model, tell the user in one line that the final review and every accepted/rework verdict go to a read-only `Agent` with `model: "opus"` (step 3).
- Memory first: `kb context` and `kb search "<main words of the task>"`. Don't rediscover what is already there.
- Models: `node "${CLAUDE_PLUGIN_ROOT}/scripts/models.mjs" discover && node "${CLAUDE_PLUGIN_ROOT}/scripts/models.mjs" benchmarks && node "${CLAUDE_PLUGIN_ROOT}/scripts/models.mjs" brief`. Discovery skips itself within 24 hours, and the public data refresh runs weekly or when discovery finds a new model, so this is cheap. Read the ranking once and keep it in mind for the split. If `brief` fails or prints `no available models`, run `models.mjs discover --force` once; if that does not help, stop and tell the user to run `/orchestra:setup`.
- `git status`. Without a git repository there are no worktrees: suggest `git init` to the user, or work in one folder as before and make sure parallel subtasks touch different files.
- Find how the project builds and runs tests, if memory doesn't say. You need the command, not the file contents.
- If memory has no `context` note for this project, write one with what you just learned (layout, test command, conventions, 5-10 lines). Otherwise every agent would work it out again:
  `kb add --kind context --title "project: layout and commands" --author opus --body "<…>"`.
- If the task is ambiguous in a way that changes the split, ask before handing anything out. Redoing work costs more.
- If the whole task is a couple of lines in one file, orchestration is not worth it. Give it to one hand at rung 1 for its type, say so, and skip the board and worktrees. You still do not edit: review the hand's change with `git diff`.
- Start the web graph: `node "${CLAUDE_PLUGIN_ROOT}/web/server.mjs" --ensure` prints its URL; give it to the user in one line. If `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-hud.mjs" status` says the status line is not installed, suggest `/orchestra:setup` once.

### 1. Split the task, pick the hands, set up the board and branches

A good subtask has a clear done criterion and its own set of files. Each one runs in its own
worktree, so parallel agents never overwrite each other. Two subtasks that change the same
lines still conflict at merge time: combine them or order them (`--deps`).

Pick the hand for each subtask from the ranking for its type, and show the plan as a table. The
last column names the evidence from the ranking, or `untested: <reason>` for a type with no
evidence; a row that names a model without a reason is not done. The example uses the `bug` lines
from the Routing section above:

```text
| # | task             | type | executor | model@effort     | why (evidence)                                                      |
|---|------------------|------|----------|------------------|---------------------------------------------------------------------|
| 1 | sort_tasks crash | bug  | claude   | sonnet           | rung 1: 73, within 85% of the best 83; own 2/2, AA 59 (2026-10-28)  |
| 2 | queue lock race  | bug  | codex    | gpt-6.1-sol@high | rung 3: risky (concurrency); history 6 tasks, 83% first try         |
| 3 | docstrings       | docs | claude   | haiku            | rung 1: cheapest within 85% of the best for docs, $                 |
```

In one Bash call:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.mjs" init && \
node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" init "<task title>" && \
node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" add 1 "sort_tasks crash" --exec claude --model sonnet --type bug && \
node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" add 2 "queue lock race" --exec codex --model gpt-6.1-sol --effort high --type bug && \
node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" add 3 "docstrings" --exec claude --model haiku --type docs --deps 1,2 && \
node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" show
```
`--exec` is the provider (`codex` or `claude`), `--model` the model or Claude alias, `--effort`
only for Codex, `--type` one of the six types. If `worktree init` refuses because the user has
uncommitted changes, those changes would not reach the agents' branches. Ask the user to commit
or stash them, or to continue with `--allow-dirty` knowing the agents won't see them.

Paste the plan table and the `show` output into chat as ```text blocks. Then hand out the work
without waiting, unless the user asked to approve the plan. You pick the models yourself.

### 2. Hand out

For each subtask you start now: `worktree create <id>` prints its worktree path, then
`board set <id> running`. A subtask with a dependency starts after the dependency is accepted
(step 3), so its branch already contains that code.

Send independent subtasks in one message with several calls so they run in parallel. Start as
many agents as there are truly independent subtasks, usually 2-6. The ceiling is 100; you will
rarely need it.

Give every agent a brief in this shape. The agent knows only what the brief says, and does exactly
what it says:

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
- If you notice a problem outside these files, report it under open questions. Don't fix it.
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

#### Writing for the model

You write the agent brief; these notes say only what each family needs.
- **Codex (GPT):** the agent brief arrives on stdin and the runner adds the memory. Give the goal, the files and one done command, and describe the result rather than a step list: at `high` the model plans its own steps. Keep the first line `#<id> ...`.
- **Claude:** the agent knows only its brief, so include the worktree path and the memory block. Haiku needs exact file paths, concrete steps and one done command, with no judgment calls left open. Sonnet and Fable do well with the goal, the constraints and the done criterion.
- **Gemini:** no task goes to it yet. When a runner exists, write its agent brief like Haiku's: exact paths and one done command, with `#<id>` on the first line of stdin.

#### Sub-agents (one level)

Allow a sub-agent only when the agent brief says so and names its model and effort. Use the
cheapest Codex line of `models.mjs brief` for the type of the hard part, with the effort printed
there; with no Codex line, allow no sub-agent. A hand never picks a model itself. A sub-agent is
always Codex: Claude Code agents have no tool for launching agents. Add this to a Claude hand's
agent brief, with `<model>`, `<effort>` and `<type>` filled in:
```
If you hit a hard part (<what counts>), hand it to Codex as #<id>.1, with exactly this model and effort:
1. node "<plugin>/scripts/board.mjs" add <id>.1 "<short>" --exec codex --model <model> --effort <effort> --type <type>
2. node "<plugin>/scripts/worktree.mjs" create <id>.1 --from <id>   → path P
3. node "<plugin>/scripts/board.mjs" set <id>.1 running
4. node "<plugin>/scripts/codex-task.mjs" --cwd "P" --model <model> --effort <effort> --write --detach <<'BRIEF'  → job id J
   #<id>.1 <short>
   <agent brief for Codex in the same shape>
   BRIEF
5. node "<plugin>/scripts/codex-task.mjs" wait J --timeout 540   (exit code 3 = still running, call it again)
6. check the diff (node "<plugin>/scripts/worktree.mjs" diff <id>.1) and the tests in P, then
   node "<plugin>/scripts/worktree.mjs" accept <id>.1 --into <id> and board set <id>.1 done
At most one or two such sub-agents, and a sub-agent starts none of its own. Use no other model or effort.
```

### 3. Review every result and accept it

The final review is always Opus 5.5. On Opus 5.5 you run the checklist below yourself. On any
other model, send it to a read-only `Agent` with `subagent_type: "oh-my-claudecode:code-reviewer"`
and `model: "opus"`. Paste the full checklist into its prompt, scope check first, with the
worktree path, the allowed files and the "Done when" criteria. It runs the diff and the tests
itself and answers `accepted` or `rework` with a numbered fix list. You run the `worktree` and
`board` commands for its verdict.

When a hand comes back: `board set <id> review`. A hand's report is a claim, not a fact.
For each subtask, scope first:

1. `worktree diff <id> --stat`: did the hand touch only the allowed files? Any extra change is rework, even a good one. A hand reports problems outside its scope; it does not fix them.
2. `worktree diff <id>`: read the diff, not whole files. Check the logic, edge cases, and that nothing was deleted by mistake.
3. Run the tests, build and linter for this subtask inside its worktree. The reviewer's run, not the hand's word.
4. Go through the "Done when" criteria one by one.
5. `git status` of the main project folder must be clean: the hand worked only in its worktree.

You may give a heavy test suite to `oh-my-claudecode:verifier` for a summary, but only the final
reviewer decides "accepted" or "rework".

Accepted: `worktree accept <id>` (commits on the task branch and merges into the integration
branch), then `board set <id> done`. If `accept` reports a conflict (exit code 2), it's rework:
`worktree refresh <id>` pulls the current integration branch and leaves the conflict in the
hand's worktree. Send the hand the list of conflicting files.

Rework: `board set <id> rework --note "<what's wrong, 3-6 words>"`.

### 4. Send back for rework, and climb

Return the subtask to the same hand with a numbered list of concrete fixes: what's wrong,
where, what the result should be. Before sending, `board set <id> running`: the board starts a
new attempt record.

- **Claude hand:** `SendMessage` to the same agent; it keeps its context.
- **Codex hand:** if this subtask had one Codex job, add `--resume-last` and send only the fix list (first line still `#<id> ...`, same `--cwd`, same `--model` and `--effort`). Otherwise start fresh: say briefly what is already done and in which files, then the fix list.

A rung gets two attempts: the first and one rework. If the second attempt fails, climb to the
next rung of the ranking for this type, in this order:
1. rung 2, then rung 3 (the best score), as `models.mjs brief` printed them;
2. then rung 3 once more at its top effort: the last value of that entry's `efforts` array in
   `~/.claude/orchestra/models.json`. A Claude rung 3 has no efforts, so for it this step is a
   plain re-run;
3. if that fails too, `board set <id> failed --note "<why>"`.

To climb: `board set <id> rework --note "<…>"` first (it closes the attempt), then
`board exec <id> <provider> --model <model>`, then `board set <id> running`. Add
`--effort <effort>` to `exec` for Codex hands only; Claude hands have none. Without `--model`
(and `--effort` for Codex) the board clears the field. The new hand has no context: say what is
already done and in which files, what failed, and the fix list. The board keeps the failed
attempts of the cheaper model, so the history shows which model did the work. Opus is never a
hand, so `exec` never takes `opus`.

If a subtask can't be done, say so plainly in the report.

### 5. Land and check the whole

- When every subtask is accepted: `worktree status` gives the integration worktree path. Run the full test suite, build and linter there.
- `worktree land`: all accepted work reaches the user's working tree as one squash, staged, with no commit. If `land` refuses because the user has uncommitted changes in the same files, stop and ask what to do with them.
- Run the tests again in the working tree and look at `git diff --cached --stat`: no junk, no temp files, no stray edits.
- `worktree cleanup` removes the agents' branches and worktrees.
- Record 1-3 decisions that matter for future work on this project (`kb add --kind decision`).
- Don't commit or push unless the user asked.
- `board finish`.
- Last command of the run, right after `board finish`: `node "${CLAUDE_PLUGIN_ROOT}/scripts/models.mjs" bench --new` with `run_in_background: true`. It benchmarks models nobody has run yet. It does nothing without `benchAuto: true` or when no model is new. Don't wait for it.

### 6. Report

Short, in the user's language, in this shape:

````
## Result: done / not done

```text
<board show output>
```

**Done:** <2-4 lines on the substance>

**Checked:** <commands and their results, e.g. `pytest`: 42 passed>

**Routing:** <which model took which subtask, any climb and why>

**Memory:** <notes added and how often agents found what they needed, from kb stats>

**Left / risks:** <what isn't done or wasn't checked; "nothing" if so. If a subtask used an untested model, suggest `/orchestra:setup` or the `bench --models` command from the `untested:` line>
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
- You write briefs and verdicts; every code change is a hand's. Don't do a hand's work in parallel with it, and don't rewrite accepted work for style.
- Don't read whole files to write a brief: give the agent the paths. You read diffs.
- A read-only agent gathers context in a large repository, not you. It writes the result to memory as `context`.
- Run targeted tests during review; the full suite in the integration branch and after `land`.
- Chain plugin commands with `&&` in one Bash call.
