import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface WorkspaceDatabaseColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface WorkspaceDatabaseTable {
  name: string;
  columns: WorkspaceDatabaseColumn[];
  rows: Record<string, unknown>[];
}

export interface WorkspaceDatabaseInspection {
  connected: boolean;
  engine: 'SQLite';
  path: 'backend/app.db';
  tables: WorkspaceDatabaseTable[];
}

interface TableInfoRow {
  name: string;
  type: string;
  is_not_null: number;
  pk: number;
}

const DATABASE_PATH = 'backend/app.db' as const;

export async function inspectWorkspaceDatabase(
  workspaceDir: string,
): Promise<WorkspaceDatabaseInspection> {
  const databasePath = path.join(workspaceDir, DATABASE_PATH);
  if (!existsSync(databasePath)) {
    return {
      connected: false,
      engine: 'SQLite',
      path: DATABASE_PATH,
      tables: [],
    };
  }

  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tableNames = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name
         LIMIT 40`,
      )
      .all() as unknown as Array<{ name: string }>;

    const tables = tableNames.map(({ name }) => {
      const columns = db
        .prepare(
          `SELECT name, type, "notnull" AS is_not_null, pk
           FROM pragma_table_info(?)
           ORDER BY cid`,
        )
        .all(name) as unknown as TableInfoRow[];
      const quotedName = quoteIdentifier(name);
      const rows = db
        .prepare(`SELECT * FROM ${quotedName} LIMIT 50`)
        .all() as unknown as Record<string, unknown>[];

      return {
        name,
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type || 'ANY',
          nullable: column.is_not_null === 0,
          primaryKey: column.pk > 0,
        })),
        rows,
      } satisfies WorkspaceDatabaseTable;
    });

    return {
      connected: true,
      engine: 'SQLite',
      path: DATABASE_PATH,
      tables,
    };
  } finally {
    db.close();
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
