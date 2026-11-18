import { describe, expect, it } from 'vitest';
import {
  batchComments,
  extractCommentBlocks,
  isCommentFile,
  parseAddedLines,
  pruneComments,
  type CommentBlock,
} from '../src/comments.js';
import { parseCommentScope } from '../hooks/fast-jev.js';
import type { JevAsker, JevQuestions } from '../src/types.js';
import type { TestFileAccess } from '../src/tests.js';

function memoryFiles(initial: Record<string, string>): TestFileAccess & { contents: Map<string, string> } {
  const contents = new Map(Object.entries(initial));
  return {
    contents,
    list: async () => [...contents.keys()],
    read: async (path) => contents.get(path) ?? '',
    write: async (path, text) => void contents.set(path, text),
  };
}

function scoreBy(keep: (comment: string) => boolean) {
  const seen: Array<{ comments: Array<{ id: string; comment: string }> }> = [];
  const asker: JevAsker & { seen: typeof seen } = {
    seen,
    async ask(state, questions: JevQuestions) {
      const comments = (state as { comments: Array<{ id: string; comment: string }> }).comments;
      seen.push({ comments });
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => {
            const id = key.replace(/^keep_/, '');
            const comment = comments.find((c) => c.id === id)!.comment;
            return [key, { type: 'noul' as const, noul: keep(comment) ? 0.9 : 0.01 }];
          }),
        ),
      };
    },
  } as JevAsker & { seen: typeof seen };
  return asker;
}

function linesOf(file: string, text: string, lines?: ReadonlySet<number>) {
  return extractCommentBlocks(file, text, lines).map((b) => [b.startLine, b.endLine, b.text]);
}

describe('comment extraction', () => {
  it('keeps full-line comment blocks and ignores trailing comments', () => {
    const src = 'const a = 1; // trailing\n// explains why\n// continued\nconst b = 2;\n\n// standalone\n/* block\n */\nconst c = 3;\n';
    expect(linesOf('x.ts', src)).toEqual([
      [2, 3, '// explains why\n// continued'],
      [6, 6, '// standalone'],
      [7, 8, '/* block\n */'],
    ]);
  });

  it('ignores comment markers inside string literals', () => {
    expect(linesOf('x.ts', 'const u = "http://x";\nconst v = \'//no\';\n')).toEqual([]);
    expect(linesOf('x.ts', 'const u = "http://x";\n// real note\n')).toEqual([[2, 2, '// real note']]);
  });

  it('ignores hash markers inside python triple-quoted strings', () => {
    const src = 's = """\n# not a comment\n"""\n# real note\nx = 1\n';
    expect(linesOf('m.py', src)).toEqual([[4, 4, '# real note']]);
  });

  it('never returns pragma, licence or shebang comments', () => {
    expect(linesOf('x.ts', '// eslint-disable-next-line\nrun();\n')).toEqual([]);
    expect(linesOf('m.py', '#!/usr/bin/env python\nprint(1)\n')).toEqual([]);
    expect(linesOf('x.ts', '/* Copyright 2024 Example */\nexport {};\n')).toEqual([]);
  });

  it('keeps only blocks that overlap the changed lines when given a line set', () => {
    const src = '// old note\nconst a = 1;\n// obsolete\nconst b = 2;\n';
    expect(linesOf('a.ts', src, new Set([3]))).toEqual([[3, 3, '// obsolete']]);
    expect(linesOf('a.ts', src, new Set([4]))).toEqual([]);
  });

  it('uses the language syntax for the file extension', () => {
    expect(linesOf('run.sh', '# shell note\necho hi\n')).toEqual([[1, 1, '# shell note']]);
    expect(linesOf('q.sql', '-- sql note\nselect 1;\n')).toEqual([[1, 1, '-- sql note']]);
    expect(linesOf('page.html', '<!-- html note -->\n<p></p>\n')).toEqual([[1, 1, '<!-- html note -->']]);
    expect(isCommentFile('README.md')).toBe(false);
    expect(isCommentFile('node_modules/x/a.js')).toBe(false);
  });
});

