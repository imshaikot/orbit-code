## 0.2.2 (2026-09-14)

### 🩹 Fixes

- Orbit Code's homepage is now orbit-code.imshaikot.com, with the install guide, docs and changelog. The extension's Marketplace page is rewritten around what it does: the graph, Claude at work in it, the context you give Claude, the file card, commands and settings, with the demo at the top. ([1f8c41c](https://github.com/imshaikot/orbit-code/commit/1f8c41c))

## 0.2.1 (2026-09-14)

### 🩹 Fixes

- The Marketplace listing gets the extension's icon, and a description in Orbit Code's own words: an open-source, live 3D visual alternative to Claude Code in the terminal, for programmers and vibe coders alike. ([df71e87](https://github.com/imshaikot/orbit-code/commit/df71e87))

## 0.2.0 (2026-09-14)

### 🚀 Features

- First release: the workspace as a 3D force-directed dependency graph, with a live Claude Code session moving through it. ([5901902](https://github.com/imshaikot/orbit-code/commit/5901902))
  Directories are bubbles, files are nodes and imports are lines, for JS/TS, Python, Go, Rust, Java, C#, Swift, PHP, Dart and more, resolved through each project's own config. The graph follows edits within seconds and keeps its layout. Nested and Flat views, and Take a Tour.
  Claude Code in the panel: prompts from the drawer or **Orbit Code: Ask Claude…**, model, effort and permission mode, several conversations at once, permission and question cards, skills, attached files, history, MCP servers, subagents drawn as their own stars, and Follow Spark. Files Claude reads light up, files it edits pulse, and the import network fires while it thinks.
  File actions from the graph: diff, edit inline, rename, delete, attach to a prompt.