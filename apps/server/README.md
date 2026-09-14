# @imshaikot/orbit-code-server

Orbit Code in your browser. [Orbit Code](https://orbit-code.imshaikot.com) ([source](https://github.com/imshaikot/orbit-code)) draws a workspace as a live 3D dependency graph and animates a Claude Code session moving through it. This server runs Orbit for one folder on your own machine, and the web client at [orbit-code.imshaikot.com/web-client/](https://orbit-code.imshaikot.com/web-client/) connects to it. Your code and your Claude Code session stay on your computer: the website only serves the page.

## Requirements

- Node.js 20 or later
- For sessions, [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in; the graph works without it
- A browser that lets a secure page reach `127.0.0.1` (tested in Chrome)

## Usage

In your project folder:

```sh
npx @imshaikot/orbit-code-server
```

The server indexes the folder, listens on `127.0.0.1` (the first free port from 6728 to 6737), prints a link and opens it in your browser:

```
Orbit Code server 0.2.0
  Folder  /Users/you/your-project
  Listen  127.0.0.1:6728
  Log     /Users/you/Library/Caches/orbit-code-server/logs/orbit.log

Open this link to see the workspace. It holds this run's token, so keep it to yourself:
  https://orbit-code.imshaikot.com/web-client/#port=6728&token=…
```

The page connects and shows the workspace, with the same view, sessions, file card and editor as the VS Code extension. If you open [the web client](https://orbit-code.imshaikot.com/web-client/) first, it shows how to start the server, and connects once you open or paste the link. Your browser may ask to let the site reach apps on this device: allow it, since that is how the page reaches the server.

Stop the server with Ctrl+C. The next run prints a new link with a new token, unless you pass `--token`.

## Options

```sh
npx @imshaikot/orbit-code-server [folder] [options]
```

| Option | What it does |
| --- | --- |
| `folder` | The folder to open; the current one by default |
| `--port <port>` | A port from 6728 to 6737, the only ones the web client may reach; by default the first free one |
| `--token <token>` | The token a page must send, 16 to 128 of `A-Z a-z 0-9 - _`; by default a new one each run. Also `ORBIT_SERVER_TOKEN` |
| `--origin <origin>` | Also accept a page from this origin, and link to it; repeatable. For a web client served locally |
| `--no-open` | Print the link without opening the browser (the default when the output isn't a terminal) |
| `--reindex` | Index the folder again, ignoring the saved graph and layout |
| `--max-files <n>` | Index at most this many files (default 20000) |
| `--claude <path>` | The `claude` executable (default: `claude` on your PATH) |
| `--model <name>` | Claude's model |
| `--effort <level>` | Claude's effort level |
| `--permission-mode <mode>` | The permission mode Claude Code starts in |
| `--verbose` | Write the log to the terminal as well |
| `--version`, `--help` | The version (and the protocol version its page speaks), or the options |

## How the connection is kept to you

- The server listens on `127.0.0.1` only.
- It accepts a WebSocket only from a page on `https://orbit-code.imshaikot.com` (and any `--origin` you add), addressed to `127.0.0.1:<port>` or `localhost:<port>`. Another website can't open one, and neither can a DNS rebinding.
- The page's first message must carry this run's token, which the server compares in constant time. The token travels in the link's fragment, which browsers never send to the website, and the page takes it out of the address bar at once.
- The web client's Content Security Policy lets it connect to `ws://127.0.0.1:6728` through `6737` and nowhere else.
- One browser tab at a time: a new one takes over, and the old one says so.
- Starting the server in a folder trusts it: Claude Code runs there with your own settings, as `claude` would in a terminal. Its executable, model, effort and permission mode come from the command line, never from the folder or the page.
- The file card's Delete moves a file to the trash (`trash` on macOS, `gio trash` on Linux, the Recycle Bin on Windows), and is refused where that isn't possible.

## Where it keeps things

In `ORBIT_SERVER_DATA` when set, else the platform's cache directory: `~/Library/Caches/orbit-code-server` on macOS, `$XDG_CACHE_HOME/orbit-code-server` (or `~/.cache/orbit-code-server`) on Linux, `%LOCALAPPDATA%\orbit-code-server` on Windows.

- `workspaces/<hash of the folder>/orbit-v1/`: the graph and its layouts, so the next start in the same folder opens at once
- `logs/orbit.log`: the log (`ORBIT_SERVER_LOG` puts it elsewhere)

## Limits

- One folder per server. Start another server in another folder; it takes the next free port.
- No editor tabs: files open in the page's own editor sheet.
- The Files button opens the file dialog of the machine running the server (AppleScript on macOS, zenity or kdialog on Linux, PowerShell on Windows); without one, it attaches nothing.
- A conversation lives in the server, so reloading the page keeps it, and stopping the server ends it.

## What the package holds

Everything is bundled, so it installs no dependencies:

- `server.mjs`: the `orbit-server` command
- `indexer.mjs`: the indexer, run on a worker thread
- `webview.js`: the workspace's UI
- `web-client.js` and `web-client.json`: the page the website hosts at `/web-client/`, which it takes from this package, with the ports and CSP it needs

## Development

From a clone of the repository:

```sh
yarn server <folder>                                 # build, then start the server on a folder
yarn nx run web-client:serve                         # the web client at http://127.0.0.1:4800/web-client/
yarn server <folder> --origin http://127.0.0.1:4800  # a server that accepts that page
yarn server:smoke                                    # both, end to end, in headless Chrome
```

[packages/web-client/README.md](../../packages/web-client/README.md) covers the page, the handshake and the CSP.

## License

MIT
