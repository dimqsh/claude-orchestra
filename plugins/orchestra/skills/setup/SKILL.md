---
name: setup
description: Sets up the orchestra live board in the Claude Code status line, checks the dependencies (Node, oh-my-claudecode, Codex CLI), finds the models you can use and offers to benchmark them. Run manually with /orchestra:setup.
disable-model-invocation: true
---

# Setup

Answer the user in the language they write in.

Go through the steps in order and report each result in one line. Edit `~/.claude/settings.json` only after the user confirms. Step 5 writes to `~/.claude/orchestra/config.json`, and only the keys that step names.

## 1. Node and oh-my-claudecode

- Run `node --version`. Node 20 or newer is required, and 22.13 or newer for the shared agent memory, which uses the built-in `node:sqlite`. If Node is missing or older than 20, stop and say what to install. Between 20 and 22.13 everything works except the memory; tell the user.
- Run `claude plugin list`. The output must contain `oh-my-claudecode`. If it does not, show these commands for the user to type as slash commands:
  ```
  /plugin marketplace add Yeachan-Heo/oh-my-claudecode
  /plugin install oh-my-claudecode@omc
  ```
  Installing `orchestra` normally pulls in `oh-my-claudecode` as a dependency. The commands are for the case where that did not happen.

## 2. Codex CLI

Codex runs through `codex exec` directly. The codex plugin is not needed.

- Run `codex --version`. If the command is missing, say Codex CLI is not installed (`npm install -g @openai/codex`). The version must be 0.165.0 or newer: older CLIs reject gpt-6.x models on a ChatGPT account with "not supported when using Codex with a ChatGPT account". If the version is lower, suggest `codex update` and check again afterwards.
- Run `codex login status`. If Codex is not logged in, tell the user to run `codex login` themselves (it opens a browser), then check again.
- `codexModel` in `~/.claude/orchestra/config.json` (default `gpt-6.1-sol`) is only the fallback for a run that passes no `--model`. Routing passes a model for every task, so there is normally nothing to set. Do not edit that file for this unless the user asks.

## 3. Status line

1. Show what will change:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/install-hud.mjs" install --dry-run
   ```
   Summarize the output: the `statusLine` and `subagentStatusLine` keys before and after. If the user already has a status line, say it is kept and printed first (the chain), with the board below it.
2. Ask: "Apply these changes to ~/.claude/settings.json? A backup is saved next to it." Wait for the answer.
3. On yes, run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/install-hud.mjs" install
   ```
   Give the user the backup path from the output. If the script fails, show its message as is and do not repair anything by hand.
4. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-hud.mjs" status`. It must report the HUD as installed.

## 4. Claude Code version

Agent rows in the status line (`subagentStatusLine`) need Claude Code 2.1.293 or newer. Run `claude --version`. If it is older, suggest `claude update`. Without the update the main board still works and only the per-agent rows are missing.

## 5. Models and benchmark

The orchestrate skill picks a model per subtask from a catalog. This step builds it.

1. Find the models you can use:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/models.mjs" discover --force
   ```
   It prints `added:` and `unavailable:`. Report both in one line each. Gemini is discovered but has no runner yet, and on some accounts the Gemini CLI also rejects the probe (`IneligibleTierError`, asks to migrate to Antigravity), so it shows as unavailable with that error. Kimi shows `disabled: no sandbox`. Neither gets a task, so do not try to fix them. Fable stays off unless the user sets `allowFable: true` in config.json, because it costs more; say so once.
2. Ask for the optional Artificial Analysis key: "A free key from https://artificialanalysis.ai adds public coding scores and prices. Without it only BenchLM scores load and every cost class falls back to the provider's default. Paste a key, or say skip." On a key:
   - Read `~/.claude/orchestra/config.json` (`$ORCHESTRA_HOME/config.json` when that variable is set), add `"artificialAnalysisKey": "<key>"`, keep every other key, write it back and run `chmod 600` on it. Do not print the key again.
   - The environment variable `ORCHESTRA_AA_KEY` also works and wins over the file.
3. Load the public data and show the result:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/models.mjs" benchmarks --force
   ```
   Report the `source:` line and any warning. Tell the user the scores come from Artificial Analysis (https://artificialanalysis.ai) and BenchLM, each stored with its source and date.
4. Show what the plugin's own benchmark would cost:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/models.mjs" bench --estimate
   ```
   One line per available Claude and Codex model. Each run is six small tasks capped at 150000 tokens per model (the cap is checked between tasks, so one task can overshoot it). Show the list and ask which models to benchmark now. None is fine.
5. Start the benchmark in ONE call, so the skip list cannot be lost. `<picked>` and `<the rest>` are comma-separated lists from the estimate; use `provider:model` when a bare name is ambiguous. `<the rest>` is every other model on the estimate list, minus those that already have a result in `models.json` (`own`), because `--skip` overwrites a result.
   - Some picked and some left: one call with `run_in_background: true` (it takes minutes and runs one model at a time). The skip list is written first, then the picked models run:
     ```
     node "${CLAUDE_PLUGIN_ROOT}/scripts/models.mjs" bench --models <picked> --skip <the rest>
     ```
   - All picked, or nothing left to skip: leave out `--skip`.
   - None picked: run `bench --skip <all>` alone, in the foreground. It returns at once and starts no run.

   Never pass an empty list: `--models` or `--skip` with no names is an error, so leave that flag out. Do not start a second `bench` while one runs: it prints `bench already running` and does nothing. When the background call ends, report each `<model>: done|partial|skipped` line.
6. Unless the user wants no benchmarking at all, set `"benchAuto": true` in config.json the same way as the key, after the call from step 5 has ended. Tell them what it does: after a run, the orchestrate skill starts `bench --new` in the background; it benchmarks models that appeared since and never the ones they skipped. A run is postponed while a board is active (not finished and updated in the last 30 minutes) or the provider is above 70% of a limit window: the run stops, and the next `bench --new` picks up where it left off. `"benchAuto": false` stops it.
7. Show the ranking:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/models.mjs" brief
   ```

## 6. Web graph

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/web/server.mjs" --ensure
```
It prints the address, normally `http://127.0.0.1:7377/`. Give it to the user. The server listens on 127.0.0.1 only. To stop it: `node "${CLAUDE_PLUGIN_ROOT}/web/server.mjs" --stop`.

## 7. Summary and undo

End with a short list: what was checked, what was installed, how many models were found and benchmarked, the graph address. The status line refreshes within a couple of seconds. A task starts with `/orchestra:orchestrate <task>`.

To undo:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/install-hud.mjs" uninstall
```
The previous status line comes back and the agent rows disappear. Files in `~/.claude/orchestra` stay on disk, including the model catalog and the key. Remove the `artificialAnalysisKey` line from `config.json` there to drop the key.
