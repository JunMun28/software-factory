import { describe, expect, it } from 'vitest';
import { SqliteDriver, translatePlaceholders } from '../src/sql-driver.js';

describe('translatePlaceholders', () => {
  it('numbers placeholders from zero, in order', () => {
    expect(translatePlaceholders('INSERT INTO t (a, b, c) VALUES (?, ?, ?)')).toBe(
      'INSERT INTO t (a, b, c) VALUES (@p0, @p1, @p2)',
    );
  });

  it('leaves a question mark inside a string literal alone', () => {
    // The `?` in 'what?' is data. Renaming it would silently corrupt the value
    // written to the column — the failure this test exists to prevent.
    expect(translatePlaceholders("UPDATE t SET q = 'what?' WHERE id = ?")).toBe(
      "UPDATE t SET q = 'what?' WHERE id = @p0",
    );
  });

  it('keeps counting correctly after a literal', () => {
    expect(
      translatePlaceholders("SELECT * FROM t WHERE a = ? AND b = 'x?y' AND c = ?"),
    ).toBe("SELECT * FROM t WHERE a = @p0 AND b = 'x?y' AND c = @p1");
  });

  it('handles a doubled quote inside a literal', () => {
    expect(translatePlaceholders("SELECT 'it''s ok?' , ? FROM t")).toBe(
      "SELECT 'it''s ok?' , @p0 FROM t",
    );
  });

  it('is a no-op when there are no placeholders', () => {
    expect(translatePlaceholders('SELECT 1')).toBe('SELECT 1');
  });
});

describe('SqliteDriver', () => {
  const open = async () => {
    const d = new SqliteDriver(':memory:');
    await d.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)');
    return d;
  };

  it('round-trips rows through run/get/all', async () => {
    const d = await open();
    await d.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);
    await d.run('INSERT INTO t (id, n) VALUES (?, ?)', ['b', 2]);

    expect(await d.get<{ n: number }>('SELECT n FROM t WHERE id = ?', ['a'])).toEqual({
      n: 1,
    });
    expect(await d.all('SELECT id FROM t ORDER BY id')).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
    await d.close();
  });

  it('reports rows affected so callers can tell updated from not-found', async () => {
    const d = await open();
    await d.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);

    expect((await d.run('UPDATE t SET n = ? WHERE id = ?', [9, 'a'])).changes).toBe(1);
    expect((await d.run('UPDATE t SET n = ? WHERE id = ?', [9, 'nope'])).changes).toBe(0);
    await d.close();
  });

  it('returns undefined rather than throwing when a row is missing', async () => {
    const d = await open();
    expect(await d.get('SELECT n FROM t WHERE id = ?', ['ghost'])).toBeUndefined();
    await d.close();
  });

  it('rolls a transaction back', async () => {
    const d = await open();
    await d.begin();
    await d.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);
    await d.rollback();
    expect(await d.all('SELECT id FROM t')).toEqual([]);
    await d.close();
  });

  it('commits a transaction', async () => {
    const d = await open();
    await d.begin();
    await d.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);
    await d.commit();
    expect(await d.all('SELECT id FROM t')).toEqual([{ id: 'a' }]);
    await d.close();
  });
});
