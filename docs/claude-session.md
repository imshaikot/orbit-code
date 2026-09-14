# Claude in Orbit

Orbit embeds no model. It runs the user's own `claude` command line as a long-lived process that speaks stream-json, and turns what Claude does into three streams: **session state** (phase, permission request, cost), a **transcript**, and **per-file activity** on the graph. The page draws them as Claude's star and comets in the scene, and as bubbles, a conversation view and a permission card in the HUD. Two promises hold throughout: **what lights up is what Claude asked to touch, on the file it named**, and **every question Claude asks reaches the user**, even with Orbit hidden.

The code is `packages/agent` (the session and the CLI) and `packages/core` (the projector and the controller); the shapes were last checked against Claude Code 2.1.267.

## The process

```
claude --print --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio
       [--model M] [--effort E] [--permission-mode P] [--resume <session id>] [...claude.extraArgs]
```

- Started in the first workspace folder, with `ELECTRON_RUN_AS_NODE` removed from the environment, through no shell (except `.cmd`/`.bat` on Windows).
- **One process serves many turns** of one conversation: each prompt is one `{"type":"user"}` line on stdin.
- **Option changes apply to the next prompt.** Changing the model, effort or permission mode restarts the process with `--resume <session id>`, so the conversation continues. A process that died while idle restarts the same way.
- **The probe.** Before anything, the service runs `claude --version` on the configured path, or on `claude` from `PATH` plus `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin`, because editors started from the GUI often lack the shell's `PATH`. It logs `agent: <version>` or `agent unavailable: <reason>`; without it, the graph still works.
- **Trust.** Sessions stay unavailable until the workspace is trusted (VS Code's workspace trust; the desktop app's per-folder dialog).
- **Without `--permission-prompt-tool stdio`** Claude Code denies gated tools outright instead of asking; the flag is what makes the permission card possible.

## Conversations

`SessionService` keeps a `Conversation` per key (`c1`, `c2`, …), each with its own process, and one of them is **current**: the one the drawer and **Orbit Code: Ask Claude…** continue.

- A prompt without a key goes to the current conversation if it is idle, else opens a new one beside it. A prompt with a key continues that conversation, and is refused while it is busy. Whichever takes the prompt becomes current, and so does one started by **New conversation** or continued from History.
- Only the current conversation keeps its process warm between turns; a former current lets its idle process go and restarts with `--resume` when prompted again.
- Past eight conversations, the oldest idle non-current one is let go.
- **Stop** interrupts one; **Orbit Code: Stop Claude** interrupts every running one.

