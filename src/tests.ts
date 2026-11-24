import { JevHttpError, tryNoulAnswer } from './request.js';
import {
  C_SYNTAX,
  CHAR_LITERAL,
  COMMENT,
  CSHARP_SYNTAX,
  DART_SYNTAX,
  ELIXIR_SYNTAX,
  GO_SYNTAX,
  JS_SYNTAX,
  JVM_SYNTAX,
  LITERAL,
  LUA_SYNTAX,
  PHP_SYNTAX,
  PYTHON_SYNTAX,
  R_SYNTAX,
  RUBY_SYNTAX,
  RUST_SYNTAX,
  SHELL_SYNTAX,
  SWIFT_SYNTAX,
  ZIG_SYNTAX,
  createSource,
  findBody,
  isBalanced,
  isWordChar,
  lineStartOf,
  matchingClose,
  skipTrivia,
} from './scan.js';
import type { Source, Syntax } from './scan.js';
import { estimateTokens } from './state.js';
import type { JevAsker, JevQuestions } from './types.js';

export { CHAR_LITERAL };

export const DEFAULT_TEST_DELETE_THRESHOLD = 0.1;

export const DEFAULT_MAX_TEST_REQUEST_TOKENS = 30_000;

export const DEFAULT_MAX_VERIFY_RUNS = 30;

export const TEST_STATE_CONTEXT = [
  "You are auditing a repository's unit test suite and removing tests that protect nothing.",
  '`tests` lists unit test functions with their source. Each question asks whether one test should be kept.',
  'Default to NOT keeping. A test earns a keep only if it would fail when a realistic bug is introduced into the code it exercises.',
  'Treat a test as NOT worth keeping if ANY of these hold:',
  '(1) it is empty, skipped, marked todo, or has no assertion;',
  '(2) it only checks that something is defined, truthy, an instance of a type, or does not throw, without checking the returned value or resulting state;',
  '(3) it only re-asserts a constant, default, or value that the test itself set up, so it can only fail when the test is edited;',
  '(4) it only checks that a mock or spy was called, with no check on the result or on observable behaviour;',
  '(5) it repeats another test in this batch with trivial variation of the same setup and assertions;',
  '(6) it is snapshot-only, type-only, or checks that a function or export exists;',
  '(7) its assertions are tautological (for example expect(x).toBe(x)) or can never fail.',
  'Keep a test only when it asserts specific observable outcomes (returned values, state changes, thrown or emitted errors, file or output side effects) for a meaningful input, including edge or failure cases.',
  'You only see this batch, so do not assume a duplicate exists elsewhere in the suite.',
  "If a source ends with '…', it was truncated: judge only the visible part, and keep the test only if the visible assertions already meet the bar.",
].join(' ');

export interface TestFunction {
  id: string;
  file: string;
  name: string;
  start: number;
  end: number;
  source: string;
}

export interface TestDeletion {
  id: string;
  file: string;
  name: string;
  keepTest: number;
}

export type SkipReason =
  | 'unscored'
  | 'unreadable'
  | 'changed'
  | 'mismatch'
  | 'write_failed'
  | 'verify_failed'
  | 'last_in_file';

export interface TestSkip {
  id: string;
  file: string;
  name: string;
  reason: SkipReason;
  keepTest: number | null;
}

export interface PruneTestsResult {
  files: number;
  tests: number;
  requests: number;
  deleted: TestDeletion[];
  scores: Array<{ id: string; file: string; name: string; keepTest: number }>;
  skipped: TestSkip[];
  errors: string[];
  removedFiles: string[];
  verifyRuns: number;
}

export type VerifyOutcome = boolean | { ok: boolean; output?: string };

export interface TestFileAccess {
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  remove?(path: string): Promise<void>;
  verify?(paths: string[]): Promise<VerifyOutcome>;
}

export interface PruneTestsOptions {
  goal?: string;
  deleteThreshold?: number;
  maxRequestTokens?: number;
  sourceChars?: number;
  concurrency?: number;
  retries?: number;
  maxVerifyRuns?: number;
  keepAtLeastOnePerFile?: boolean;
  removeEmptyFiles?: boolean;
  signal?: AbortSignal;
}

type RawTest = Omit<TestFunction, 'id'>;
type Extractor = (file: string, source: Source) => RawTest[];
type AttributeStyle = 'hash' | 'at' | 'bracket';

interface Language {
  files: RegExp;
  syntax: Syntax;
  strict: boolean;
  extract: Extractor;
  finish?: (text: string, original: string) => string;
  prune?: (source: Source, removed: readonly Range[]) => Range[];
  emptyFileFails?: boolean;
}

export const IGNORED_DIRECTORY =
  /(^|\/)(node_modules|dist|build|target|out|bin|obj|vendor|third_party|Pods|\.git|\.gradle|\.build|\.dart_tool|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.cargo|\.idea|\.vscode|\.yarn|\.pnpm-store|\.tox|\.mypy_cache|\.pytest_cache|_build|deps|coverage|__pycache__|venv|\.venv|site-packages)\//;

const JVM_TEST =
  /^@(?:[\w$]+\.)*(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Theory|Property)\b/;
