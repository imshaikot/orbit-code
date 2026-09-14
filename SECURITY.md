# Security policy

## Supported versions

Fixes go into the next release. Older releases don't get backports.

| Part | Supported |
| --- | --- |
| The VS Code extension, `imshaikot.orbit-code` (`v*` releases) | The latest release |
| The desktop app (the same `v*` releases) | The latest release |
| `@orbit-code/indexer` on npm | The latest version |
| `main` | Yes |

## Reporting a vulnerability

**Please don't report a vulnerability in a public issue, pull request or comment.**

Report it privately on GitHub: **[Report a vulnerability](https://github.com/imshaikot/orbit-code/security/advisories/new)** (the Security tab, then Report a vulnerability). Only the maintainer can see it.

Please include:

- the part and version (extension, desktop app or indexer), the editor, and the operating system;
- what an attacker controls (a file in a folder the user opens, a message from the page, a setting, an MCP server's answers) and what they gain;
- steps to reproduce, ideally with the smallest workspace that shows it;
- any log lines that help, with secrets removed.

Orbit Code has one maintainer, so allow a few days for a first reply in the advisory. Once the report is confirmed, the fix is prepared in private, released, and then the advisory is published. It credits you unless you'd rather not be named. Please keep the details private until the advisory is out.

## Scope

Orbit opens folders that may not be trusted, and runs the user's own `claude` CLI on their behalf. In scope:

- Content in an opened folder (a source file, a manifest, a tsconfig, a file name) that runs code, reads or writes outside the folder, or starts Claude while the folder isn't trusted.
- The page escaping its sandbox in VS Code or the desktop app: getting around the Content Security Policy, reaching the network, or injecting HTML from transcript, tool or file text.
- A message from the page that makes the host:
  - read, write, rename or delete a file outside the workspace;
  - open anything but an http(s) sign-in page;
  - pass unchecked arguments to the `claude` CLI (a model name, an effort level, a permission mode, a conversation id to resume).
- Turning on `bypassPermissions` from anywhere but the user's own settings, or allowing a tool Claude asked for without the user choosing it.
- MCP server credentials, or sign-in URLs, reaching the page, the log or a transcript.
- The desktop app's `orbit://` scheme serving anything but its page, or its preload exposing more than `orbitHost.postMessage`.
- The CI or release workflows exposing a secret, or publishing something other than what a tag built.

Out of scope:

- **Vulnerabilities in Claude Code itself**: report them to Anthropic, as [Claude Code's security policy](https://github.com/anthropics/claude-code/security/policy) describes.
- What Claude does with a permission you granted. Once you choose Allow, or the choice not to ask again, Claude Code acts as it would in a terminal.
- Settings you set yourself, such as `orbit.claude.path` and `orbit.claude.extraArgs`. A way around their restriction in untrusted workspaces is in scope.
- The desktop builds being unsigned, and the warnings macOS and Windows show for that.
- A dependency advisory with no way to reach the vulnerable code from Orbit.
