# Orbit Code

Your codebase as a 3D dependency graph in VS Code, with Claude Code working through it live.

Directories are bubbles, files are nodes, imports are lines. Files Claude reads light up cyan, files it edits pulse amber, and the import network fires while it thinks.

## Features

- **Dependency graph for most languages.** JS/TS, Python, Go, Rust, Java, C#, Swift, PHP, Dart and more. Imports resolve through each project's own config (`tsconfig`, `go.mod`, `Cargo.toml`, `pyproject.toml`, …), so monorepos work too.
- **Live updates.** The graph follows your edits, Claude's edits and git checkouts within seconds, and keeps the layout in place.
- **Nested or Flat.** The tabs at the top switch views. Nested shows directories as bubbles inside bubbles, one to look into at a time. Flat puts every file on an orbit around the workspace, each project or top-level directory along its own arc, each file a sphere with its file type's icon and its name, with the imports arching between them.
- **Take a Tour.** The button at the top right flies the camera from place to place round the workspace on its own, directory to file to directory, backing out and swinging in between, and pauses a moment at each, now and then with a card of what the graph knows about it: the most imported file in its directory, the largest, an entry point, a directory nothing outside imports from. Navigation is off until you press Stop Tour.
- **Claude in the panel.** Prompt from the bottom drawer, pick model, effort and permission mode, and run several conversations at once. A conversation's own window has the same controls, so a follow-up can switch model or bring skills and files, and you can write it while Claude is still working.
- **Permissions.** Allow, Deny or "don't ask again" from a card in the panel, or from a notification when Orbit is hidden. When Claude asks you questions, pick its options or type your own answer on the same card, or skip them.
- **Context.** Attach skills (type `/` or drag them in), attach files, or continue an earlier conversation.
- **MCP servers.** The MCP button at the top right of the drawer shows every MCP server Claude Code loads, and whether it is connected, needs sign-in, failed or is disabled. Reload them, or sign in, reconnect, enable or disable one; the change is saved in your Claude Code settings, as `/mcp` saves it.
- **File actions.** Click a file to view its diff, edit it inline, rename it, delete it or attach it to a prompt.
- **Follow Spark.** Click Claude's star and the camera follows it.
- **Subagents.** When Claude hands work to a subagent, a smaller star comes out of Claude's and moves over the files the subagent reads and edits. Click it to read the subagent's output as it comes.

## Requirements

- VS Code 1.100+
- [Claude Code](https://docs.claude.com/en/docs/claude-code), installed and logged in. Without it, you still get the graph.

## Install

```sh
yarn install
yarn install-local
```

Reload VS Code, then click the Orbit icon in the activity bar or run **Orbit Code: Open**.

**Navigating:** scroll over a bubble to zoom into it (it comes to the middle of the screen and opens once it fills the view), click a bubble to enter it, drag to orbit all the way around, right-drag to pan (panning out of a directory backs out of it), and press Esc to go back up. The directories beside the one you are in stay as faint rims. In the Flat view, drag to orbit, scroll toward any file to zoom, and click a file as in the Nested view; switching back returns to the directory you were in. **Take a Tour** (top right) hands the camera over: it flies from stop to stop until you press **Stop Tour**, which leaves you wherever it got to.

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

The extension is `apps/vscode` in the Orbit Code monorepo, built from its packages with Nx. From the repository root:

```sh
yarn self        # build and open the repository in an Extension Development Host (or press F5)
yarn watch       # rebuild on change
yarn typecheck
yarn harness     # webview checks in headless Chrome
yarn smoke       # end-to-end in a real VS Code
yarn package     # a production .vsix in dist/apps/vscode/
```

CI (`.github/workflows/ci.yml`) runs typecheck, build, the package boundary check and an index of the repository on every push to `main` and pull request, then packages a `.vsix` and runs smoke and harness; the harness report and screenshots are an artifact to read. Releases come from Nx Release: a `v<version>` tag attaches the `.vsix` to a GitHub release, and publishes it to the Marketplace and Open VSX once their tokens are set.

The longer documentation is in the repository's `docs/` directory: how to use the view, the architecture, the graph pipeline, how Claude Code is run, contributing, releasing and troubleshooting.

## Limitations

- Only the first workspace folder is indexed.
- Reloading the window ends your conversations.
- Live updates are incremental, so a few imports can go stale. Reindex fixes them.
- Enabling, disabling or signing in to an MCP server reaches each conversation at its next prompt, not during a turn. A claude.ai connector needs Reconnect after you connect it on claude.ai.

## License

MIT
