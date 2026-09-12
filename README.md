# Orbit Code

Your codebase as a 3D dependency graph in VS Code, with Claude Code working through it live.

Directories are bubbles, files are nodes, imports are lines. Files Claude reads light up cyan, files it edits pulse amber, and the import network fires while it thinks.

## Features

- **Dependency graph for most languages.** JS/TS, Python, Go, Rust, Java, C#, Swift, PHP, Dart and more. Imports resolve through each project's own config (`tsconfig`, `go.mod`, `Cargo.toml`, `pyproject.toml`, …), so monorepos work too.
- **Live updates.** The graph follows your edits, Claude's edits and git checkouts within seconds, and keeps the layout in place.
- **Claude in the panel.** Prompt from the bottom drawer, pick model, effort and permission mode, and run several conversations at once.
- **Permissions.** Allow, Deny or "don't ask again" from a card in the panel, or from a notification when Orbit is hidden. When Claude asks you questions, pick its options or type your own answer on the same card, or skip them.
- **Context.** Attach skills (type `/` or drag them in), attach files, or continue an earlier conversation.
- **MCP servers.** The MCP button at the top right of the drawer shows every MCP server Claude Code loads, and whether it is connected, needs sign-in, failed or is disabled. Reload them, or sign in, reconnect, enable or disable one; the change is saved in your Claude Code settings, as `/mcp` saves it.
- **File actions.** Click a file to view its diff, edit it inline, rename it, delete it or attach it to a prompt.
- **Follow Spark.** Click Claude's star and the camera follows it.

## Requirements

- VS Code 1.100+
- [Claude Code](https://docs.claude.com/en/docs/claude-code), installed and logged in. Without it, you still get the graph.

## Install

```sh
yarn install
yarn install-local
```

Reload VS Code, then click the Orbit icon in the activity bar or run **Orbit Code: Open**.

**Navigating:** scroll over a bubble to zoom into it, click a bubble to enter it, and press Esc to go back up.

## Commands

| Command | |
| --- | --- |
| Orbit Code: Open | Open the graph |
| Orbit Code: Ask Claude… | Send a prompt |
| Orbit Code: Stop Claude | Stop every running turn |
| Orbit Code: New Claude Conversation | Start fresh |
| Orbit Code: Reindex Workspace | Index everything again and lay it out from scratch |

## Settings

| Setting | Default | |
| --- | --- | --- |
| `orbit.claude.path` | `""` | Path to `claude`. If empty, Orbit searches `PATH` and the usual install locations |
| `orbit.claude.model` | `""` | Model, e.g. `opus` or `sonnet` |
| `orbit.claude.effort` | `""` | `low`, `medium`, `high`, `xhigh` or `max` |
| `orbit.claude.permissionMode` | `default` | `default`, `acceptEdits`, `plan` or `bypassPermissions` |
| `orbit.claude.extraArgs` | `[]` | Extra arguments for every `claude` run |
| `orbit.maxFiles` | `20000` | The most files Orbit indexes |

Claude only runs in trusted workspaces. Your own Claude Code settings, `CLAUDE.md` and MCP servers apply.

## Development

```sh
yarn self        # build and open this repo in an Extension Development Host (or press F5)
yarn watch       # rebuild on change
yarn typecheck
yarn harness     # webview checks in headless Chrome
yarn smoke       # end-to-end in a real VS Code
```

CI (`.github/workflows/ci.yml`) runs typecheck, build and an index of this repository on every push to `main` and pull request, then packages a `.vsix` and runs smoke and harness; the harness report and screenshots are an artifact to read. Pushing a `v<version>` tag matching `package.json` attaches the `.vsix` to a GitHub release.

Architecture notes are in `CLAUDE.md`.

## Limitations

- Only the first workspace folder is indexed.
- Reloading the window ends your conversations.
- Live updates are incremental, so a few imports can go stale. Reindex fixes them.
- Enabling, disabling or signing in to an MCP server reaches each conversation at its next prompt, not during a turn. A claude.ai connector needs Reconnect after you connect it on claude.ai.

## License

MIT
