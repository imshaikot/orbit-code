# @orbit-code/server

The local server for [Orbit Code](https://github.com/imshaikot/orbit-code), which draws a workspace as a live 3D dependency graph and animates a Claude Code session moving through it.

The server is Orbit's host in one Node process, for places that can't embed Orbit themselves: a browser, a remote machine, or an editor without a web view. It indexes the folder it is started in, runs your own `claude` CLI, and serves the 3D page on `127.0.0.1`.

> **Early.** This version reports its version and nothing more; serving a workspace is tracked in [issue #2](https://github.com/imshaikot/orbit-code/issues/2). For Orbit today, use the VS Code extension or the desktop app.

## Requirements

- Node.js 20 or later
- For sessions, [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in

## Usage

```sh
npx @orbit-code/server --version   # the server's version, and the protocol version its page speaks
npx @orbit-code/server --help
```

## What the package holds

Everything is bundled, so it installs no dependencies:

- `server.mjs`: the `orbit-server` command
- `indexer.mjs`: the indexer, run on a worker thread
- `webview.js`: the page

## License

MIT
