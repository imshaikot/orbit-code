#!/usr/bin/env node
// The notes of a v<version> GitHub release: that version's section of each app's CHANGELOG.md, which `nx release`
// writes from the version plans, each entry once (the extension and the desktop app are one release group, so both
// changelogs usually carry the same entries), then what the release holds. Fails when no changelog has a section for
// the version, so a tag cut without `nx release` makes no release. release.yml runs it; so does the release skill.
//
//   node tools/scripts/release-notes.mjs v<version> [--out <file>]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const workspace = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The changelogs of the `apps` release group (nx.json), in the order their entries are listed. */
export const CHANGELOGS = ['apps/vscode/CHANGELOG.md', 'apps/desktop/CHANGELOG.md'];

/** What a release of `version` holds, as release.yml builds it. */
export const assets = (version) => [
  { file: `orbit-code-${version}.vsix`, label: 'VS Code, Cursor, VSCodium, Windsurf' },
  { file: `orbit-code-${version}-mac-arm64.dmg`, label: 'macOS, Apple silicon' },
  { file: `orbit-code-${version}-mac-x64.dmg`, label: 'macOS, Intel' },
];

/** The body of a version's section: the lines after its `## <version>` heading, up to the next `## ` heading. */
export function changelogSection(text, version) {
  const lines = text.split('\n');
  const heading = new RegExp(`^## \\[?${version.replaceAll('.', '\\.')}\\]?(\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return undefined;
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, next < 0 ? lines.length : next).join('\n');
}

/** What Nx writes for a project a plan didn't name, but its fixed group bumped anyway: nothing a user needs to read. */
const BUMP_ONLY = /^This was a version bump only for /;
/** The commit link of a plan that was never committed: `([](…/commit/))`. */
const EMPTY_LINK = /\s*\(\[\]\([^)]*\)\)/g;

/** Entries by `### ` heading: each entry a bullet with its indented continuation lines. */
function entries(section, into) {
  let heading = '';
  let entry;
  for (const raw of section.split('\n')) {
    const line = raw.replace(EMPTY_LINK, '');
    if (BUMP_ONLY.test(line)) {
      entry = undefined;
    } else if (line.startsWith('### ')) {
      heading = line;
      entry = undefined;
    } else if (/^\s+\S/.test(line) && entry) {
      entry.push(line);
    } else if (line.trim()) {
      entry = [line];
      if (!into.has(heading)) into.set(heading, []);
      into.get(heading).push(entry);
    } else {
      entry = undefined;
    }
  }
  return into;
}

export function releaseNotes(tag) {
  const version = tag.replace(/^v/, '');
  const found = [];
  const merged = new Map();
  for (const path of CHANGELOGS) {
    const file = join(workspace, path);
    const section = existsSync(file) ? changelogSection(readFileSync(file, 'utf8'), version) : undefined;
    if (section === undefined) continue;
    found.push(path);
    entries(section, merged);
  }
  if (found.length === 0) {
    throw new Error(`no "## ${version}" section in ${CHANGELOGS.join(' or ')}: cut the release with \`yarn nx release\`, which writes it`);
  }

  const out = [];
  for (const [heading, list] of merged) {
    const seen = new Set();
    const unique = list.map((entry) => entry.join('\n')).filter((text) => !seen.has(text) && seen.add(text));
    if (unique.length === 0) continue;
    if (heading) out.push(heading, '');
    out.push(...unique, '');
  }
  out.push(
    '### Downloads',
    '',
    ...assets(version).map(({ file, label }) => `- **${label}:** \`${file}\``),
    '',
    'The extension is also on the Visual Studio Marketplace and Open VSX as `imshaikot.orbit-code`, and [orbit-code.imshaikot.com/install](https://orbit-code.imshaikot.com/install/) has every way to install and update. The macOS app is not signed with a Developer ID yet, so macOS stops its first launch: open **System Settings → Privacy & Security** and choose **Open Anyway**.',
    '',
  );
  return { version, changelogs: found, text: out.join('\n') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
  const [tag] = args;
  if (!tag || !/^v?\d+\.\d+\.\d+(-[\w.]+)?$/.test(tag)) {
    console.error('usage: node tools/scripts/release-notes.mjs v<version> [--out <file>]');
    process.exit(2);
  }
  try {
    const { text, changelogs } = releaseNotes(tag);
    if (out) {
      writeFileSync(out, text);
      console.log(`[release] notes for ${tag} from ${changelogs.join(', ')} written to ${out}`);
    } else {
      process.stdout.write(text);
    }
  } catch (error) {
    console.error(`[release] ${error.message}`);
    process.exit(1);
  }
}
