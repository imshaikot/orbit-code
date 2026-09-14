#!/usr/bin/env node
// Creates the GitHub release of a v<version> tag with the files given, its notes release-notes.mjs's (that version's
// changelog entries and the downloads) followed by GitHub's generated compare link. When the release already exists,
// from a run that failed after creating it, the files are uploaded again, replacing those of the same name, so a re-run
// finishes the job. Refuses unless every download the notes list is among the files (`--partial` allows fewer).
// release.yml's release job runs it; so does apps/desktop/scripts/publish.mjs, with --partial. Needs gh and GH_TOKEN.
//
//   node tools/scripts/github-release.mjs v<version> <file>... [--partial] [--dry-run]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { assets, releaseNotes } from './release-notes.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const partial = args.includes('--partial');
const [tag, ...files] = args.filter((arg) => !arg.startsWith('--'));

const fail = (message) => {
  console.error(`[release] ${message}`);
  process.exit(1);
};

if (!tag || !/^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(tag)) fail('usage: node tools/scripts/github-release.mjs v<version> <file>... [--partial] [--dry-run]');
if (files.length === 0) fail(`nothing to attach to ${tag}`);
for (const file of files) if (!existsSync(file)) fail(`${file} does not exist`);

let notes;
try {
  notes = releaseNotes(tag);
} catch (error) {
  fail(error.message);
}
const names = new Set(files.map((file) => basename(file)));
const missing = assets(notes.version)
  .map(({ file }) => file)
  .filter((file) => !names.has(file));
if (missing.length > 0 && !partial) fail(`the notes list downloads that aren't among the files: ${missing.join(', ')}`);

if (dryRun) {
  console.log(notes.text);
  console.log(`[release] would create ${tag} (or add to it) with:\n  ${files.join('\n  ')}`);
  process.exit(0);
}

const gh = (ghArgs, stdio = 'inherit') => spawnSync('gh', ghArgs, { stdio }).status === 0;
if (gh(['release', 'view', tag], 'ignore')) {
  console.log(`[release] ${tag} exists already: uploading the files again`);
  let uploaded = false;
  for (let attempt = 1; attempt <= 3 && !uploaded; attempt++) {
    uploaded = gh(['release', 'upload', tag, ...files, '--clobber']);
    if (!uploaded && attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  if (!uploaded) fail(`could not attach the files to ${tag}`);
} else {
  const notesFile = join(mkdtempSync(join(tmpdir(), 'orbit-release-')), 'notes.md');
  writeFileSync(notesFile, notes.text);
  // With --notes-file, --generate-notes appends GitHub's notes (the compare link) after ours.
  const created = gh(['release', 'create', tag, ...files, '--title', `Orbit Code ${notes.version}`, '--notes-file', notesFile, '--generate-notes', '--verify-tag']);
  if (!created) fail(`could not create the release ${tag}`);
}
console.log(`[release] ${tag}: notes from ${notes.changelogs.join(', ')}; ${files.length} file${files.length === 1 ? '' : 's'} attached`);
