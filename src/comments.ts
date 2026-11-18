import { noulAnswer } from './request.js';
import { estimateTokens } from './state.js';
import { CHAR_LITERAL, IGNORED_DIRECTORY, removeRanges, type TestFileAccess } from './tests.js';
import type { JevAsker, JevQuestions } from './types.js';

export const DEFAULT_COMMENT_DELETE_THRESHOLD = 0.3;

export const DEFAULT_MAX_COMMENT_REQUEST_TOKENS = 30_000;

export const COMMENT_STATE_CONTEXT = [
  "You are pruning comments from source code. Each question asks whether one comment block should be kept.",
  "`comments` lists full-line comment blocks with their line range, their text, and the code that follows them.",
  "Default to NOT keeping. A comment earns a keep only if it tells a reader something the code cannot say: the intent behind the code, a non-obvious business rule, a hidden constraint or trade-off, a workaround for an external quirk, or the contract of a public API.",
  "Treat a comment as NOT worth keeping if ANY of these hold:",
  "(1) it restates what the code below it does, line by line or in words that add nothing;",
  "(2) it names a function, parameter, or variable and says nothing beyond the name;",
  "(3) it is a section banner, separator, or decorative line;",
  "(4) it records change history, authorship, or an issue number that version control already holds;",
  "(5) it is commented-out code;",
  "(6) it explains standard language syntax or a basic, well-known API;",
  "(7) it is a TODO or FIXME with no concrete remaining action.",
  "Keep a JSDoc, docstring, or similar block on an exported API when it states the contract, preconditions, or side effects.",
  "You only see this batch. Judge each comment on its own text and the code shown with it.",
].join(" ");

export interface CommentSpan {
  start: number;
  end: number;
  block: boolean;
}

export interface CommentGroup {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  text: string;
}

export interface CommentBlock extends CommentGroup {
  id: string;
  file: string;
  code: string;
}

export interface CommentDeletion {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  keepComment: number;
}

export interface PruneCommentsResult {
  files: number;
  comments: number;
  requests: number;
  deleted: CommentDeletion[];
  scores: Array<CommentDeletion & { keepComment: number }>;
}

export interface PruneCommentsOptions {
  goal?: string;
  deleteThreshold?: number;
  maxRequestTokens?: number;
  sourceChars?: number;
  /** Per file, the changed line numbers, or `true` when the whole file is new. */
  addedLines?: ReadonlyMap<string, ReadonlySet<number> | true>;
}

type QuoteMode = 'js' | 'char' | 'none';

interface Syntax {
  line: readonly string[];
  block: ReadonlyArray<readonly [string, string]>;
  quotes: QuoteMode;
  triple?: boolean;
}

const C_BLOCK: ReadonlyArray<readonly [string, string]> = [['/*', '*/']];
const SLASH_LINE: Syntax = { line: ['//'], block: C_BLOCK, quotes: 'js' };
const CHAR_QUOTED: Syntax = { line: ['//'], block: C_BLOCK, quotes: 'char' };
const HASH_LINE: Syntax = { line: ['#'], block: [], quotes: 'js' };
const DASH_LINE: Syntax = { line: ['--'], block: [], quotes: 'js' };

