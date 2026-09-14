# Orbit Code

Open-source, live 3D visuals for Claude Code in VS Code: your codebase as a dependency graph, with Claude working through it as you watch.

[![Claude Code refactoring a file in Orbit Code: its star moves through the 3D dependency graph, the view turns Flat, and a permission card asks to allow a command](https://raw.githubusercontent.com/imshaikot/orbit-code/main/docs/media/orbit-code-demo.webp)](https://orbit-code.imshaikot.com/#demo-title)

Directories are bubbles, files are spheres, imports are lines. Files Claude reads light up cyan, files it edits pulse amber, and the import network fires while it thinks. [Watch the full demo (1:44).](https://orbit-code.imshaikot.com/#demo-title)

**Website:** [orbit-code.imshaikot.com](https://orbit-code.imshaikot.com), with the [install guide](https://orbit-code.imshaikot.com/install/), the [docs](https://orbit-code.imshaikot.com/docs/) and the [changelog](https://orbit-code.imshaikot.com/changelog/).

## See your codebase

- **A dependency graph for most languages.** JS and TS, Python, Go, Rust, Java, Kotlin and Scala, C and C++, C#, Swift, Ruby, PHP, Dart, Elixir and more, with CSS, HTML, shell scripts and Terraform alongside. Imports resolve through each project's own config (`tsconfig`, `go.mod`, `Cargo.toml`, `pyproject.toml`, …), so monorepos work too, and configuration files link to the files and projects they name.
- **Read it at a glance.** Colour is file type, and the legend at the top left lists the kinds present. Hover a file for its path, size, and how many files it imports and is imported by; hover a bubble for what it holds.
- **Nested or Flat.** The tabs at the top switch views. Nested shows directories as bubbles inside bubbles, one to look into at a time, with the level above showing through. Flat puts every file on an orbit around the workspace, each project or top-level directory along its own arc, each file a sphere with its file type's icon and its name, with the imports arching between them.
- **Live updates.** The graph follows your edits, Claude's edits and git checkouts within seconds. Files keep their place, and a new one is placed in its directory beside what it imports. An update reads again only the files a change affects, so it stays quick in workspaces of many thousands of files.
- **Take a Tour.** The button at the top right flies the camera round the workspace on its own, directory to file to directory, and pauses a moment at each, now and then with a card of what the graph knows about it: the most imported file in its directory, the largest, an entry point, a directory nothing outside imports from. Press Stop Tour to take the camera back.

## Watch Claude work

- **Claude in the panel.** Prompt from the drawer at the bottom, or run **Orbit Code: Ask Claude…**. Orbit runs your own `claude`, so your login, settings, `CLAUDE.md`, hooks and MCP servers apply exactly as in a terminal.
- **Several conversations at once.** A prompt sent while Claude is busy starts another conversation beside the first, with a star of its own. Each running conversation gets a bubble at the bottom left; a click opens its transcript, with Claude's replies as Markdown, every file it touched linked, and the duration and cost of each turn.
- **Follow Spark.** Click Claude's star and choose Follow Spark: the camera keeps the star in the middle of the screen as it moves, and your own drags and scrolls still work.
- **Subagents.** When Claude hands work to a subagent, a smaller star comes out of Claude's and moves over the files the subagent reads and edits. Click it to read the subagent's output as it comes.
- **Permissions and questions.** Allow, Deny or the "don't ask again" choice Claude Code offers, from a card in the panel, or from a notification when Orbit is hidden. When Claude asks you questions, pick its options or type your own answer on the same card, or skip them.
- **MCP servers.** A call to an MCP tool brings a station out beside Claude's star. The MCP button at the top right of the drawer shows every server Claude Code loads, and whether it is connected, needs sign-in, failed or is disabled. Reload them, or sign in, reconnect, enable or disable one; the change is saved in your Claude Code settings, as `/mcp` saves it.

## Give Claude context

- **Model, effort and permission mode.** The composer lists the models Claude Code reports, an effort meter with a bar per level the chosen model offers, and default, accept edits or plan. A conversation's own composer has the same controls, so a follow-up can switch model, and you can write it while Claude is still working: it goes when the turn ends.
- **Skills.** Type `/` in the composer to find a skill by name, or open the Skills panel and drag one in. Your workspace's skills, your own and those of installed plugins are all there.
- **Files.** Attach files from a dialog, or any file in the graph from its card. They go with the prompt as `@path` mentions, which Claude Code reads into the turn.
- **History.** A timeline of the workspace's earlier Claude Code conversations. Narrow it by time, open one to see what it touched, and continue it.

## Work on files from the graph

Click a file and a card opens beside it:

| Action | |
| --- | --- |
| View diff | The file against `HEAD`, offered when git says it has changes |
| Open | An editor at the bottom of the panel, with syntax highlighting, Cmd/Ctrl+S to save, and a Changes mode showing the diff against `HEAD` |
| Open in a tab | A regular editor tab beside the panel |
| Attach to prompt | The drawer opens with the file attached |
| Rename… | A file renamed within its directory keeps its place in the graph |
| Delete… | The button arms after a moment; the file collapses and leaves the graph. It goes to the trash when `files.enableTrash` is on |

## Requirements

- VS Code 1.100+
- [Claude Code](https://docs.claude.com/en/docs/claude-code), installed and logged in. Without it, you still get the graph.

## Install

Search for **Orbit Code** in the Extensions view, or run:

```sh
code --install-extension imshaikot.orbit-code
```

In Cursor, Windsurf, VSCodium and other VS Code based editors, the install script puts the newest release into every editor it finds. Run it again to update.

```sh
curl -fsSL https://orbit-code.imshaikot.com/install.sh | sh   # macOS and Linux
irm https://orbit-code.imshaikot.com/install.ps1 | iex        # Windows PowerShell
```

The [install guide](https://orbit-code.imshaikot.com/install/) has every option, and how each one updates.

Reload VS Code, then click the Orbit icon in the activity bar or run **Orbit Code: Open**. The view opens in your source directory (`src`, `lib`, `app`, `packages`, …) when there is one.

## Getting around

| To | Do |
| --- | --- |
| Look inside a directory | Scroll toward its bubble: it comes to the middle of the screen and opens once it fills the view. Or click it |
| Go back up | Scroll out, press Esc, or click a part of the breadcrumb at the top left |
| Orbit | Drag, all the way around |
| Pan | Right-drag. Panning out of a directory backs out of it |
| Do something with a file | Click it |

The directories beside the one you are in stay as faint rims, so you keep your place. In the Flat view, drag to orbit, scroll toward any file to close in on it, and click a file as in the Nested view; switching back returns to the directory you were in.

## Around VS Code

- **Activity bar.** The Orbit icon opens the panel, which takes the editor area and collapses the side bar.
- **Status bar.** While the panel is hidden, it shows how many turns are running, or waiting for your approval. Click it to come back.
- **Workspace trust.** The graph works in any workspace; Claude runs only once the workspace is trusted. The `claude` path, extra arguments and permission mode are machine settings, so a repository's own settings can't change them.
- **On your machine.** Indexing and layout run locally, and the panel has no network access. Claude Code talks to Anthropic as it does in a terminal.

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
| `orbit.claude.model` | `""` | Model, e.g. `opus` or `sonnet`. Empty is Claude Code's default |
| `orbit.claude.effort` | `""` | `low`, `medium`, `high`, `xhigh` or `max`. Empty is Claude Code's default |
| `orbit.claude.permissionMode` | `default` | `default`, `acceptEdits`, `plan` or `bypassPermissions` |
| `orbit.claude.extraArgs` | `[]` | Extra arguments for every `claude` run |
| `orbit.maxFiles` | `20000` | The most files Orbit indexes |

The model and effort picked in the panel apply until the window reloads. Bypass permissions can only be set here, never from the panel.

## Limitations

- Only the first workspace folder is indexed.
- Reloading the window ends your conversations. History can continue them, without showing their earlier transcript.
- Live updates are incremental, so a few imports can go stale. Reindex fixes them.
- View diff compares with `HEAD`, not with a branch's merge base.
- A rename made in the Explorer or by git places the file again; only renames from the file card keep its place.
- Enabling, disabling or signing in to an MCP server reaches each conversation at its next prompt, not during a turn. A claude.ai connector needs Reconnect after you connect it on claude.ai.

## Learn more

- [Using Orbit](https://orbit-code.imshaikot.com/docs/using-orbit/): the view, prompting Claude, the file card, the Flat view and the tour, in full
- [Settings and commands](https://orbit-code.imshaikot.com/docs/settings/)
- [Claude in Orbit](https://orbit-code.imshaikot.com/docs/claude-session/): how your `claude` is run, and what each thing it does looks like
- [Troubleshooting](https://orbit-code.imshaikot.com/docs/troubleshooting/): logs, caches and known failures

Orbit Code is open source. Report a bug or ask for a feature in the [issues](https://github.com/imshaikot/orbit-code/issues); the [contributing guide](https://orbit-code.imshaikot.com/docs/contributing/) covers building it yourself.

## License

MIT
