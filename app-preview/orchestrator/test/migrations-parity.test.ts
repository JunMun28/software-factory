import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

function list(dialect: 'sqlite' | 'mssql'): string[] {
  return readdirSync(path.join(migrationsRoot, dialect))
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

// PlatformDb picks its migration folder by dialect, so a migration added to
// only one folder would silently skip the other database — the schemas drift
// and the local/Azure switch stops being safe. Same filenames, always.
describe('migration dialect parity', () => {
  it('sqlite and mssql carry the same migration set', () => {
    expect(list('mssql')).toEqual(list('sqlite'));
  });

  it('migration names are ordered, numbered, and collision-free', () => {
    const files = list('sqlite');
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file).toMatch(/^\d{4}-[a-z0-9-]+\.sql$/);
    }
    const prefixes = files.map((file) => file.slice(0, 4));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