const SYNTAX_BY_EXTENSION = new Map<string, Syntax>([
  ['js', SLASH_LINE],
  ['jsx', SLASH_LINE],
  ['mjs', SLASH_LINE],
  ['cjs', SLASH_LINE],
  ['ts', SLASH_LINE],
  ['tsx', SLASH_LINE],
  ['mts', SLASH_LINE],
  ['cts', SLASH_LINE],
  ['proto', SLASH_LINE],
  ['c', CHAR_QUOTED],
  ['h', CHAR_QUOTED],
  ['cc', CHAR_QUOTED],
  ['cpp', CHAR_QUOTED],
  ['cxx', CHAR_QUOTED],
  ['hh', CHAR_QUOTED],
  ['hpp', CHAR_QUOTED],
  ['hxx', CHAR_QUOTED],
  ['mm', CHAR_QUOTED],
  ['java', CHAR_QUOTED],
  ['kt', CHAR_QUOTED],
  ['kts', CHAR_QUOTED],
  ['scala', CHAR_QUOTED],
  ['groovy', CHAR_QUOTED],
  ['go', CHAR_QUOTED],
  ['rs', CHAR_QUOTED],
  ['swift', CHAR_QUOTED],
  ['cs', CHAR_QUOTED],
  ['dart', CHAR_QUOTED],
  ['zig', { line: ['//'], block: [], quotes: 'char' }],
  ['php', { line: ['//'], block: C_BLOCK, quotes: 'js' }],
  ['py', { line: ['#'], block: [], quotes: 'js', triple: true }],
  ['pyi', { line: ['#'], block: [], quotes: 'js', triple: true }],
  ['rb', HASH_LINE],
  ['sh', HASH_LINE],
  ['bash', HASH_LINE],
  ['zsh', HASH_LINE],
  ['pl', HASH_LINE],
  ['pm', HASH_LINE],
  ['r', HASH_LINE],
  ['ex', HASH_LINE],
  ['exs', HASH_LINE],
  ['yaml', HASH_LINE],
  ['yml', HASH_LINE],
  ['toml', HASH_LINE],
  ['tf', { line: ['#', '//'], block: C_BLOCK, quotes: 'js' }],
  ['lua', { line: ['--'], block: [['--[[', ']]']], quotes: 'js' }],
  ['sql', { line: ['--'], block: C_BLOCK, quotes: 'js' }],
  ['hs', { line: ['--'], block: [['{-', '-}']], quotes: 'js' }],
  ['elm', DASH_LINE],
  ['clj', { line: [';'], block: [], quotes: 'js' }],
  ['cljs', { line: [';'], block: [], quotes: 'js' }],
  ['el', { line: [';'], block: [], quotes: 'js' }],
  ['scm', { line: [';'], block: [], quotes: 'js' }],
  ['ini', { line: ['#', ';'], block: [], quotes: 'none' }],
  ['cfg', { line: ['#', ';'], block: [], quotes: 'none' }],
  ['html', { line: [], block: [['<!--', '-->']], quotes: 'none' }],
  ['htm', { line: [], block: [['<!--', '-->']], quotes: 'none' }],
  ['xml', { line: [], block: [['<!--', '-->']], quotes: 'none' }],
  ['svg', { line: [], block: [['<!--', '-->']], quotes: 'none' }],
  ['css', { line: [], block: C_BLOCK, quotes: 'js' }],
  ['scss', { line: ['//'], block: C_BLOCK, quotes: 'js' }],
  ['less', { line: ['//'], block: C_BLOCK, quotes: 'js' }],
]);

/**
 * Comments that carry tooling or legal meaning. Removing them changes behaviour
 * (lint suppressions, shebangs, codegen directives) or breaks licensing.
 */
const PRAGMA =
  /copyright|license|spdx|eslint|tslint|pylint|rubocop|shellcheck|prettier|@ts-|@preserve|@flow|@jsx|@refresh|noqa|mypy|pyright|type:\s*ignore|nolint|nosonar|istanbul|c8 ignore|pragma|go:(generate|build|embed|linkname)|#!|-\*-|coding[:=]/i;

const SOURCE_CHARS = 2000;

export function syntaxFor(path: string): Syntax | undefined {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  return extension === undefined ? undefined : SYNTAX_BY_EXTENSION.get(extension);
}

