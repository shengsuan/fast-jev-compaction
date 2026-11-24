export interface Syntax {
  lineComments: readonly string[];
  hashAttribute: boolean;
  hashWordStart: boolean;
  blockComment: boolean;
  nestedBlock: boolean;
  luaLong: boolean;
  singleQuote: 'string' | 'char' | 'none';
  backtick: 'template' | 'raw' | 'none';
  tripleDouble: boolean;
  tripleSingle: boolean;
  multiline: boolean;
  rustRaw: boolean;
  hashRaw: boolean;
  cppRaw: boolean;
  verbatim: boolean;
  regex: boolean;
}

export interface Source {
  text: string;
  mask: Uint8Array;
  syntax: Syntax;
}

export const CODE = 0;
export const COMMENT = 1;
export const LITERAL = 2;

export const CHAR_LITERAL =
  /^'(?:\\(?:u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|[0-7]{1,3}|[^\n])|[^\\'\n])'/u;

const CHAR_STICKY =
  /'(?:\\(?:u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|[0-7]{1,3}|[^\n])|[^\\'\n])'/uy;
const RUST_RAW = /(?:br|cr|r)(#*)"/y;
const CPP_RAW = /(?:u8|[uUL])?R"([^()\\\s"]{0,16})\(/y;
const HASH_RAW = /(#+)("""|")/y;
const LUA_LONG = /\[(=*)\[/y;
const VERBATIM = /(?:\$@|@\$|@)"/y;
const WORD_RUN = /[\p{L}\p{N}_$]+/uy;
const WORD_CHAR = /[\p{L}\p{N}_$]/u;
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const BASE: Syntax = {
  lineComments: ['//'],
  hashAttribute: false,
  hashWordStart: false,
  blockComment: true,
  nestedBlock: false,
  luaLong: false,
  singleQuote: 'string',
  backtick: 'none',
  tripleDouble: false,
  tripleSingle: false,
  multiline: false,
  rustRaw: false,
  hashRaw: false,
  cppRaw: false,
  verbatim: false,
  regex: false,
};

function define(overrides: Partial<Syntax>): Syntax {
  return { ...BASE, ...overrides };
}

export const JS_SYNTAX = define({ backtick: 'template', regex: true });
export const RUST_SYNTAX = define({
  nestedBlock: true,
  singleQuote: 'char',
  rustRaw: true,
  multiline: true,
});
export const GO_SYNTAX = define({ singleQuote: 'char', backtick: 'raw' });
export const JVM_SYNTAX = define({ singleQuote: 'char', backtick: 'raw', tripleDouble: true });
export const CSHARP_SYNTAX = define({ singleQuote: 'char', verbatim: true, tripleDouble: true });
export const SWIFT_SYNTAX = define({
  nestedBlock: true,
  singleQuote: 'none',
  backtick: 'raw',
  tripleDouble: true,
  hashRaw: true,
});
export const PHP_SYNTAX = define({
  lineComments: ['//', '#'],
  hashAttribute: true,
  multiline: true,
});
export const DART_SYNTAX = define({
  nestedBlock: true,
  tripleDouble: true,
  tripleSingle: true,
  multiline: true,
});
export const C_SYNTAX = define({ singleQuote: 'char', cppRaw: true });
export const ZIG_SYNTAX = define({ blockComment: false, singleQuote: 'char' });
export const PYTHON_SYNTAX = define({
  lineComments: ['#'],
  blockComment: false,
  tripleDouble: true,
  tripleSingle: true,
});
export const RUBY_SYNTAX = define({
  lineComments: ['#'],
  blockComment: false,
  backtick: 'raw',
  multiline: true,
});
export const ELIXIR_SYNTAX = define({
  lineComments: ['#'],
  blockComment: false,
  tripleDouble: true,
  multiline: true,
});
export const LUA_SYNTAX = define({
  lineComments: ['--'],
  blockComment: false,
  luaLong: true,
  multiline: true,
});
export const R_SYNTAX = define({
  lineComments: ['#'],
  blockComment: false,
  backtick: 'raw',
  multiline: true,
});
export const SHELL_SYNTAX = define({
  lineComments: ['#'],
  hashWordStart: true,
  blockComment: false,
  multiline: true,
});

export function scan(text: string, syntax: Syntax): Uint8Array {
  const n = text.length;
  const mask = new Uint8Array(n);
  let i = 0;
  let prev = '';
  let prevWord = '';

  const mark = (from: number, to: number, kind: number): void => {
    mask.fill(kind, from, Math.min(to, n));
  };

  const at = (pattern: RegExp, index: number): RegExpExecArray | null => {
    pattern.lastIndex = index;
    return pattern.exec(text);
  };

  const lineCommentAt = (index: number): boolean => {
    for (const marker of syntax.lineComments) {
      if (!text.startsWith(marker, index)) continue;
      if (marker === '#' && syntax.hashAttribute && text[index + 1] === '[') continue;
      if (
        marker === '#' &&
        syntax.hashWordStart &&
        index > 0 &&
        !/[\s;&|(]/.test(text[index - 1]!)
      ) {
        continue;
      }
      return true;
    }
    return false;
  };

  const regexAllowed = (): boolean => {
    if (prev === '') return true;
    if (prev === 'w') return REGEX_KEYWORDS.has(prevWord);
    if (prev === 'l') return false;
    return prev !== ')' && prev !== ']' && prev !== '<';
  };

  const quoted = (quote: string, multiline: boolean): void => {
    const start = i;
    i += 1;
    while (i < n) {
      const c = text[i]!;
      if (c === '\\') {
        i += text[i + 1] === '\r' && text[i + 2] === '\n' ? 3 : 2;
        continue;
      }
      if (c === quote) {
        i += 1;
        break;
      }
      if (c === '\n' && !multiline) break;
      i += 1;
    }
    i = Math.min(i, n);
    mark(start, i, LITERAL);
  };

  const triple = (quote: string): void => {
    const start = i;
    i += 3;
    while (i < n) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text.startsWith(quote, i)) {
        i += 3;
        break;
      }
      i += 1;
    }
    i = Math.min(i, n);
    mark(start, i, LITERAL);
  };

  const until = (closing: string, skip: number, kind: number): void => {
    const start = i;
    const end = text.indexOf(closing, i + skip);
    i = end === -1 ? n : end + closing.length;
    mark(start, i, kind);
  };

  const verbatimString = (skip: number): void => {
    const start = i;
    i += skip;
    while (i < n) {
      if (text[i] === '"') {
        if (text[i + 1] === '"') {
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      i += 1;
    }
    mark(start, i, LITERAL);
  };

  const regexLiteral = (): boolean => {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = text[j]!;
      if (c === '\n') return false;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        j += 1;
        while (j < n && /[a-zA-Z]/.test(text[j]!)) j += 1;
        mark(i, j, LITERAL);
        i = j;
        return true;
      }
      j += 1;
    }
    return false;
  };

  function template(): void {
    let from = i;
    i += 1;
    while (i < n) {
      const c = text[i]!;
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        i += 1;
        break;
      }
      if (c === '$' && text[i + 1] === '{') {
        mark(from, i + 2, LITERAL);
        i += 2;
        code(true);
        from = i;
        i += 1;
        continue;
      }
      i += 1;
    }
    mark(from, Math.min(i, n), LITERAL);
  }

  function code(stopAtBrace: boolean): void {
    let depth = 0;
    while (i < n) {
      const c = text[i]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        i += 1;
        continue;
      }
      if (syntax.luaLong && c === '-' && text.startsWith('--[', i)) {
        const long = at(LUA_LONG, i + 2);
        if (long) {
          until(`]${long[1]!}]`, 2 + long[0].length, COMMENT);
          continue;
        }
      }
      if (lineCommentAt(i)) {
        const end = text.indexOf('\n', i);
        const stop = end === -1 ? n : end;
        mark(i, stop, COMMENT);
        i = stop;
        continue;
      }
      if (syntax.blockComment && c === '/' && text[i + 1] === '*') {
        const start = i;
        let depthBlock = 1;
        i += 2;
        while (i < n && depthBlock > 0) {
          if (syntax.nestedBlock && text.startsWith('/*', i)) {
            depthBlock += 1;
            i += 2;
          } else if (text.startsWith('*/', i)) {
            depthBlock -= 1;
            i += 2;
          } else {
            i += 1;
          }
        }
        mark(start, i, COMMENT);
        continue;
      }
      if (syntax.verbatim && (c === '@' || c === '$')) {
        const match = at(VERBATIM, i);
        if (match) {
          verbatimString(match[0].length);
          prev = 'l';
          continue;
        }
      }
      if (syntax.rustRaw && (c === 'r' || c === 'b' || c === 'c')) {
        const match = at(RUST_RAW, i);
        if (match) {
          until(`"${match[1]!}`, match[0].length, LITERAL);
          prev = 'l';
          continue;
        }
      }
      if (syntax.cppRaw && (c === 'R' || c === 'u' || c === 'U' || c === 'L')) {
        const match = at(CPP_RAW, i);
        if (match) {
          until(`)${match[1]!}"`, match[0].length, LITERAL);
          prev = 'l';
          continue;
        }
      }
      if (syntax.hashRaw && c === '#') {
        const match = at(HASH_RAW, i);
        if (match) {
          until(`${match[2]!}${match[1]!}`, match[0].length, LITERAL);
          prev = 'l';
          continue;
        }
      }
      if (syntax.luaLong && c === '[') {
        const match = at(LUA_LONG, i);
        if (match) {
          until(`]${match[1]!}]`, match[0].length, LITERAL);
          prev = 'l';
          continue;
        }
      }
      if (c === '"') {
        if (syntax.tripleDouble && text.startsWith('"""', i)) triple('"""');
        else quoted('"', syntax.multiline);
        prev = 'l';
        continue;
      }
      if (c === "'") {
        if (syntax.tripleSingle && text.startsWith("'''", i)) {
          triple("'''");
          prev = 'l';
        } else if (syntax.singleQuote === 'string') {
          quoted("'", syntax.multiline);
          prev = 'l';
        } else if (syntax.singleQuote === 'char') {
          const match = at(CHAR_STICKY, i);
          if (match) {
            mark(i, i + match[0].length, LITERAL);
            i += match[0].length;
            prev = 'l';
          } else {
            i += 1;
            prev = c;
          }
        } else {
          i += 1;
          prev = c;
        }
        continue;
      }
      if (c === '`' && syntax.backtick !== 'none') {
        if (syntax.backtick === 'template') template();
        else until('`', 1, LITERAL);
        prev = 'l';
        continue;
      }
      if (c === '/' && syntax.regex && regexAllowed() && regexLiteral()) {
        prev = 'l';
        continue;
      }
      if (WORD_CHAR.test(c)) {
        const word = at(WORD_RUN, i);
        if (word) {
          i += word[0].length;
          prev = 'w';
          prevWord = word[0];
          continue;
        }
      }
      if (c === '{') {
        depth += 1;
      } else if (c === '}') {
        if (stopAtBrace && depth === 0) return;
        depth -= 1;
      }
      prev = c;
      i += 1;
    }
  }

  code(false);
  return mask;
}

export function createSource(text: string, syntax: Syntax): Source {
  return { text, mask: scan(text, syntax), syntax };
}

const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

export function isBalanced(text: string, mask: Uint8Array): boolean {
  const stack: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (mask[i] !== CODE) continue;
    const c = text[i]!;
    if (c === '(' || c === '[' || c === '{') {
      stack.push(c);
    } else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== PAIRS[c]) return false;
    }
  }
  return stack.length === 0;
}

