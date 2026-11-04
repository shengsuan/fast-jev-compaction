import { describe, expect, it } from 'vitest';
import { extractTestFunctions, isTestFile, pruneTests, removeRanges } from '../src/tests.js';

const source = `import { it } from 'vitest';

it('adds', () => {
  expect(1 + 1).toBe(2);
});

it('does nothing', () => {
  const s = ")";
});

it('subtracts', () => {
  expect(2 - 1).toBe(1);
});
`;

describe('test pruning', () => {
  it('recognises test files and skips dependencies', () => {
    expect(isTestFile('tests/a.test.ts')).toBe(true);
    expect(isTestFile('pkg/test_a.py')).toBe(true);
    expect(isTestFile('node_modules/x/a.test.ts')).toBe(false);
    expect(isTestFile('src/a.ts')).toBe(false);
  });

  it('extracts test functions with their ranges', () => {
    const found = extractTestFunctions('a.test.ts', source);
    expect(found.map((t) => t.name)).toEqual(['adds', 'does nothing', 'subtracts']);
    expect(removeRanges(source, [found[1]!])).not.toContain('does nothing');
    expect(removeRanges(source, [found[1]!])).toContain('subtracts');
  });

  it('extracts python tests', () => {
    const py = 'def test_a():\n    assert 1\n\n\ndef test_b():\n    pass\n';
    const found = extractTestFunctions('test_x.py', py);
    expect(found.map((t) => t.name)).toEqual(['test_a', 'test_b']);
    expect(removeRanges(py, [found[1]!])).toBe('def test_a():\n    assert 1\n');
  });

  it('deletes tests Jev scores below the threshold', async () => {
    const files = new Map([['a.test.ts', source]]);
    const asker = {
      async ask(_state: unknown, questions: Record<string, unknown>) {
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: key === 'keep_u2' ? 0.01 : 0.9 }]),
          ),
        };
      },
    };
    const result = await pruneTests(
      {
        list: async () => [...files.keys()],
        read: async (path) => files.get(path) ?? '',
        write: async (path, text) => void files.set(path, text),
      },
      asker,
    );
    expect(result.deleted.map((d) => d.name)).toEqual(['does nothing']);
    expect(files.get('a.test.ts')).toContain('adds');
    expect(files.get('a.test.ts')).not.toContain('does nothing');
  });
});

const samples: Array<[string, string, string[]]> = [
  ['pkg/foo_test.go', 'package foo\n\nfunc TestA(t *testing.T) {\n\tif x := "}"; x != "" {\n\t}\n}\n\nfunc helper() {}\n\nfunc TestB(t *testing.T) {\n}\n', ['TestA', 'TestB']],
  ['src/lib.rs', 'fn x() {}\n\n#[test]\nfn adds() {\n    assert_eq!(1, \'}\' as i32 - 124);\n}\n\n#[cfg(test)]\n#[tokio::test]\nasync fn waits() {}\n', ['adds', 'waits']],
  ['src/test/java/FooTest.java', 'class FooTest {\n  @Test\n  void adds() {\n    assertEquals("}", "}");\n  }\n\n  @ParameterizedTest\n  @ValueSource(ints = 1)\n  void many(int x) {}\n}\n', ['adds', 'many']],
  ['Tests/FooTests.cs', 'class FooTests {\n  [Fact]\n  public void Adds() {\n  }\n\n  [Theory]\n  [InlineData(1)]\n  public void Many(int x) {\n  }\n}\n', ['Adds', 'Many']],
  ['spec/foo_spec.rb', 'describe Foo do\n  it "adds" do\n    expect(1).to eq 1\n  end\n\n  it "subtracts" do\n  end\nend\n', ['adds', 'subtracts']],
  ['tests/FooTest.php', '<?php\nclass FooTest {\n    public function testAdds() {\n        $this->assertTrue(true);\n    }\n}\n', ['testAdds']],
  ['Tests/FooTests.swift', 'class FooTests: XCTestCase {\n    func testAdds() {\n        XCTAssert(true)\n    }\n}\n', ['testAdds']],
  ['test/foo_test.exs', 'defmodule FooTest do\n  test "adds" do\n    assert 1 == 1\n  end\nend\n', ['adds']],
  ['test/foo_test.dart', "void main() {\n  test('adds', () {\n    expect(1, 1);\n  });\n}\n", ['adds']],
  ['tests/foo_test.cpp', 'TEST(Foo, Adds) {\n  EXPECT_EQ(1, 1);\n}\n\nTEST_F(Fixture, Subs) {\n}\n', ['Foo, Adds', 'Fixture, Subs']],
  ['tests/testthat/test-foo.R', 'test_that("adds", {\n  expect_equal(1, 1)\n})\n', ['adds']],
  ['test/foo.bats', '@test "adds" {\n  run true\n}\n', ['adds']],
  ['src/main.zig', 'test "adds" {\n    try expect(true);\n}\n', ['adds']],
  ['src/FooSpec.scala', 'class FooSpec {\n  test("adds") {\n    assert(true)\n  }\n}\n', ['adds']],
];

describe('languages', () => {
  it.each(samples)('extracts tests from %s', (file, text, names) => {
    expect(isTestFile(file)).toBe(true);
    const found = extractTestFunctions(file, text);
    expect(found.map((t) => t.name)).toEqual(names);
    for (const t of found) expect(text.slice(t.start, t.end)).toBe(t.source);
  });
});
