// CodeMirror for the editor sheet: the extensions every editor gets, a theme and syntax colours in Orbit's palette,
// and a file's language from its VS Code language id, or its extension when VS Code knows none.

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, type StreamParser, StreamLanguage, bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { clojure } from '@codemirror/legacy-modes/mode/clojure';
import { cmake } from '@codemirror/legacy-modes/mode/cmake';
import { csharp, dart, kotlin, scala } from '@codemirror/legacy-modes/mode/clike';
import { crystal } from '@codemirror/legacy-modes/mode/crystal';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { elm } from '@codemirror/legacy-modes/mode/elm';
import { erlang } from '@codemirror/legacy-modes/mode/erlang';
import { groovy } from '@codemirror/legacy-modes/mode/groovy';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { julia } from '@codemirror/legacy-modes/mode/julia';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
import { r } from '@codemirror/legacy-modes/mode/r';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { extensionOf } from '../../shared/languages';

type Language = { label: string; load: () => Extension };

const legacy = (label: string, parser: StreamParser<unknown>): Language => ({ label, load: () => StreamLanguage.define(parser) });

/** By VS Code language id. */
const LANGUAGES: Record<string, Language> = {
  typescript: { label: 'TypeScript', load: () => javascript({ typescript: true }) },
  typescriptreact: { label: 'TypeScript JSX', load: () => javascript({ typescript: true, jsx: true }) },
  javascript: { label: 'JavaScript', load: () => javascript() },
  javascriptreact: { label: 'JavaScript JSX', load: () => javascript({ jsx: true }) },
  json: { label: 'JSON', load: json },
  jsonc: { label: 'JSON with Comments', load: json },
  css: { label: 'CSS', load: css },
  scss: { label: 'SCSS', load: css },
  less: { label: 'Less', load: css },
  html: { label: 'HTML', load: html },
  vue: { label: 'Vue', load: html },
  svelte: { label: 'Svelte', load: html },
  markdown: { label: 'Markdown', load: markdown },
  python: { label: 'Python', load: python },
  rust: { label: 'Rust', load: rust },
  go: { label: 'Go', load: go },
  java: { label: 'Java', load: java },
  c: { label: 'C', load: cpp },
  cpp: { label: 'C++', load: cpp },
  'objective-c': { label: 'Objective-C', load: cpp },
  'objective-cpp': { label: 'Objective-C++', load: cpp },
  php: { label: 'PHP', load: php },
  yaml: { label: 'YAML', load: yaml },
  dockercompose: { label: 'Compose', load: yaml },
  xml: { label: 'XML', load: xml },
  sql: { label: 'SQL', load: sql },
  shellscript: legacy('Shell', shell),
  ruby: legacy('Ruby', ruby),
  swift: legacy('Swift', swift),
  kotlin: legacy('Kotlin', kotlin),
  scala: legacy('Scala', scala),
  csharp: legacy('C#', csharp),
  dart: legacy('Dart', dart),
  toml: legacy('TOML', toml),
  dockerfile: legacy('Dockerfile', dockerFile),
  lua: legacy('Lua', lua),
  perl: legacy('Perl', perl),
  haskell: legacy('Haskell', haskell),
  elm: legacy('Elm', elm),
  erlang: legacy('Erlang', erlang),
  clojure: legacy('Clojure', clojure),
  r: legacy('R', r),
  julia: legacy('Julia', julia),
  powershell: legacy('PowerShell', powerShell),
  proto3: legacy('Protocol Buffers', protobuf),
  properties: legacy('Properties', properties),
  ini: legacy('INI', properties),
  cmake: legacy('CMake', cmake),
  groovy: legacy('Groovy', groovy),
  crystal: legacy('Crystal', crystal),
  diff: legacy('Diff', diff),
};

/** For files VS Code reported as plain text (no extension installed for them). */
const BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.mjs': 'javascript',
  '.cjs': 'javascript', '.jsx': 'javascriptreact', '.json': 'json', '.css': 'css', '.scss': 'scss', '.less': 'less', '.html': 'html',
  '.htm': 'html', '.vue': 'vue', '.svelte': 'svelte', '.md': 'markdown', '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.m': 'objective-c', '.mm': 'objective-cpp', '.php': 'php',
  '.yaml': 'yaml', '.yml': 'yaml', '.xml': 'xml', '.sql': 'sql', '.sh': 'shellscript', '.bash': 'shellscript', '.zsh': 'shellscript',
  '.rb': 'ruby', '.swift': 'swift', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.cs': 'csharp', '.dart': 'dart',
  '.toml': 'toml', '.lua': 'lua', '.pl': 'perl', '.hs': 'haskell', '.elm': 'elm', '.erl': 'erlang', '.clj': 'clojure', '.r': 'r',
  '.jl': 'julia', '.ps1': 'powershell', '.proto': 'proto3', '.properties': 'properties', '.ini': 'ini', '.cmake': 'cmake',
  '.groovy': 'groovy', '.gradle': 'groovy', '.cr': 'crystal', '.diff': 'diff', '.patch': 'diff',
};

