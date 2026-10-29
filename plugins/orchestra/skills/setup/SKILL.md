---
name: setup
description: Sets up the orchestra live board in the Claude Code status line and checks the dependencies (Node, oh-my-claudecode, Codex CLI). Run manually with /orchestra:setup.
disable-model-invocation: true
---

# Setup

Answer the user in the language they write in.

Go through the steps in order and report each result in one line. Edit `~/.claude/settings.json` only after the user confirms.

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
- The model comes from the `codexModel` key in `~/.claude/orchestra/config.json`, default `gpt-6.1-sol`. If the user wants another model, show them the key to add (leave the other keys in the file alone):
  ```
  { "codexModel": "gpt-6.1-sol" }
  ```
  Do not edit that file unless the user asks.

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

## 5. Web graph

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/web/server.mjs" --ensure
```
It prints the address, normally `http://127.0.0.1:7377/`. Give it to the user. The server listens on 127.0.0.1 only. To stop it: `node "${CLAUDE_PLUGIN_ROOT}/web/server.mjs" --stop`.

## 6. Summary and undo

End with a short list: what was checked, what was installed, the graph address. The status line refreshes within a couple of seconds. A task starts with `/orchestra:orchestrate <task>`.

To undo:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/install-hud.mjs" uninstall
```
The previous status line comes back and the agent rows disappear. Files in `~/.claude/orchestra` stay on disk.
