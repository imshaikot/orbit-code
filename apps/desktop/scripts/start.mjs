#!/usr/bin/env node
// Starts the desktop app from apps/desktop/dist in the Electron the workspace installed. `yarn desktop` runs it through
// Nx (desktop:start), which builds first. A relative --folder is taken from the workspace root, where yarn runs.
//
//   yarn desktop [--folder <path>] [--reindex] [--disable-workspace-trust]

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { app } from './builder.mjs';

const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env };
// Inherited from a shell VS Code started (Claude Code in VS Code, say), it would start Electron as plain Node.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [app, ...process.argv.slice(2)], { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