export function isCommentFile(path: string): boolean {
  return !IGNORED_DIRECTORY.test(path) && syntaxFor(path) !== undefined;
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineNumberOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function stringEnd(text: string, i: number, syntax: Syntax): number | undefined {
  const quote = text[i];
  if (syntax.quotes === 'none' || (quote !== '"' && quote !== "'" && quote !== '`')) return undefined;
  if (quote === "'" && syntax.quotes === 'char') {
    const literal = CHAR_LITERAL.exec(text.slice(i, i + 12));
    return literal ? i + literal[0].length : undefined;
  }
  const triple = quote.repeat(3);
  if (syntax.triple && text.startsWith(triple, i)) {
    const close = text.indexOf(triple, i + 3);
    return close === -1 ? text.length : close + 3;
  }
  for (let j = i + 1; j < text.length; j += 1) {
    const char = text[j];
    if (char === '\\') j += 1;
    else if (char === quote) return j + 1;
    else if (char === '\n' && quote !== '`') return undefined;
  }
  return undefined;
}

/** Every comment in the text, skipping string literals so markers inside strings are ignored. */
export function scanComments(text: string, syntax: Syntax): CommentSpan[] {
  const spans: CommentSpan[] = [];
  let i = 0;
  while (i < text.length) {
    const block = syntax.block.find(([open]) => text.startsWith(open, i));
    if (block) {
      const close = text.indexOf(block[1], i + block[0].length);
      const end = close === -1 ? text.length : close + block[1].length;
      spans.push({ start: i, end, block: true });
      i = end;
      continue;
    }
    const marker = syntax.line.find(
      (candidate) => text.startsWith(candidate, i) && !(candidate === '#' && text[i + 1] === '['),
    );
    if (marker) {
      const newline = text.indexOf('\n', i);
      const end = newline === -1 ? text.length : newline;
      spans.push({ start: i, end, block: false });
      i = end;
      continue;
    }
    i = stringEnd(text, i, syntax) ?? i + 1;
  }
  return spans;
}

function isFullLine(text: string, span: CommentSpan): boolean {
  const lineStart = text.lastIndexOf('\n', span.start - 1) + 1;
  const newline = text.indexOf('\n', span.end);
  const lineEnd = newline === -1 ? text.length : newline;
  return text.slice(lineStart, span.start).trim() === '' && text.slice(span.end, lineEnd).trim() === '';
}

/**
 * Full-line comments only: a comment that trails code is left alone, since
 * removing it would also rewrite the code on that line. Adjacent line comments
 * form one block, so a multi-line paragraph is judged and deleted as a unit.
 */
export function commentGroups(text: string, syntax: Syntax): CommentGroup[] {
  const starts = lineStartOffsets(text);
  const groups: Array<CommentGroup & { block: boolean }> = [];
  for (const span of scanComments(text, syntax)) {
    if (!isFullLine(text, span)) continue;
    const startLine = lineNumberOf(starts, span.start);
    const endLine = lineNumberOf(starts, span.end > 0 ? span.end - 1 : 0);
    const previous = groups[groups.length - 1];
    if (previous && !span.block && !previous.block && startLine === previous.endLine + 1) {
      previous.end = span.end;
      previous.endLine = endLine;
      previous.text = text.slice(previous.start, span.end);
      continue;
    }
    groups.push({
      start: text.lastIndexOf('\n', span.start - 1) + 1,
      end: span.end,
      startLine,
      endLine,
      text: text.slice(span.start, span.end),
      block: span.block,
    });
  }
  return groups
    .filter((group) => !PRAGMA.test(group.text))
    .map(({ start, end, startLine, endLine, text }) => ({ start, end, startLine, endLine, text }));
}

function touches(group: CommentGroup, lines: ReadonlySet<number> | undefined): boolean {
  if (!lines) return true;
  for (let line = group.startLine; line <= group.endLine; line += 1) {
    if (lines.has(line)) return true;
  }
  return false;
}

/** The comment blocks of one file; `lines` restricts them to blocks that overlap those line numbers. */
export function extractCommentBlocks(
  file: string,
  text: string,
  lines?: ReadonlySet<number>,
): Array<Omit<CommentBlock, 'id'>> {
  const syntax = syntaxFor(file);
  if (!syntax) return [];
  const textLines = text.split('\n');
  return commentGroups(text, syntax)
    .filter((group) => touches(group, lines))
    .map((group) => ({
      ...group,
      file,
      code: textLines.slice(group.endLine, group.endLine + 3).join('\n'),
    }));
}

/**
 * Parses `git diff --unified=0` output into the added line numbers of each
 * new-side file. Deleted files contribute nothing.
 */
export function parseAddedLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let file: string | undefined;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4);
      file = path === '/dev/null' ? undefined : path.replace(/^b\//, '');
      if (file !== undefined && !result.has(file)) result.set(file, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+') && file !== undefined) {
      result.get(file)!.add(line);
      line += 1;
    }
  }
  return result;
}

