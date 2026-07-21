export type DiffLineKind =
  | 'file-header'
  | 'hunk-header'
  | 'context'
  | 'add'
  | 'remove'
  | 'meta';

export interface ParsedDiffLine {
  kind: DiffLineKind;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface ParsedDiffHunk {
  header: string;
  lines: ParsedDiffLine[];
}

export function parseUnifiedDiff(diff: string): ParsedDiffHunk[] {
  if (!diff.trim()) {
    return [];
  }

  const hunks: ParsedDiffHunk[] = [];
  let currentHunk: ParsedDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of diff.split('\n')) {
    if (rawLine.startsWith('@@')) {
      currentHunk = { header: rawLine, lines: [] };
      hunks.push(currentHunk);

      const match = rawLine.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = match ? Number(match[1]) : 0;
      newLine = match ? Number(match[2]) : 0;
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (
      rawLine.startsWith('+++') ||
      rawLine.startsWith('---') ||
      rawLine.startsWith('diff --git') ||
      rawLine.startsWith('index ') ||
      rawLine.startsWith('new file mode') ||
      rawLine.startsWith('deleted file mode')
    ) {
      currentHunk.lines.push({ kind: 'meta', content: rawLine });
      continue;
    }

    const prefix = rawLine[0] ?? ' ';
    const content = rawLine.slice(1);

    if (prefix === '+') {
      currentHunk.lines.push({
        kind: 'add',
        content,
        newLineNumber: newLine,
      });
      newLine += 1;
      continue;
    }

    if (prefix === '-') {
      currentHunk.lines.push({
        kind: 'remove',
        content,
        oldLineNumber: oldLine,
      });
      oldLine += 1;
      continue;
    }

    currentHunk.lines.push({
      kind: 'context',
      content,
      oldLineNumber: oldLine,
      newLineNumber: newLine,
    });
    oldLine += 1;
    newLine += 1;
  }

  return hunks;
}