const CSHARP_TEST =
  /(?:^\[|,)\s*(?:[\w]+\.)*(?:Test|TestCase|TestCaseSource|Fact|Theory|TestMethod|DataTestMethod|SkippableFact)\b/;
const RUST_TEST =
  /^#\[\s*(?:[A-Za-z_]\w*\s*::\s*)*(?:test|rstest|test_case|wasm_bindgen_test|quickcheck|proptest)\b/;
const PHP_TEST = /^#\[\s*(?:\\?[\w]+\\)*Test\b/;
const SIGNATURE_NAME = /([\w$]+|`[^`\n]+`)\s*\(/;
const AT_NAME = /@[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*/y;
const MACRO_RULES = /\bmacro_rules\s*!\s*[A-Za-z_]\w*\s*(?=[({[])/g;
const BLANK_LINE = /[ \t]*(?:\r?\n|$)/y;
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'with', 'switch', 'catch']);
const CONTINUATION_KEYWORDS = new Set([
  'else',
  'do',
  'return',
  'yield',
  'await',
  'new',
  'typeof',
  'void',
  'delete',
  'throw',
  'case',
  'in',
  'of',
]);

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineDepths(source: Source, starts: readonly number[]): number[] {
  const { text, mask } = source;
  const depths: number[] = [];
  let depth = 0;
  let cursor = 0;
  for (const start of starts) {
    for (; cursor < start; cursor += 1) {
      if (mask[cursor] !== 0) continue;
      const c = text[cursor]!;
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
    }
    depths.push(Math.max(0, depth));
  }
  return depths;
}

function statementEnd(source: Source, end: number, semicolon: boolean, strict: boolean): number {
  const { text, mask } = source;
  const n = text.length;
  let i = end;
  while (text[i] === ' ' || text[i] === '\t') i += 1;
  let stop = end;
  if (semicolon && text[i] === ';' && mask[i] === 0) {
    i += 1;
    stop = i;
  }
  while (i < n && (text[i] === ' ' || text[i] === '\t' || mask[i] === COMMENT)) i += 1;
  const atEnd = i >= n || text[i] === '\n' || (text[i] === '\r' && text[i + 1] === '\n');
  if (atEnd) return i;
  if (!strict) return stop;
  if (text[i] === '}' && mask[i] === 0) return stop;
  return stop > end ? stop : -1;
}

function startsStatement(source: Source, start: number): boolean {
  const { text, mask } = source;
  let i = start - 1;
  while (i >= 0 && (mask[i] === COMMENT || /\s/.test(text[i]!))) i -= 1;
  if (i < 0) return true;
  if (mask[i] === LITERAL) return true;
  const c = text[i]!;
  if (c === ';' || c === '{' || c === '}') return true;
  if (c === ')') {
    let depth = 0;
    let j = i;
    for (; j >= 0; j -= 1) {
      if (mask[j] !== 0) continue;
      if (text[j] === ')') depth += 1;
      else if (text[j] === '(') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (j < 0) return false;
    let k = j - 1;
    while (k >= 0 && /\s/.test(text[k]!)) k -= 1;
    let w = k;
    while (w >= 0 && isWordChar(text[w]!)) w -= 1;
    return !CONTROL_KEYWORDS.has(text.slice(w + 1, k + 1));
  }
  if (isWordChar(c)) {
    let w = i;
    while (w >= 0 && isWordChar(text[w]!)) w -= 1;
    return !CONTINUATION_KEYWORDS.has(text.slice(w + 1, i + 1));
  }
  return false;
}

function calls(names: string, trailingBlock = false): Extractor {
  const head = new RegExp(
    `^([ \\t]*)(?:${names})(?:\\.(?:only|skip|concurrent|todo|fails|failing|serial|sequential))*[ \\t]*\\(`,
    'gm',
  );
  const literal = /\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/y;
  return (file, source) => {
    const { text, mask } = source;
    const found: RawTest[] = [];
    let cursor = 0;
    for (const match of text.matchAll(head)) {
      const start = match.index!;
      const indent = match[1]!.length;
      if (start < cursor || mask[start + indent] !== 0) continue;
      const open = start + match[0].length - 1;
      literal.lastIndex = open + 1;
      const named = literal.exec(text);
      if (!named) continue;
      if (!startsStatement(source, start + indent)) continue;
      const close = matchingClose(source, open);
      if (close === -1) continue;
      let end = close + 1;
      if (trailingBlock) {
        let probe = end;
        while (text[probe] === ' ' || text[probe] === '\t') probe += 1;
        if (text[probe] === '{' && mask[probe] === 0) {
          const blockEnd = matchingClose(source, probe);
          if (blockEnd !== -1) end = blockEnd + 1;
        }
      }
      end = statementEnd(source, end, true, true);
      if (end === -1) continue;
      found.push({ file, name: named[2]!, start, end, source: text.slice(start, end) });
      cursor = end;
    }
    return found;
  };
}

function annotationStart(source: Source, start: number): number {
  const { text, mask } = source;
  let from = start;
  while (from > 0) {
    const previous = lineStartOf(text, from - 1);
    const line = text.slice(previous, from - 1).replace(/\r$/, '');
    if (!/^\s*@[\w$.]+(?:\(.*\))?\s*$/.test(line)) break;
    if (mask[previous + line.indexOf('@')] !== 0) break;
    from = previous;
  }
  return from;
}

function braced(header: RegExp, options: { annotations?: boolean } = {}): Extractor {
  const pattern = new RegExp(header.source, `${header.flags.replace(/[gy]/g, '')}gm`);
  return (file, source) => {
    const { text, mask } = source;
    const found: RawTest[] = [];
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const lineStart = lineStartOf(text, match.index!);
      const indent = /^[ \t]*/.exec(match[0])![0].length;
      if (lineStart < cursor || mask[match.index! + indent] !== 0) continue;
      const open = findBody(source, match.index! + match[0].length);
      if (open === -1) continue;
      const close = matchingClose(source, open);
      if (close === -1) continue;
      const end = statementEnd(source, close + 1, false, false);
      const start = options.annotations ? annotationStart(source, lineStart) : lineStart;
      const name = (match.slice(1).find((group) => group !== undefined) ?? 'anonymous').trim();
      found.push({ file, name, start, end, source: text.slice(start, end) });
      cursor = end;
    }
    return found;
  };
}

function readAttribute(source: Source, at: number, style: AttributeStyle): number {
  const { text, mask } = source;
  if (mask[at] !== 0) return -1;
  if (style === 'hash') {
    if (text[at] !== '#' || text[at + 1] !== '[') return -1;
    const close = matchingClose(source, at + 1);
    return close === -1 ? -1 : close + 1;
  }
  if (style === 'bracket') {
    if (text[at] !== '[') return -1;
    const close = matchingClose(source, at);
    return close === -1 ? -1 : close + 1;
  }
  AT_NAME.lastIndex = at;
  const name = AT_NAME.exec(text);
  if (!name) return -1;
  let end = at + name[0].length;
  let probe = end;
  while (text[probe] === ' ' || text[probe] === '\t') probe += 1;
  if (text[probe] === '(' && mask[probe] === 0) {
    const close = matchingClose(source, probe);
    if (close === -1) return -1;
    end = close + 1;
  }
  return end;
}

function docStart(source: Source, start: number): number {
  const { text, mask } = source;
  let from = start;
  while (from > 0) {
    const previous = lineStartOf(text, from - 1);
    const line = text.slice(previous, from - 1).replace(/\r$/, '');
    const trimmed = line.trim();
    const offset = previous + line.length - line.trimStart().length;
    if (/^\/\/\/(?!\/)/.test(trimmed) && mask[offset] === COMMENT) {
      from = previous;
      continue;
    }
    if (trimmed.endsWith('*/') && mask[previous + line.lastIndexOf('*/')] === COMMENT) {
      let k = previous + line.lastIndexOf('*/');
      while (k > 0 && mask[k - 1] === COMMENT) k -= 1;
      if (text.startsWith('/**', k) && !text.startsWith('/**/', k)) {
        const blockStart = lineStartOf(text, k);
        if (text.slice(blockStart, k).trim() === '') {
          from = blockStart;
          continue;
        }
      }
    }
    break;
  }
  return from;
}

function macroRanges(source: Source): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of source.text.matchAll(MACRO_RULES)) {
    const begin = match.index!;
    if (source.mask[begin] !== 0) continue;
    const close = matchingClose(source, begin + match[0].length);
    if (close !== -1) ranges.push([begin, close + 1]);
  }
  return ranges;
}

function annotated(options: {
  style: AttributeStyle;
  test: RegExp;
  name: RegExp;
  keyword?: RegExp;
  docs?: boolean;
  macros?: boolean;
}): Extractor {
  const candidates =
    options.style === 'hash' ? /#\[/g : options.style === 'at' ? /@[A-Za-z_]/g : /^[ \t]*\[/gm;
  return (file, source) => {
    const { text } = source;
    const macros = options.macros ? macroRanges(source) : [];
    const found: RawTest[] = [];
    let cursor = 0;
    for (const match of text.matchAll(candidates)) {
      const position = match.index! + (options.style === 'bracket' ? match[0].length - 1 : 0);
      if (position < cursor) continue;
      const spans: Array<{ start: number; end: number }> = [];
      let probe = position;
      for (;;) {
        const attributeEnd = readAttribute(source, probe, options.style);
        if (attributeEnd === -1) break;
        spans.push({ start: probe, end: attributeEnd });
        probe = skipTrivia(source, attributeEnd);
      }
      const last = spans[spans.length - 1];
      if (!last) continue;
      cursor = last.end;
      if (!spans.some((span) => options.test.test(text.slice(span.start, span.end)))) continue;
      const open = findBody(source, probe);
      if (open === -1) continue;
      const header = text.slice(probe, open);
      if (options.keyword && !options.keyword.test(header)) continue;
      const close = matchingClose(source, open);
      if (close === -1) continue;
      let start = spans[0]!.start;
      const lineStart = lineStartOf(text, start);
      if (text.slice(lineStart, start).trim() === '') {
        start = options.docs ? docStart(source, lineStart) : lineStart;
      }
      if (macros.some(([from, to]) => start >= from && start < to)) continue;
      const end = statementEnd(source, close + 1, true, false);
      const name = options.name.exec(header)?.[1] ?? 'anonymous';
      found.push({ file, name, start, end, source: text.slice(start, end) });
      cursor = end;
    }
    return found;
  };
}

function indented(header: RegExp, options: { decorators?: boolean; endKeyword?: boolean }): Extractor {
  return (file, source) => {
    const { text, mask } = source;
    const starts = lineStarts(text);
    const depths = lineDepths(source, starts);
    const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
    const indentAt = (line: number): number => lines[line]!.length - lines[line]!.trimStart().length;
    const found: RawTest[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const match = header.exec(lines[i]!);
      if (!match) continue;
      const indent = indentAt(i);
      if (mask[starts[i]! + indent] !== 0 || depths[i] !== 0) continue;
      let first = i;
      if (options.decorators) {
        while (first > 0) {
          let b = first - 1;
          while (b > 0 && depths[b]! > 0) b -= 1;
          if (/^\s*@/.test(lines[b]!) && mask[starts[b]! + indentAt(b)] === 0) first = b;
          else break;
        }
      }
      let last = i;
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j]!;
        if (line.trim().length === 0) continue;
        const kind = mask[starts[j]! + indentAt(j)];
        const continuation = (starts[j]! > 0 && mask[starts[j]! - 1] === LITERAL) || depths[j]! > 0;
        if (continuation) {
          last = j;
          continue;
        }
        if (kind === COMMENT) continue;
        const lineIndent = indentAt(j);
        if (lineIndent < indent) break;
        if (lineIndent === indent) {
          if (options.endKeyword && /^end\b/.test(line.trim())) last = j;
          break;
        }
        last = j;
      }
      const start = starts[first]!;
      const end = starts[last]! + lines[last]!.length;
      found.push({ file, name: match[1] ?? 'anonymous', start, end, source: text.slice(start, end) });
      i = last;
    }
    return found;
  };
}

function combine(...extractors: Extractor[]): Extractor {
  return (file, source) => {
    const all = extractors.flatMap((extract) => extract(file, source));
    all.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: RawTest[] = [];
    let cursor = 0;
    for (const test of all) {
      if (test.start < cursor) continue;
      kept.push(test);
      cursor = test.end;
    }
    return kept;
  };
}

const TEST_MODULE =
  /((?:[ \t]*#\[[^\]\n]*\][ \t]*\r?\n)*)[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+[A-Za-z_]\w*[ \t]*\{/g;

function pruneEmptyTestModules(text: string): string {
  let current = text;
  for (let round = 0; round < 8; round += 1) {
    const source = createSource(current, RUST_SYNTAX);
    const ranges: Array<{ start: number; end: number }> = [];
    for (const match of current.matchAll(TEST_MODULE)) {
      if (!/#\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(match[1]!)) continue;
      const begin = match.index!;
      const first = begin + /^\s*/.exec(match[0])![0].length;
      if (source.mask[first] !== 0) continue;
      const lineStart = lineStartOf(current, begin);
      if (current.slice(lineStart, begin).trim() !== '') continue;
      const open = begin + match[0].length - 1;
      const close = matchingClose(source, open);
      if (close === -1) continue;
      let body = '';
      for (let i = open + 1; i < close; i += 1) if (source.mask[i] === 0) body += current[i];
      const pieces = body
        .split(';')
        .map((piece) => piece.trim())
        .filter((piece) => piece.length > 0);
      if (!pieces.every((piece) => /^(?:pub(?:\([^)]*\))?\s+)?use\s/.test(piece))) continue;
      ranges.push({ start: lineStart, end: close + 1 });
    }
    if (ranges.length === 0) break;
    current = removeRanges(current, ranges);
  }
  return current;
}

const BLOCK_HEADER = /^(?:async\s+)?(?:def|class|if|elif|else|for|while|try|except|finally|with|match|case)\b/;

function fillEmptyBlocks(text: string): string {
  const source = createSource(text, PYTHON_SYNTAX);
  const { mask } = source;
  const starts = lineStarts(text);
  const depths = lineDepths(source, starts);
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const inserts: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const indentLength = raw.length - raw.trimStart().length;
    if (indentLength === raw.length) continue;
    let k = starts[i]! + raw.length - 1;
    const floor = starts[i]! + indentLength;
    while (k > floor && (mask[k] === COMMENT || text[k] === ' ' || text[k] === '\t')) k -= 1;
    if (text[k] !== ':' || mask[k] !== 0) continue;
    if (i + 1 < lines.length && depths[i + 1] !== 0) continue;
    let s = i;
    while (s > 0 && depths[s]! > 0) s -= 1;
    if (!BLOCK_HEADER.test(lines[s]!.trimStart())) continue;
    const headerIndent = lines[s]!.length - lines[s]!.trimStart().length;
    let next = i + 1;
    while (
      next < lines.length &&
      (lines[next]!.trim().length === 0 ||
        mask[starts[next]! + (lines[next]!.length - lines[next]!.trimStart().length)] === COMMENT)
    ) {
      next += 1;
    }
    const nextIndent = next < lines.length ? lines[next]!.length - lines[next]!.trimStart().length : -1;
    if (next < lines.length && nextIndent > headerIndent) continue;
    const headerWhitespace = lines[s]!.slice(0, headerIndent);
    const unit = headerWhitespace.includes('\t') ? '\t' : '    ';
    inserts.push({ line: i, text: `${headerWhitespace}${unit}pass` });
  }
  if (inserts.length === 0) return text;
  const out = [...lines];
  for (const insert of inserts.sort((a, b) => b.line - a.line)) out.splice(insert.line + 1, 0, insert.text);
  return out.join(newline);
}

const DESCRIBE_HEAD =
  /^([ \t]*)(?:describe|suite)(?:\.(?:only|skip|concurrent|sequential|todo))*[ \t]*\(/gm;
const TEST_TOKEN =
  /(?<![\w$.])(?:Deno\s*\.\s*)?(?:it|test|specify|bench|describe|suite)\b(?:\s*\.\s*[A-Za-z]+)*\s*[(`]/g;

function hasTestTokens(source: Source, from: number, to: number, ignore: readonly Range[]): boolean {
  const pattern = new RegExp(TEST_TOKEN.source, 'g');
  pattern.lastIndex = from;
  for (
    let match = pattern.exec(source.text);
    match !== null && match.index < to;
    match = pattern.exec(source.text)
  ) {
    const at = match.index;
    if (source.mask[at] !== 0) continue;
    if (ignore.some((range) => at >= range.start && at < range.end)) continue;
    return true;
  }
  return false;
}

function emptiedDescribes(source: Source, doomed: readonly Range[]): Range[] {
  const blocks: Array<Range & { open: number; close: number }> = [];
  for (const match of source.text.matchAll(DESCRIBE_HEAD)) {
    const start = match.index!;
    const indent = match[1]!.length;
    if (source.mask[start + indent] !== 0 || !startsStatement(source, start + indent)) continue;
    const open = start + match[0].length - 1;
    const close = matchingClose(source, open);
    if (close === -1) continue;
    const end = statementEnd(source, close + 1, true, true);
    if (end === -1) continue;
    blocks.push({ start, end, open, close });
  }
  blocks.sort((a, b) => a.end - a.start - (b.end - b.start));
  const removed: Range[] = doomed.map((range) => ({ start: range.start, end: range.end }));
  const pruned: Range[] = [];
  for (const block of blocks) {
    const inside = removed.filter((range) => range.start >= block.open && range.end <= block.close + 1);
    if (inside.length === 0 || hasTestTokens(source, block.open + 1, block.close, inside)) continue;
    pruned.push({ start: block.start, end: block.end });
    removed.push({ start: block.start, end: block.end });
  }
  return pruned;
}

const GO_IMPORT_SPEC = /^[ \t]*(?:([A-Za-z_]\w*|\.)[ \t]+)?"([^"\n]+)"[ \t]*(?:\/\/.*)?$/;
const GO_IMPORT_SINGLE = /^import[ \t]+(?:([A-Za-z_]\w*|\.)[ \t]+)?"([^"\n]+)"[ \t]*(?:\/\/.*)?$/;