The page gets a `sessions` snapshot (every conversation's state and the current key) whenever the set changes, and `session`, `transcript` and `activity` messages carrying the conversation's key.

## What Claude does, and what Orbit shows

| Claude | Transcript | Scene | HUD |
| --- | --- | --- | --- |
| Starts a turn | A prompt entry opens a turn | Edges flow faster for the whole turn, and the frame loop stays awake | The text flies into a new bubble |
| Thinks | | Every import line on screen fires violet | "Thinking" |
| Writes | Markdown, rendered as DOM nodes; a link without a scheme opens a workspace file | | "Writing a reply" |
| Reads a graph file (`Read`) | A tool entry linked to the file | The star moves over the file; a comet leaves it; the file and its bubbles light cyan once the comet lands | "Reading path" |
| Edits a graph file (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`) | Linked | The star moves over the file, which pulses amber; its neighbours at half strength | "Editing path" |
| Creates a source file | Linked | Nothing until the live update adds it; then it glows like an edit with the star moving to it | |
| Touches any other path | Unlinked | Nothing | |
| Calls an MCP tool (`mcp__server__tool`) | An entry naming the server and tool | The server's station comes out beside the star; a pulse runs out along the beam and the answer back, red on error | "Asking server" |
| Uses another tool (Bash, Grep, Glob, Task, WebFetch, …) | The tool and its command, pattern, URL or description | Nothing | The tool name and detail |
| A tool fails | A warning notice | | |
| Asks permission or questions | | | The bubble waits; a card in the conversation view; a notification when the page is out of sight |
| Runs a subagent (`Task`) | The Task call; the subagent's own entries are kept apart | A smaller star comes out of Claude's, moves over the subagent's files, and goes back when it finishes | Its star's popup shows its output |
| Finishes | A turn line with duration and list-price cost | Glows fade, the star goes home | The bubble says how it went and leaves |
| Is stopped | "Stopped" | As a finish | "Stopping" |
| Its process dies | An error notice and a failed turn, with the last stderr line | As a finish | A failed bubble, which stays until opened |

Tool paths (absolute, or relative to the workspace) are resolved against the graph by `SessionProjector`; a path outside the graph animates nothing and appears in the transcript without a link. Activity is batched per 100 ms tick and carries the graph's hash. The projector keeps the last 400 transcript entries per conversation, and 400 more of its subagents'.

## Permissions

A gated tool arrives as a `can_use_tool` control request, with the `permission_suggestions` Claude Code would apply for "don't ask again": switching the session to accept edits for an edit, an allow rule for a command. Orbit words them as the card's middle choice.

- **Allow** answers with the request's own input echoed back.
- The **always** choice sends those suggestions back as `updatedPermissions`, so Claude Code applies them itself; Orbit invents no rules of its own.
- **Deny** carries a message.
- An interrupt denies a pending request first.
- Permission modes: `default` (the user's own settings decide), `acceptEdits`, `plan`, and `bypassPermissions`, which only a host setting can choose; the page never offers it and the controller refuses it.

### Questions

An `AskUserQuestion` call arrives the same way. Its questions become a question card in place of the permission card: options as radios (or checkboxes when the question allows several) and a field for the user's own answer. The answer requires one per question and is sent as the tool's `answers` input, as Claude Code's own dialog does; **Skip** is a deny saying the questions were skipped. A notification can't hold the answers, so it offers to open Orbit or skip.

## Interrupt, cost, exits

- An interrupt is an `interrupt` control request; the turn then ends with a result whose reason is an abort. If no result arrives within 5 s, the process is stopped (SIGTERM, then SIGKILL 3 s later) and the turn counts as interrupted.
- `total_cost_usd` is cumulative per process, so the service subtracts the previous value and starts from zero with each new process.
- A process that dies during a turn is logged as a warning (it isn't an Orbit bug), with a failed turn and a notice. Idle and non-zero: a warning, and the next prompt resumes the conversation.

## The catalog

After a successful probe, in a trusted workspace with a folder open, the backend starts a short-lived process with the same arguments plus `--no-session-persistence`, sends it only the `initialize` and `mcp_status` control requests, and ends it.

- `initialize` gives the models (with the default marked) and their effort levels (none for a model such as Haiku), and the commands; the skill catalog keeps the commands that are skills on disk (the workspace's `.claude/skills`, `~/.claude/skills`, installed plugins) with the skills each `SKILL.md` names.
- `mcp_status` gives each server's name, status, scope, tool count and names, transport, version and a scrubbed error. The answer also carries the server's configuration, credentials included, and `initialize` the account: only the declared fields leave the parser and neither answer is logged.
- Each session's `init` message updates the MCP statuses.

### The MCP view

**Reload** replaces the service's control process (the catalog's arguments, no prompt, let go after five minutes unused) and asks `mcp_status` again while any server is pending. A click on a server offers reconnect, enable or disable, sign in or sign out; each is accepted only for a server the catalog lists and an action in the fixed set, and becomes the matching control request on that process. A toggle is saved in the user's Claude Code settings, as `/mcp` saves it. A sign-in's URL (http or https only) is opened by the host in the system browser and never reaches the page; for an OAuth server the process then waits for the callback while the service polls until it connects. Every action but reconnect makes each conversation start a new process at its next prompt, which loads the change.

## Skills, files, history

- **Skills.** A prompt can carry up to eight catalog skill names; any other is dropped. The first is sent as a leading slash command (`/name text`) and the rest are named in the prompt for Claude to load. Built-in skills are left out of the panel, because `initialize` doesn't tell them from built-in commands.
- **Files.** A prompt can carry up to twenty files as context: graph files, and absolute paths the host's own file dialog returned; anything else the page names is dropped. They are appended as `@path` mentions (`@"a b.md"` with whitespace), Claude Code's own syntax, so Claude reads them into the turn itself rather than through a tool call Orbit is asked to allow.
- **History.** `ConversationHistory` summarises the workspace's earlier conversations from Claude Code's transcripts under its config directory (`projects/<the workspace path with non-alphanumerics as dashes>`), cached by size and mtime: title, prompts, model, branch, files touched, MCP servers and skills. Continuing one is accepted only for an id in the last list sent, because it becomes `--resume <id>`: the conversation already holding that id becomes current, else a fresh one takes it. The earlier transcript isn't replayed into the view.

## Subagents

A subagent's envelopes carry the id of the Task call running it. The conversation announces it on its first envelope (with the subagent's type and description) and ends it when that call's result arrives or the turn ends first. Its reads, edits and MCP calls are sent as activity with the subagent's id, and its transcript entries are kept in a history of their own, so a busy subagent doesn't push the conversation's entries out and the conversation view shows only the Task call. A subagent that sends nothing before its call returns gets no star.

## Settings that reach the process

| VS Code | Desktop `settings.json` | Effect |
| --- | --- | --- |
| `orbit.claude.path` | `claude.path` | The executable; empty searches `PATH` and the usual locations. A change probes again |
| `orbit.claude.model` | `claude.model` | `--model`; checked as a model name. Applies from the next prompt |
| `orbit.claude.effort` | `claude.effort` | `--effort`, one of `low`, `medium`, `high`, `xhigh`, `max`; empty passes none. Applies from the next prompt |
| `orbit.claude.permissionMode` | `claude.permissionMode` | `--permission-mode` unless `default`. Applies from the next prompt |
| `orbit.claude.extraArgs` | `claude.extraArgs` | Appended to every invocation, for example `["--add-dir", "../shared"]`. A change probes again |

The path, the extra arguments and the permission mode change what runs and with which permissions, so VS Code scopes them to the machine and restricts them in untrusted workspaces, and the desktop app reads them only from user data.

## Another backend

`SessionBackend` and `AgentProcess` in `packages/agent/src/backend.ts` are the seam. Another backend (the Agent SDK, a remote runner) implements them, emits the same `AgentEvent`s, and calls the sink's exit exactly once, including after disposal; nothing above the service would change.
