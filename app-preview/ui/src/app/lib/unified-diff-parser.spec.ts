import { describe, expect, it } from 'vitest';

import { parseUnifiedDiff } from './unified-diff-parser';

describe('parseUnifiedDiff', () => {
  it('returns empty array for blank diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('   \n')).toEqual([]);
  });

  it('parses hunks with add, remove, and context lines', () => {
    const diff = [
      'diff --git a/hello.txt b/hello.txt',
      '--- a/hello.txt',
      '+++ b/hello.txt',
      '@@ -1,2 +1,2 @@',
      ' unchanged',
      '-removed',
      '+added',
    ].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.header).toBe('@@ -1,2 +1,2 @@');

    const lineKinds = hunks[0]?.lines
      .filter((line) => line.kind !== 'meta')
      .map((line) => line.kind);
    expect(lineKinds).toEqual(['context', 'remove', 'add']);
  });

  it('assigns line numbers within a hunk', () => {
    const diff = ['@@ -10,1 +10,2 @@', ' context', '+inserted'].join('\n');
    const hunks = parseUnifiedDiff(diff);
    const lines = hunks[0]?.lines ?? [];

    expect(lines[0]).toMatchObject({
      kind: 'context',
      oldLineNumber: 10,
      newLineNumber: 10,
    });
    expect(lines[1]).toMatchObject({
      kind: 'add',
      newLineNumber: 11,
    });
  });
});
