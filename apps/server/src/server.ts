// The orbit-server command. For now it only says what it is: the host itself (the page on 127.0.0.1, the protocol
// over a WebSocket, the shared controller) is still to come, so any other invocation refuses to run.

import { PROTOCOL_VERSION } from '@orbit-code/protocol';

/** package.json's version, set by build.mjs. */
declare const ORBIT_SERVER_VERSION: string;

const USAGE = `orbit-server ${ORBIT_SERVER_VERSION}

Usage:
  orbit-server --version   the server's version, and the protocol version its page speaks
  orbit-server --help      this text
`;

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${ORBIT_SERVER_VERSION} (protocol ${PROTOCOL_VERSION})\n`);
} else if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(USAGE);
} else {
  process.stderr.write(`orbit-server ${ORBIT_SERVER_VERSION} can't serve a workspace yet.\n\n${USAGE}`);
  process.exitCode = 1;
}