function goImportName(alias: string | undefined, path: string): string | undefined {
  if (alias !== undefined) return alias === '_' || alias === '.' ? undefined : alias;
  const parts = path.split('/');
  let name = parts[parts.length - 1]!;
  if (/^v\d+$/.test(name) && parts.length > 1) name = parts[parts.length - 2]!;
  return /^[A-Za-z_]\w*$/.test(name) ? name : undefined;
}

function selectorCount(source: Source, name: string): number {
  const pattern = new RegExp(`(?<![\\w.])${name}\\s*\\.`, 'g');
  let count = 0;
  for (const match of source.text.matchAll(pattern)) {
    if (source.mask[match.index!] === 0) count += 1;
  }
  return count;
}

function pruneUnusedGoImports(text: string, original: string): string {
  const after = createSource(text, GO_SYNTAX);
  const before = createSource(original, GO_SYNTAX);
  const starts = lineStarts(text);
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const unused = (alias: string | undefined, path: string): boolean => {
    const name = goImportName(alias, path);
    if (name === undefined) return false;
    return selectorCount(before, name) > 0 && selectorCount(after, name) === 0;
  };
  const lineRange = (index: number): Range => ({
    start: starts[index]!,
    end: starts[index]! + lines[index]!.length,
  });
  const ranges: Range[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (after.mask[starts[i]!] !== 0) continue;
    if (/^import[ \t]*\([ \t]*$/.test(line)) {
      const specs: Array<{ line: number; remove: boolean }> = [];
      let j = i + 1;
      for (; j < lines.length && lines[j]!.trim() !== ')'; j += 1) {
        const trimmed = lines[j]!.trim();
        const match = GO_IMPORT_SPEC.exec(lines[j]!);
        if (match) specs.push({ line: j, remove: unused(match[1], match[2]!) });
        else if (trimmed !== '' && !trimmed.startsWith('//')) specs.push({ line: j, remove: false });
      }
      if (j >= lines.length) break;
      if (specs.some((spec) => spec.remove)) {
        if (specs.every((spec) => spec.remove)) {
          ranges.push({ start: starts[i]!, end: lineRange(j).end });
        } else {
          for (const spec of specs) if (spec.remove) ranges.push(lineRange(spec.line));
        }
      }
      i = j;
      continue;
    }
    const single = GO_IMPORT_SINGLE.exec(line);
    if (single && unused(single[1], single[2]!)) ranges.push(lineRange(i));
  }
  return ranges.length > 0 ? removeRanges(text, ranges) : text;
}

const LANGUAGES: Language[] = [
  {
    files: /(^|\/)[^/]+[._](test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?$/,
    syntax: JS_SYNTAX,
    strict: true,
    extract: calls('it|test|specify|Deno\\.test'),
    prune: emptiedDescribes,
    emptyFileFails: true,
  },
  {
    files: /(^|\/)(test_[^/]+|[^/]+_test)\.py$/,
    syntax: PYTHON_SYNTAX,
    strict: true,
    extract: indented(/^\s*(?:async\s+)?def\s+(test\w*)\s*\(/, { decorators: true }),
    finish: fillEmptyBlocks,
  },
  {
    files: /_test\.go$/,
    syntax: GO_SYNTAX,
    strict: true,
    extract: braced(/^func\s+(Test(?![a-z])\w*)\s*\(\s*(?:\w+\s+)?\*testing\.T\s*\)/),
    finish: pruneUnusedGoImports,
  },
  {
    files: /\.rs$/,
    syntax: RUST_SYNTAX,
    strict: true,
    extract: annotated({
      style: 'hash',
      test: RUST_TEST,
      name: /\bfn\s+(?:r#)?([A-Za-z_]\w*)/,
      keyword: /\bfn\b/,
      docs: true,
      macros: true,
    }),
    finish: pruneEmptyTestModules,
  },
  {
    files: /(^|\/)src\/[^/]*[tT]est[^/]*\/.+\.(java|kt|kts|scala|groovy)$|(^|\/)[^/]*(Test|Tests|IT|Spec|TestCase)\.(java|kt|kts|scala|groovy)$|(^|\/)Test[^/]*\.(java|kt|scala|groovy)$/,
    syntax: JVM_SYNTAX,
    strict: true,
    extract: combine(
      annotated({ style: 'at', test: JVM_TEST, name: SIGNATURE_NAME }),
      braced(/^[ \t]*(?:(?:public|protected)\s+)?(?:void|fun)\s+(test\w*)\b/, { annotations: true }),
      braced(/^[ \t]*def\s+"((?:\\.|[^"\\\n])*)"/, { annotations: true }),
      calls('test|it|should|"[^"\\n]*"\\s+should', true),
    ),
  },
  {
    files: /(^|\/)[^/]*(Test|Tests)\.cs$|(^|\/)[^/]*Tests?\/[^/]+\.cs$/,
    syntax: CSHARP_SYNTAX,
    strict: true,
    extract: annotated({ style: 'bracket', test: CSHARP_TEST, name: SIGNATURE_NAME }),
  },
  {
    files: /(_spec|_test)\.rb$|(^|\/)test_[^/]+\.rb$/,
    syntax: RUBY_SYNTAX,
    strict: false,
    extract: combine(
      indented(/^\s*def\s+(test\w*)/, { endKeyword: true }),
      indented(/^\s*(?:it|specify|test|scenario)\s*\(?\s*['"]((?:\\.|[^'"\\])*)['"].*\bdo\b/, {
        endKeyword: true,
      }),
    ),
  },
  {
    files: /(^|\/)[^/]*Test\.php$|(^|\/)tests?\/.+\.php$/,
    syntax: PHP_SYNTAX,
    strict: true,
    extract: combine(
      annotated({ style: 'hash', test: PHP_TEST, name: /\bfunction\s+([A-Za-z_]\w*)/, keyword: /\bfunction\b/ }),
      braced(/^[ \t]*(?:(?:public|protected|final)\s+)*function\s+(test\w*)\b/),
      calls('it|test'),
    ),
  },
  {
    files: /(^|\/)[^/]*Tests?\.swift$|(^|\/)Tests\/.+\.swift$/,
    syntax: SWIFT_SYNTAX,
    strict: true,
    extract: combine(
      annotated({ style: 'at', test: JVM_TEST, name: SIGNATURE_NAME }),
      braced(
        /^[ \t]*(?:(?:public|private|internal|open|override|static|final|async|@\w+)\s+)*func\s+(test\w*)\b/,
        { annotations: true },
      ),
    ),
  },
  {
    files: /_test\.dart$/,
    syntax: DART_SYNTAX,
    strict: true,
    extract: calls('test|testWidgets|testGoldens|blocTest'),
  },
  {
    files: /(_test|_tests|_unittest|Test|Tests|\.test)\.(c|cc|cpp|cxx|mm|m)$|(^|\/)test_[^/]+\.(c|cc|cpp|cxx)$|(^|\/)tests?\/.+\.(cc|cpp|cxx)$/,
    syntax: C_SYNTAX,
    strict: true,
    extract: combine(
      braced(
        /^[ \t]*(?:TEST|TEST_F|TEST_P|TYPED_TEST|TYPED_TEST_P|TEST_CASE|TEST_CASE_METHOD|SCENARIO|BOOST_AUTO_TEST_CASE|BOOST_FIXTURE_TEST_CASE)\s*\(\s*([^)\n]*)\)/,
      ),
      braced(/^-\s*\(void\)\s*(test\w*)/),
    ),
  },
  {
    files: /_test\.exs$/,
    syntax: ELIXIR_SYNTAX,
    strict: false,
    extract: indented(/^\s*test\s+"((?:\\.|[^"\\])*)"/, { endKeyword: true }),
  },
  {
    files: /_spec\.lua$|(^|\/)test_[^/]+\.lua$/,
    syntax: LUA_SYNTAX,
    strict: true,
    extract: calls('it|test|specify'),
  },
  {
    files: /(^|\/)tests\/testthat\/test[-_][^/]+\.[rR]$/,
    syntax: R_SYNTAX,
    strict: false,
    extract: calls('test_that'),
  },
  {
    files: /\.bats$/,
    syntax: SHELL_SYNTAX,
    strict: false,
    extract: braced(/^[ \t]*@test\s+(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*/),
  },
  {
    files: /\.zig$/,
    syntax: ZIG_SYNTAX,
    strict: true,
    extract: braced(/^[ \t]*test\s+(?:"((?:\\.|[^"\\])*)"|(\w+))\s*/),
  },
];