describe('diff parsing', () => {
  it('maps added lines per new-side file and skips deleted files', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -3,0 +4,2 @@',
      '+// one',
      '+// two',
      '@@ -10 +12 @@',
      '-old',
      '+new',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      'diff --git a/fresh.ts b/fresh.ts',
      '--- /dev/null',
      '+++ b/fresh.ts',
      '@@ -0,0 +1 @@',
      '+hello',
      '',
    ].join('\n');
    const added = parseAddedLines(diff);
    expect([...added.keys()].sort()).toEqual(['a.ts', 'fresh.ts']);
    expect([...added.get('a.ts')!].sort((x, y) => x - y)).toEqual([4, 5, 12]);
    expect([...added.get('fresh.ts')!]).toEqual([1]);
  });
});

describe('comment pruning', () => {
  const source = '// old note\nconst a = 1;\n// obsolete\nconst b = 2;\n';

  it('deletes only the low-scoring comment in changed lines', async () => {
    const files = memoryFiles({ 'a.ts': source });
    const asker = scoreBy((comment) => comment.includes('why'));
    const result = await pruneComments(files, asker, { addedLines: new Map([['a.ts', new Set([3])]]) });
    expect(result.comments).toBe(1);
    expect(result.deleted.map((d) => [d.file, d.startLine])).toEqual([['a.ts', 3]]);
    expect(files.contents.get('a.ts')).toBe('// old note\nconst a = 1;\nconst b = 2;\n');
  });

  it('sends only changed-line comments to Jev in diff scope', async () => {
    const files = memoryFiles({ 'a.ts': source });
    const asker = scoreBy(() => true);
    await pruneComments(files, asker, { addedLines: new Map([['a.ts', new Set([3])]]) });
    expect(asker.seen.flatMap((s) => s.comments.map((c) => c.comment))).toEqual(['// obsolete']);
  });

  it('judges every comment in the repository when no line filter is given', async () => {
    const files = memoryFiles({ 'a.ts': source });
    const asker = scoreBy((comment) => comment.includes('why'));
    const result = await pruneComments(files, asker);
    expect(result.comments).toBe(2);
    expect(result.deleted.map((d) => d.startLine).sort()).toEqual([1, 3]);
    expect(files.contents.get('a.ts')).toBe('const a = 1;\nconst b = 2;\n');
  });

  it('skips non-comment files, binary files and files outside the diff', async () => {
    const files = memoryFiles({
      'README.md': '# heading\n',
      'blob.ts': '// binary\0 note\n',
      'a.ts': source,
      'b.ts': '// other file\n',
    });
    const asker = scoreBy(() => false);
    const result = await pruneComments(files, asker, { addedLines: new Map([['a.ts', new Set([1, 3])]]) });
    expect(result.files).toBe(1);
    expect(result.comments).toBe(2);
    expect(files.contents.get('b.ts')).toBe('// other file\n');
    expect(files.contents.get('blob.ts')).toBe('// binary\0 note\n');
  });

  it('keeps comments whose Jev score is at the threshold', async () => {
    const files = memoryFiles({ 'a.ts': '// edge\nconst a = 1;\n' });
    const asker: JevAsker = {
      async ask(_state, questions) {
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul: 0.1 }])) };
      },
    };
    const result = await pruneComments(files, asker, { deleteThreshold: 0.1 });
    expect(result.deleted).toEqual([]);
    expect(files.contents.get('a.ts')).toBe('// edge\nconst a = 1;\n');
  });

  it('splits blocks into batches without dropping or reordering any', () => {
    const blocks: CommentBlock[] = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i + 1}`,
      file: 'a.ts',
      start: 0,
      end: 1,
      startLine: i + 1,
      endLine: i + 1,
      text: `// note number ${i + 1} ${'padding '.repeat(20)}`,
      code: 'const x = 1;',
    }));
    const batches = batchComments(blocks, 1200, 2000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((b) => b.id)).toEqual(blocks.map((b) => b.id));
  });
});

describe('command scope argument', () => {
  it('defaults to diff and accepts all, case-insensitively', () => {
    expect(parseCommentScope('')).toBe('diff');
    expect(parseCommentScope('  ')).toBe('diff');
    expect(parseCommentScope('diff')).toBe('diff');
    expect(parseCommentScope(' ALL ')).toBe('all');
  });

  it('rejects unknown scopes', () => {
    expect(parseCommentScope('staged')).toBeUndefined();
    expect(parseCommentScope('all please')).toBeUndefined();
  });
});
