# Using Orbit

This page reads the same whether Orbit runs in VS Code or as the desktop app: the panel is the same bundle in both. Where the two differ, the difference is called out. Installing and configuring each host is in [apps/vscode/README.md](../apps/vscode/README.md) and [apps/desktop/README.md](../apps/desktop/README.md).

## What you are looking at

The graph is your workspace after indexing:

- **A file is a sphere.** Its colour is its language (the legend at the top left lists the kinds present); its size follows the file's size.
- **A directory is a bubble**, inside its parent's bubble. A bubble's colour is the kind most of its files are. A directory that holds nothing but one sub-directory is folded into it, so `src/main/java` shows as one bubble named `main/java`.
- **An import is a line** between the two things that contain its ends at the level you are looking at: file to file inside one directory, file to bubble or bubble to bubble across directories. Imports that land on the same pair share one line.
- **Claude is a star.** While a turn runs it moves to each file Claude reads or edits. A file being read lights cyan as a comet leaves it; a file being edited pulses amber; while Claude thinks, every import line on screen fires.

The view opens in the root's source directory when it has one (`src`, `lib`, `app`, `packages`, …), else at the root. The breadcrumb at the top left says where you are, and each of its parts is a link back up.

## Navigating

| To | Do |
| --- | --- |
| Look inside a directory | Scroll toward its bubble. It comes to the middle of the screen and its contents fade in; once it fills the view, you are inside it. Or click it |
| Go back up | Scroll out, or press **Esc**, or click a part of the breadcrumb |
| Orbit | Drag. The orbit is free all the way around, over the poles too |
| Pan | Right-drag. Panning out of a directory backs out of it |
| See what a file is | Hover it: the tooltip gives its path, kind and size, and how many files it imports and is imported by. A bubble's tooltip gives its file count, sub-directories and dominant kind |
| Do something with a file | Click it: see [The file card](#the-file-card) |

One level up, a directory's own files, lines and sub-bubbles show through its bubble, fainter; two levels up, fainter still, so the import network stays visible from a distance. The directories beside the one you are in stay as faint rims, so the view keeps its place among its neighbours. Only what the directory in view shows takes clicks.

## Views: Nested and Flat

The tabs at the top middle switch views.

- **Nested** is the default: bubbles inside bubbles, one directory to look into at a time.
- **Flat** flies every file out of its directory onto an orbit round the workspace's core. Files are grouped by project (the deepest directory holding a manifest) or by top-level directory, each group along its own arc, in path order; each file is a solid sphere carrying its file type's icon, with its name under it once you are close enough. Imports rise between the spheres as arcs that fire while Claude thinks. Drag to orbit, scroll toward a file to close in on it, click a file for its card. Switching back to Nested returns to the directory you were in.

## Take a Tour

**Take a Tour** at the top right hands the camera over. It flies from stop to stop (a directory, then usually one of its files, then a neighbour or another directory), backs out and swings in between stops rather than cutting, and pauses at each. Some stops get a card of what the graph knows about the place: the most imported file in its directory, the largest, an entry point, a file nothing else imports, the imports crossing a directory's boundary. Scrolling, dragging, Esc and the tabs are off until you press **Stop Tour**, which leaves you wherever the tour got to. A tour is random; starting it again begins a new route.

## Asking Claude

The tab at the bottom middle opens the drawer. Type a prompt and press Enter, or run **Orbit Code: Ask Claude…** in VS Code. Orbit runs your own `claude` command line, so your Claude Code login, settings, `CLAUDE.md`, hooks and MCP servers all apply, exactly as in a terminal. Claude runs only in a trusted workspace: VS Code's workspace trust, or the desktop app's per-folder trust dialog.

The composer's bar holds:

- **Files** opens the host's file dialog; the files chosen become chips and go with the prompt as `@path` mentions, which Claude Code reads into the turn itself.
- **Skills** opens a panel of the skills Claude Code offers (the workspace's `.claude/skills`, your own, and installed plugins'). Drag one onto the composer, click it, or type `/` in the composer to filter them; the first attached skill is invoked as a slash command, the rest are named for Claude to load.
- **The model** picker lists the models Claude Code reports; blank is Claude Code's default.
- **The effort meter** is a ring for the default and a bar per level the chosen model offers. Haiku offers none, so the meter dims for it.
- **The permission mode**: default (your settings decide, and anything gated is asked in the panel), accept edits, or plan. Bypass can only be set in the host's settings, never here.
- **History** opens a timeline of the workspace's earlier conversations, from Claude Code's own transcripts. Narrow the time range with the slider, click a conversation to read what it touched, and **Continue this conversation**: the next prompt resumes it.
- **View conversation** and **New conversation**, above the composer, open the current conversation's transcript and make the next prompt start a fresh one.
- **MCP** (top right of the drawer) opens the MCP view, described below.

A sent prompt flies into a **Claude bubble** at the bottom left, one per running conversation. The bubble shows what Claude is doing; a click opens the conversation.

### Several conversations

A prompt sent from the drawer while the current conversation is busy starts another one beside it, with its own process, bubble and star. Each bubble opens its own transcript. Up to eight conversations are kept; when another starts, the oldest idle one that is not current is let go. **Orbit Code: Stop Claude** (or Stop in a conversation's view) interrupts.

### The conversation view

A click on a bubble opens the transcript: your prompts, Claude's replies as Markdown, each tool call with the file it touched linked (a link opens the file in an editor tab in VS Code, in the editor sheet in the desktop app), and a line per finished turn with its duration and list-price cost. The composer at the bottom has the same controls as the drawer, so a follow-up can switch model or bring skills and files. While the turn runs, **Stop** stands in for Send; you can write the next prompt meanwhile, and it goes once the turn ends. Esc closes the view.

### Permissions and questions

When Claude asks to use a gated tool, a card appears in the conversation view with **Allow**, the "don't ask again" choice Claude Code offers for that request (allow all edits this session, always allow this command in this project), and **Deny**. The bubble turns to "waiting" meanwhile. When Claude asks you questions instead, the card lists them: pick the options (or several, when the question allows) or type your own answer, then **Answer**, or **Skip** them.

With the panel out of sight, a request becomes a notification: in VS Code with the same buttons, in the desktop app with buttons on macOS and a click that reveals the window elsewhere. A question can't be answered from a notification, which offers to open Orbit or skip it.

### Following the star

Click Claude's star and choose **Follow Spark**: the camera eases to it and keeps it in the middle of the screen as it moves, while your own drags and scrolls still work. Click the star again for **Stop Following**. Following pauses while a directory move animates, and drops once the star is gone.

### Subagents

When Claude hands work to a subagent (a Task call), a smaller star comes out of Claude's, waits beside it joined by a faint line, and moves over the files the subagent reads or edits, with comets and MCP stations of its own. Click it for the subagent's output as it comes; that popup stays up after the subagent has finished and its star has gone back. The conversation view shows only the Task call itself.

### MCP servers

A call to an MCP server's tool brings a station out beside Claude's star, joined to it by a beam along which the call and the answer run; stations leave once the turn ends.

The MCP view (the drawer's MCP button, which wears the state most in need of attention) shows every MCP server Claude Code loads as a glyph coloured by its status: connected, connecting, needs sign-in, failed, disabled. A click offers what `/mcp` would: reconnect, enable or disable, sign in or out. A toggle is saved in your Claude Code settings; a sign-in opens the server's page in your browser. **Reload** asks every server again. Each conversation picks up a change at its next prompt, not during a turn; a claude.ai connector authorised on claude.ai needs Reconnect.

## The file card

A click on a file opens a card beside it and rings the file:

| Action | Does |
| --- | --- |
| **View diff** | The file against `HEAD`, offered only when git says it has changes. VS Code opens a diff editor; the desktop app opens the editor sheet's Changes mode |
| **Open** | The editor sheet: a CodeMirror editor at the bottom of the panel with the file's language, Cmd/Ctrl+S to save, a Changes mode with the diff against `HEAD`, and edits made elsewhere taken in as long as you haven't changed anything. Files over 4 MB and binary files don't open there |
| **Open in a tab** | An editor tab beside the panel. VS Code only: the desktop app has no tabs and hides this item |
| **Attach to prompt** | Opens the drawer with the file as a chip |
| **Rename…** | The name is selected without its extension. A file renamed within its directory keeps its place in the graph |
| **Delete…** | The button arms after a moment; the file collapses inside a red ring and the next update removes it. VS Code deletes as a workspace edit (to the trash when `files.enableTrash` is on); the desktop app only ever moves to the trash |

Esc closes the card without moving the camera.

## Live updates

The graph follows your edits, Claude's edits and git checkouts within a few seconds, without laying anything out again: kept files keep their position, a new file is placed in its directory's bubble near what it imports, a new directory gets a bubble inside its parent, and a file Claude writes pulses when it arrives with the star moving to it. Because updates re-read only the files a change affects, a few imports can go stale; **Reindex** (in the legend at the top left, or **Orbit Code: Reindex Workspace**) indexes everything again and lays it out from scratch.

## Around the panel

- **VS Code.** The Orbit icon in the activity bar opens the panel (and hands the side bar back to the Explorer). While the panel is hidden and a turn runs, the status bar shows how many run or wait for approval; a click opens the panel. Settings are the `orbit.*` keys.
- **Desktop app.** One window per folder; File › Open Folder… and Open Recent. The tray menu lists open folders and stops running turns; the dock (macOS) and launcher (Linux) badge counts running turns. Settings are `settings.json` in the app's user data (File › Settings…), never read from a folder.

## Limits worth knowing

- Only the first workspace folder is indexed, and it is the session's working directory.
- Conversations live in the host process: reloading the VS Code window or quitting the desktop app starts new ones. History continues earlier ones, without replaying their transcript into the view.
- View diff compares with `HEAD`, not with a branch's merge base.
- A rename made in the Explorer or by git reaches Orbit as a delete and a create, so the file is placed again; only renames made from the card keep a file's place.
- The Flat layout is computed in the page and not cached, so a reload can place files a live update added elsewhere.