function commentQuestions(blocks: readonly CommentBlock[]): JevQuestions {
  return Object.fromEntries(
    blocks.map((block) => [
      `keep_${block.id}`,
      {
        type: 'noul' as const,
        instructions: `Comment ${block.id} in ${block.file} (lines ${block.startLine}-${block.endLine}) is worth keeping: it explains intent or a constraint that the code cannot express`,
      },
    ]),
  );
}

function commentEntry(block: CommentBlock, sourceChars: number): object {
  const comment = block.text.length > sourceChars ? `${block.text.slice(0, sourceChars)}…` : block.text;
  return {
    id: block.id,
    file: block.file,
    lines: `${block.startLine}-${block.endLine}`,
    comment,
    code: block.code,
  };
}

export function batchComments(
  blocks: readonly CommentBlock[],
  maxRequestTokens: number,
  sourceChars: number,
): CommentBlock[][] {
  const base = estimateTokens(JSON.stringify({ context: COMMENT_STATE_CONTEXT, comments: [] }));
  const budget = maxRequestTokens - base;
  const batches: CommentBlock[][] = [];
  let current: CommentBlock[] = [];
  let currentTokens = 0;
  for (const block of blocks) {
    const tokens =
      estimateTokens(JSON.stringify(commentEntry(block, sourceChars))) +
      estimateTokens(JSON.stringify(commentQuestions([block])));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(block);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Deletes comment blocks Jev scores below `deleteThreshold`. Files are read
 * once for scanning and again for the edit, so the ranges match the text that
 * is rewritten. Files with a NUL byte are treated as binary and skipped.
 */
export async function pruneComments(
  files: TestFileAccess,
  asker: JevAsker,
  options: PruneCommentsOptions = {},
): Promise<PruneCommentsResult> {
  const threshold = options.deleteThreshold ?? DEFAULT_COMMENT_DELETE_THRESHOLD;
  const maxRequestTokens = options.maxRequestTokens ?? DEFAULT_MAX_COMMENT_REQUEST_TOKENS;
  const sourceChars = options.sourceChars ?? SOURCE_CHARS;
  const added = options.addedLines;
  const paths = (await files.list()).filter(
    (path) => isCommentFile(path) && (added === undefined || added.has(path)),
  );
  const blocks: CommentBlock[] = [];
  let scanned = 0;
  for (const path of paths) {
    const text = await files.read(path);
    if (text.includes('\0')) continue;
    scanned += 1;
    const lines = added?.get(path);
    for (const found of extractCommentBlocks(path, text, lines === true ? undefined : lines)) {
      blocks.push({ id: `c${blocks.length + 1}`, ...found });
    }
  }
  const batches = batchComments(blocks, maxRequestTokens, sourceChars);
  const answered = await Promise.all(
    batches.map(async (batch) => {
      const state = {
        context: COMMENT_STATE_CONTEXT,
        goal: options.goal ?? '',
        comments: batch.map((block) => commentEntry(block, sourceChars)),
      };
      const { answers } = await asker.ask(state, commentQuestions(batch));
      return batch.map((block) => ({
        block,
        keepComment: noulAnswer(answers, `keep_${block.id}`),
      }));
    }),
  );
  const scores: PruneCommentsResult['scores'] = [];
  const deleted: CommentDeletion[] = [];
  for (const { block, keepComment } of answered.flat()) {
    const entry = {
      id: block.id,
      file: block.file,
      startLine: block.startLine,
      endLine: block.endLine,
      keepComment,
    };
    scores.push(entry);
    if (keepComment < threshold) deleted.push(entry);
  }
  const doomed = new Set(deleted.map((entry) => entry.id));
  for (const path of new Set(deleted.map((entry) => entry.file))) {
    const ranges = blocks.filter((block) => block.file === path && doomed.has(block.id));
    const text = await files.read(path);
    await files.write(path, removeRanges(text, ranges));
  }
  return { files: scanned, comments: blocks.length, requests: batches.length, deleted, scores };
}