const BY_BASENAME: Record<string, string> = { Dockerfile: 'dockerfile', Containerfile: 'dockerfile', 'CMakeLists.txt': 'cmake', Gemfile: 'ruby', Rakefile: 'ruby' };

/** The language to highlight `path` as, and its name for the status line. */
export function languageOf(languageId: string, path: string): { label: string; extension: Extension } {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const id = LANGUAGES[languageId] ? languageId : (BY_BASENAME[name] ?? BY_EXTENSION[extensionOf(name)]);
  const language = id ? LANGUAGES[id] : undefined;
  return language ? { label: language.label, extension: language.load() } : { label: languageId === 'plaintext' ? 'Plain text' : languageId, extension: [] };
}

const theme = EditorView.theme(
  {
    '&': { height: '100%', color: 'var(--ink)', backgroundColor: 'transparent', fontSize: 'var(--vscode-editor-font-size, 12.5px)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--code)', lineHeight: '1.6' },
    '.cm-content': { padding: '10px 0 24px', caretColor: 'var(--claude)' },
    '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--claude)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(165, 139, 255, 0.3)',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(160, 178, 240, 0.05)' },
    '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--ink-faint)', border: 'none', paddingLeft: '8px' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink-soft)' },
    '.cm-foldPlaceholder': { backgroundColor: 'rgba(160, 178, 240, 0.12)', border: 'none', color: 'var(--ink-soft)', padding: '0 6px' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(111, 227, 255, 0.12)' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(187, 168, 255, 0.22)', outline: '1px solid rgba(187, 168, 255, 0.5)' },
    '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'rgba(255, 143, 154, 0.25)' },
    '.cm-searchMatch': { backgroundColor: 'rgba(255, 210, 138, 0.2)', outline: '1px solid rgba(255, 210, 138, 0.45)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(255, 178, 62, 0.42)' },
    '.cm-panels': { backgroundColor: 'rgba(6, 9, 22, 0.96)', color: 'var(--ink)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--rule)' },
    '.cm-panel.cm-search': { padding: '6px 10px', fontFamily: 'var(--ui)', fontSize: '12px' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'var(--ui)', fontSize: '12px', color: 'var(--ink)', borderRadius: '999px' },
    '.cm-panel.cm-search input[type=text]': { background: 'var(--field)', border: '1px solid var(--rule)', padding: '3px 9px' },
    '.cm-panel.cm-search button': { background: 'rgba(10, 16, 36, 0.9)', border: '1px solid var(--rule)', padding: '2px 10px', backgroundImage: 'none' },
    '.cm-panel.cm-search label': { color: 'var(--ink-soft)' },
    // The diff against HEAD: added and changed lines green, what HEAD had red, gutter markers in the same colours.
    '.cm-changedLine': { backgroundColor: 'rgba(125, 255, 176, 0.07)' },
    '.cm-insertedLine': { backgroundColor: 'rgba(125, 255, 176, 0.07)' },
    '.cm-changedText': { backgroundColor: 'rgba(125, 255, 176, 0.24)', borderRadius: '2px' },
    '.cm-deletedChunk': { backgroundColor: 'rgba(255, 143, 154, 0.09)', paddingLeft: '6px' },
    '.cm-deletedChunk .cm-deletedText, .cm-deletedLine .cm-deletedText': { backgroundColor: 'rgba(255, 143, 154, 0.26)', borderRadius: '2px' },
    '.cm-changeGutter': { width: '3px', paddingLeft: '2px' },
    '.cm-changedLineGutter': { backgroundColor: '#7dffb0' },
    '.cm-deletedLineGutter': { backgroundColor: '#ff8f9a' },
    '.cm-collapsedLines': {
      color: 'var(--ink-faint)',
      backgroundColor: 'rgba(160, 178, 240, 0.06)',
      backgroundImage: 'none',
      fontFamily: 'var(--ui)',
      fontSize: '11.5px',
      padding: '3px 12px',
    },
    '.cm-chunkButtons': { display: 'none' },
  },
  { dark: true },
);

/** Mid-lightness hues that stay readable on the glass, and clear of the red and green the diff uses. */
const syntax = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.self], color: '#c4aeff' },
  { tag: [t.string, t.special(t.string), t.character, t.regexp], color: '#a6dcc0' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: '#ffbd8a' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'rgba(186, 198, 242, 0.52)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: '#86d8ff' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: '#ffd89a' },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: '#b9c6ff' },
  { tag: [t.tagName, t.angleBracket], color: '#f6a4d0' },
  { tag: [t.variableName, t.definition(t.variableName)], color: '#e6ebff' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator], color: 'rgba(214, 222, 255, 0.72)' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: '#9eaadd' },
  { tag: t.heading, color: '#e6ebff', fontWeight: '600' },
  { tag: [t.link, t.url], color: '#6fe3ff', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, color: '#ff8f9a' },
]);

/** Everything but the document, the language and the diff. `save` runs on Mod-S. */
export function editorExtensions(save: () => void, nonce: string | undefined): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(syntax, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: false }),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (save(), true) },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    theme,
    // CodeMirror injects its own styles; under the webview CSP they need the page nonce.
    nonce ? EditorView.cspNonce.of(nonce) : [],
  ];
}