function languageOf(path: string): Language | undefined {
  const normalized = path.replace(/\\/g, '/');
  return LANGUAGES.find((language) => language.files.test(normalized));
}

export function isTestFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return !IGNORED_DIRECTORY.test(normalized) && languageOf(normalized) !== undefined;
}

function wellFormed(source: Source, test: RawTest): boolean {
  if (test.end <= test.start) return false;
  return isBalanced(
    source.text.slice(test.start, test.end),
    source.mask.subarray(test.start, test.end),
  );
}

export function extractTestFunctions(file: string, text: string): RawTest[] {
  const language = languageOf(file);
  if (!language) return [];
  const source = createSource(text, language.syntax);
  if (language.strict && !isBalanced(text, source.mask)) return [];
  return language.extract(file, source).filter((test) => wellFormed(source, test));
}

export function testQuestions(tests: readonly TestFunction[]): JevQuestions {
  return Object.fromEntries(
    tests.map((test) => [
      `keep_${test.id}`,
      {
        type: 'noul' as const,
        instructions: `Unit test ${test.id} ("${test.name}" in ${test.file}) is worth keeping: it checks real behaviour that no other test covers`,
      },
    ]),
  );
}

function safeSlice(text: string, length: number): string {
  let end = Math.min(length, text.length);
  const code = text.charCodeAt(end - 1);
  if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function testEntry(test: TestFunction, sourceChars: number): object {
  return {
    id: test.id,
    file: test.file,
    name: test.name,
    source: test.source.length > sourceChars ? `${safeSlice(test.source, sourceChars)}…` : test.source,
  };
}

export function batchTests(
  tests: readonly TestFunction[],
  maxRequestTokens: number,
  sourceChars: number,
  reserveTokens = 0,
): TestFunction[][] {
  const base = estimateTokens(JSON.stringify({ context: TEST_STATE_CONTEXT, tests: [] })) + reserveTokens;
  const budget = Math.max(1, maxRequestTokens - base);
  const batches: TestFunction[][] = [];
  let current: TestFunction[] = [];
  let currentTokens = 0;
  for (const test of tests) {
    const tokens =
      estimateTokens(JSON.stringify(testEntry(test, sourceChars))) +
      estimateTokens(JSON.stringify(testQuestions([test])));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(test);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

interface Range {
  start: number;
  end: number;
}

function mergeRanges(ranges: readonly Range[]): Range[] {
  const ascending = ranges
    .filter((range) => range.end > range.start)
    .map((range) => ({ start: range.start, end: range.end }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Range[] = [];
  for (const range of ascending) {
    const last = merged[merged.length - 1];
    if (last && range.start < last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged.reverse();
}

function blankLineEnd(text: string, at: number): number {
  if (at >= text.length) return -1;
  BLANK_LINE.lastIndex = at;
  const match = BLANK_LINE.exec(text);
  return match ? at + match[0].length : -1;
}

function removeOne(text: string, start: number, end: number, newline: string): string {
  const lineStart = lineStartOf(text, start);
  const indent = /^[ \t]*/.exec(text.slice(start, end))![0];
  const leading = text.slice(lineStart, start).trim() === '';
  let to = end;
  while (text[to] === ' ' || text[to] === '\t') to += 1;
  const eof = to >= text.length;
  const eol = eof ? 0 : text[to] === '\n' ? 1 : text[to] === '\r' && text[to + 1] === '\n' ? 2 : -1;
  if (!leading) {
    return text.slice(0, start).replace(/[ \t]+$/, '') + text.slice(eol === -1 ? end : to);
  }
  if (eol === -1) {
    return text.slice(0, lineStart) + (start === lineStart ? indent : '') + text.slice(to);
  }
  let after = eof ? to : to + eol;
  let from = lineStart;
  const previousStart = lineStart === 0 ? 0 : lineStartOf(text, lineStart - 1);
  const previousLine = text.slice(previousStart, lineStart);
  const previousBlank =
    lineStart === 0 || previousLine.trim() === '' || /[{([]\s*$/.test(previousLine);
  if (previousBlank) {
    for (let next = blankLineEnd(text, after); next !== -1; next = blankLineEnd(text, next)) {
      after = next;
    }
    if (lineStart > 0 && /^[ \t]*[}\])]/.test(text.slice(after, after + 200))) {
      while (from > 0) {
        const blankStart = lineStartOf(text, from - 1);
        if (text.slice(blankStart, from).trim() !== '') break;
        from = blankStart;
      }
    }
  }
  if (after >= text.length) {
    const before = text.slice(0, from).replace(/\s+$/, '');
    return before.length === 0 ? '' : before + newline;
  }
  return text.slice(0, from) + text.slice(after);
}

export function removeRanges(
  text: string,
  ranges: ReadonlyArray<{ start: number; end: number }>,
): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let result = text;
  for (const { start, end } of mergeRanges(ranges)) result = removeOne(result, start, end, newline);
  return result;
}

interface FilePlan {
  path: string;
  language: Language;
  original: string;
  all: TestFunction[];
  removed: TestFunction[];
  text: string;
  empty: boolean;
}

interface Edit {
  text: string;
  empty: boolean;
}

function planEdit(
  path: string,
  language: Language,
  original: string,
  all: readonly TestFunction[],
  removed: readonly TestFunction[],
): Edit | undefined {
  const doomed = new Set(removed.map((test) => test.id));
  const extra = language.prune ? language.prune(createSource(original, language.syntax), removed) : [];
  let text = removeRanges(original, [...removed, ...extra]);
  if (language.finish) text = language.finish(text, original);
  const source = createSource(text, language.syntax);
  if (language.strict && !isBalanced(text, source.mask)) return undefined;
  const survivors = all.filter((test) => !doomed.has(test.id)).map((test) => test.source);
  const after = extractTestFunctions(path, text).map((test) => test.source);
  if (after.length !== survivors.length) return undefined;
  for (let i = 0; i < after.length; i += 1) if (after[i] !== survivors[i]) return undefined;
  const empty = language.emptyFileFails === true && !hasTestTokens(source, 0, text.length, []);
  return { text, empty };
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryable(error: unknown): boolean {
  if (error instanceof JevHttpError) return error.retryable;
  if (error instanceof Error && error.name === 'AbortError') return false;
  return true;
}

async function askWithRetry(
  asker: JevAsker,
  state: object,
  questions: JevQuestions,
  retries: number,
  signal: AbortSignal | undefined,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await asker.ask(state, questions, signal ? { signal } : undefined);
    } catch (error) {
      if (attempt >= retries || signal?.aborted || !retryable(error)) throw error;
      await delay(Math.min(8000, 500 * 2 ** attempt), signal);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function pruneTests(
  files: TestFileAccess,
  asker: JevAsker,
  options: PruneTestsOptions = {},
): Promise<PruneTestsResult> {
  const threshold = options.deleteThreshold ?? DEFAULT_TEST_DELETE_THRESHOLD;
  const maxRequestTokens = options.maxRequestTokens ?? DEFAULT_MAX_TEST_REQUEST_TOKENS;
  const sourceChars = options.sourceChars ?? 2000;
  const concurrency = options.concurrency ?? 4;
  const retries = options.retries ?? 2;
  const maxVerifyRuns = options.maxVerifyRuns ?? DEFAULT_MAX_VERIFY_RUNS;
  const goal = options.goal ?? '';
  const errors: string[] = [];
  const skipped: TestSkip[] = [];

  const paths = [...new Set((await files.list()).filter(isTestFile))];
  const originals = new Map<string, string>();
  const tests: TestFunction[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = await files.read(path);
    } catch (error) {
      errors.push(`${path}: ${describeError(error)}`);
      continue;
    }
    originals.set(path, text);
    for (const found of extractTestFunctions(path, text)) {
      tests.push({ id: `u${tests.length + 1}`, ...found });
    }
  }

  const scores: PruneTestsResult['scores'] = [];
  const batches = batchTests(tests, maxRequestTokens, sourceChars, estimateTokens(goal));
  const outcomes = await mapLimit(batches, concurrency, async (batch) => {
    const state = {
      context: TEST_STATE_CONTEXT,
      goal,
      tests: batch.map((test) => testEntry(test, sourceChars)),
    };
    try {
      const { answers } = await askWithRetry(asker, state, testQuestions(batch), retries, options.signal);
      return batch.map((test) => ({ test, keepTest: tryNoulAnswer(answers, `keep_${test.id}`) }));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      errors.push(`batch of ${batch.length} tests: ${describeError(error)}`);
      return batch.map((test) => ({ test, keepTest: undefined }));
    }
  });

  let candidates: Array<{ test: TestFunction; keepTest: number }> = [];
  for (const { test, keepTest } of outcomes.flat()) {
    if (keepTest === undefined) {
      skipped.push({ id: test.id, file: test.file, name: test.name, reason: 'unscored', keepTest: null });
      continue;
    }
    scores.push({ id: test.id, file: test.file, name: test.name, keepTest });
    if (keepTest < threshold) candidates.push({ test, keepTest });
  }

  if (options.keepAtLeastOnePerFile) {
    const total = new Map<string, number>();
    for (const test of tests) total.set(test.file, (total.get(test.file) ?? 0) + 1);
    const grouped = new Map<string, Array<{ test: TestFunction; keepTest: number }>>();
    for (const entry of candidates) {
      const group = grouped.get(entry.test.file) ?? [];
      group.push(entry);
      grouped.set(entry.test.file, group);
    }
    const spared = new Set<string>();
    for (const [file, group] of grouped) {
      if (group.length !== total.get(file)) continue;
      const best = group.reduce((a, b) => (b.keepTest > a.keepTest ? b : a));
      spared.add(best.test.id);
      skipped.push({
        id: best.test.id,
        file,
        name: best.test.name,
        reason: 'last_in_file',
        keepTest: best.keepTest,
      });
    }
    candidates = candidates.filter((entry) => !spared.has(entry.test.id));
  }

  if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');

  const scoreOf = new Map(candidates.map((entry) => [entry.test.id, entry.keepTest]));
  const skip = (test: TestFunction, reason: SkipReason): void => {
    skipped.push({
      id: test.id,
      file: test.file,
      name: test.name,
      reason,
      keepTest: scoreOf.get(test.id) ?? null,
    });
  };

  const removeEmpty = (options.removeEmptyFiles ?? true) && files.remove !== undefined;
  const plans: FilePlan[] = [];
  const doomedByFile = new Map<string, TestFunction[]>();
  for (const { test } of candidates) {
    const group = doomedByFile.get(test.file) ?? [];
    group.push(test);
    doomedByFile.set(test.file, group);
  }
  for (const [path, removed] of doomedByFile) {
    const language = languageOf(path)!;
    const original = originals.get(path)!;
    let current: string;
    try {
      current = await files.read(path);
    } catch (error) {
      errors.push(`${path}: ${describeError(error)}`);
      for (const test of removed) skip(test, 'unreadable');
      continue;
    }
    if (current !== original) {
      for (const test of removed) skip(test, 'changed');
      continue;
    }
    const all = tests.filter((test) => test.file === path);
    let kept = removed;
    let edit = planEdit(path, language, original, all, kept);
    while (edit && edit.empty && !removeEmpty) {
      const best = kept.reduce((a, b) => ((scoreOf.get(b.id) ?? 0) > (scoreOf.get(a.id) ?? 0) ? b : a));
      skip(best, 'last_in_file');
      kept = kept.filter((test) => test.id !== best.id);
      if (kept.length === 0) break;
      edit = planEdit(path, language, original, all, kept);
    }
    if (kept.length === 0) continue;
    if (!edit) {
      for (const test of kept) skip(test, 'mismatch');
      continue;
    }
    plans.push({ path, language, original, all, removed: kept, text: edit.text, empty: edit.empty });
  }

  let verifyRuns = 0;
  const check = async (targets: string[]): Promise<boolean> => {
    if (!files.verify) return true;
    verifyRuns += 1;
    try {
      const outcome = await files.verify(targets);
      return typeof outcome === 'boolean' ? outcome : outcome.ok;
    } catch {
      return false;
    }
  };
  const restore = async (plan: FilePlan): Promise<void> => {
    try {
      await files.write(plan.path, plan.original);
    } catch (error) {
      errors.push(`${plan.path}: failed to restore (${describeError(error)})`);
    }
  };

  const put = async (plan: FilePlan, text: string, empty: boolean): Promise<void> => {
    if (empty && files.remove) await files.remove(plan.path);
    else await files.write(plan.path, text);
  };

  let written: FilePlan[] = [];
  for (const plan of plans) {
    try {
      await put(plan, plan.text, plan.empty);
      written.push(plan);
    } catch (error) {
      errors.push(`${plan.path}: ${describeError(error)}`);
      await restore(plan);
      for (const test of plan.removed) skip(test, 'write_failed');
    }
  }

  if (files.verify && written.length > 0 && !(await check(written.map((plan) => plan.path)))) {
    for (const plan of written) await restore(plan);
    const accepted: FilePlan[] = [];
    for (const plan of written) {
      if (verifyRuns >= maxVerifyRuns) {
        for (const test of plan.removed) skip(test, 'verify_failed');
        continue;
      }
      await put(plan, plan.text, plan.empty);
      if (await check([plan.path])) {
        accepted.push(plan);
        continue;
      }
      let kept: TestFunction[] = [];
      let keptText: string | undefined;
      if (plan.removed.length > 1) {
        for (const test of plan.removed) {
          if (verifyRuns >= maxVerifyRuns) break;
          const trial = [...kept, test];
          const trialEdit = planEdit(plan.path, plan.language, plan.original, plan.all, trial);
          if (trialEdit === undefined || trialEdit.empty) continue;
          await files.write(plan.path, trialEdit.text);
          if (await check([plan.path])) {
            kept = trial;
            keptText = trialEdit.text;
          }
        }
      }
      if (keptText !== undefined && kept.length > 0) {
        await files.write(plan.path, keptText);
        accepted.push({ ...plan, removed: kept, text: keptText, empty: false });
        const keptIds = new Set(kept.map((test) => test.id));
        for (const test of plan.removed) if (!keptIds.has(test.id)) skip(test, 'verify_failed');
      } else {
        await restore(plan);
        for (const test of plan.removed) skip(test, 'verify_failed');
      }
    }
    written = accepted;
    if (written.length > 1 && verifyRuns < maxVerifyRuns && !(await check(written.map((p) => p.path)))) {
      for (const plan of written) {
        await restore(plan);
        for (const test of plan.removed) skip(test, 'verify_failed');
      }
      written = [];
    }
  }

  const deleted: TestDeletion[] = [];
  for (const plan of written) {
    for (const test of plan.removed) {
      deleted.push({ id: test.id, file: test.file, name: test.name, keepTest: scoreOf.get(test.id) ?? 0 });
    }
  }

  return {
    files: paths.length,
    tests: tests.length,
    requests: batches.length,
    deleted,
    scores,
    skipped,
    errors,
    removedFiles: written.filter((plan) => plan.empty).map((plan) => plan.path),
    verifyRuns,
  };
}