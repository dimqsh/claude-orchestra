---
name: board
description: Opens the live orchestra agent graph (Opus, Codex, Sonnet, tasks, tokens) in a browser and prints the ASCII board in the chat. Run manually with /orchestra:board.
disable-model-invocation: true
---

# Board

Answer the user in the language they write in.

Show the user what the agents are doing right now.

## 1. Start the graph server

```
node "${CLAUDE_PLUGIN_ROOT}/web/server.mjs" --ensure
```
It prints the address, for example `http://127.0.0.1:7377/`. If it fails, show the message and skip to step 3.

## 2. Open the graph

- If a built-in browser tool is available (for example `mcp__Claude_Browser__preview_start` with a `url`), open the address with it.
- Otherwise run `open <address>` on macOS or `xdg-open <address>` on Linux.
- If neither works, give the user the address.

## 3. ASCII board in the chat

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" show
```
Paste the output unchanged into a code block with the language `text` (three backticks followed by the word text). If there is no board yet and the script says so, tell the user: the board appears once `/orchestra:orchestrate <task>` starts.

End with one line: the graph address and, if the status line is not set up, a pointer to `/orchestra:setup`.
