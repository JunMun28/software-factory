import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectWorkspaceDatabase } from '../src/workspace-database.js';

describe('inspectWorkspaceDatabase', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('returns a contained empty state when the golden-template database is absent', async () => {
    const workspace = await createWorkspace();

    await expect(inspectWorkspaceDatabase(workspace)).resolves.toEqual({
      connected: false,
      engine: 'SQLite',
      path: 'backend/app.db',
      tables: [],
    });
  });

  it('reads tables, columns, and preview rows without mutating the database', async () => {
    const workspace = await createWorkspace();
    const dbPath = path.join(workspace, 'backend', 'app.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    db.prepare('INSERT INTO item (name) VALUES (?)').run('Alpha');
    db.close();

    const result = await inspectWorkspaceDatabase(workspace);

    expect(result.connected).toBe(true);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({
      name: 'item',
      columns: [
        { name: 'id', type: 'INTEGER', nullable: true, primaryKey: true },
        { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
      ],
      rows: [{ id: 1, name: 'Alpha' }],
    });
  });

  async function createWorkspace(): Promise<string> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ng-v0-db-'));
    roots.push(workspace);
    await mkdir(path.join(workspace, 'backend'), { recursive: true });
    return workspace;
  }
});