export function matchingClose(source: Source, open: number): number {
  const { text, mask } = source;
  if (mask[open] !== CODE) return -1;
  const opener = text[open]!;
  const closer = opener === '(' ? ')' : opener === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (mask[i] !== CODE) continue;
    const c = text[i]!;
    if (c === opener) {
      depth += 1;
    } else if (c === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function findBody(source: Source, from: number): number {
  const { text, mask } = source;
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (mask[i] !== CODE) continue;
    const c = text[i]!;
    if (c === '(' || c === '[') {
      depth += 1;
    } else if (c === ')' || c === ']') {
      depth -= 1;
      if (depth < 0) return -1;
    } else if (depth === 0) {
      if (c === '{') return i;
      if (c === ';' || c === '@') return -1;
      if (c === '#' && text[i + 1] === '[') return -1;
    }
  }
  return -1;
}

export function skipTrivia(source: Source, from: number): number {
  const { text, mask } = source;
  let i = from;
  while (i < text.length && (mask[i] === COMMENT || /\s/.test(text[i]!))) i += 1;
  return i;
}

export function lineStartOf(text: string, index: number): number {
  return text.lastIndexOf('\n', index - 1) + 1;
}

export function lineEndOf(text: string, from: number): number {
  const end = text.indexOf('\n', from);
  return end === -1 ? text.length : end;
}

export function isWordChar(char: string): boolean {
  return WORD_CHAR.test(char);
}
