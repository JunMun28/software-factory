/**
 * The persistence seam.
 *
 * PlatformDb used to talk to `node:sqlite` directly, whose API is synchronous.
 * Azure SQL is only reachable through an asynchronous driver, so the interface
 * here is async and SQLite fulfils it with already-resolved promises — the
 * underlying calls stay synchronous, nothing is deferred artificially.
 *
 * Call sites keep `?` placeholders in their SQL regardless of dialect; the
 * MSSQL driver rewrites them. That is what keeps one set of SQL strings
 * serving both databases.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type Dialect = 'sqlite' | 'mssql';

export interface RunResult {
  /** Rows affected. Callers use this to distinguish "updated" from "not found". */
  changes: number;
}

export interface SqlDriver {
  readonly dialect: Dialect;
  exec(sql: string): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  /**
   * Run `fn` inside a transaction, serialized against every other
   * withTransaction on this driver. Commits on return, rolls back on throw and
   * rethrows. NOT reentrant — calling it from inside `fn` deadlocks.
   */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Serializes transaction bodies onto one chain.
 *
 * Every driver here owns exactly ONE connection (SQLite's DatabaseSync; the
 * MssqlDriver's single `tx` field), so two overlapping begin…commit blocks
 * share one transaction scope. Before this gate existed, chat B's begin() threw
 * and B's catch called rollback(), which discarded chat A's already-inserted
 * rows — silent turn-history loss under exactly the concurrency this service is
 * built for. plans/015.
 */
class TransactionGate {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the tail whether the previous body settled or threw; a failed
    // transaction must not wedge the queue.
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/**
 * Rewrite positional `?` placeholders to SQL Server's named `@p0, @p1, ...`.
 *
 * Quoted string literals are skipped: a `?` inside 'what?' is data, not a
 * placeholder, and renaming it would corrupt the value. SQL Server escapes a
 * quote inside a literal by doubling it ('it''s'), which this handles by
 * simply toggling on each quote — the doubled pair toggles off then on again
 * and stays inside the literal, which is the behaviour we want.
 */
export function translatePlaceholders(sql: string): string {
  let out = '';
  let inLiteral = false;
  let n = 0;
  for (const ch of sql) {
    if (ch === "'") {
      inLiteral = !inLiteral;
      out += ch;
      continue;
    }
    if (ch === '?' && !inLiteral) {
      out += `@p${n++}`;
      continue;
    }
    out += ch;
  }
  return out;
}

export class SqliteDriver implements SqlDriver {
  readonly dialect = 'sqlite' as const;
  private readonly db: DatabaseSync;
  private readonly gate = new TransactionGate();

  constructor(target: string) {
    if (target !== ':memory:') {
      mkdirSync(path.dirname(target), { recursive: true });
    }
    this.db = new DatabaseSync(target);
    this.db.exec('PRAGMA foreign_keys = ON');
    if (target !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
    }
  }

  /** Escape hatch for the SQLite-only legacy checks in the tests. */
  get raw(): DatabaseSync {
    return this.db;
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as unknown as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = this.db.prepare(sql).run(...(params as never[]));
    return { changes: Number(result.changes) };
  }

  private async begin(): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
  }

  private async commit(): Promise<void> {
    this.db.exec('COMMIT');
  }

  private async rollback(): Promise<void> {
    this.db.exec('ROLLBACK');
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.gate.run(async () => {
      await this.begin();
      try {
        const result = await fn();
        await this.commit();
        return result;
      } catch (error) {
        await this.rollback();
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export class MssqlDriver implements SqlDriver {
  readonly dialect = 'mssql' as const;
  private readonly pool: import('mssql').ConnectionPool;
  private readonly mssql: typeof import('mssql');
  private tx: import('mssql').Transaction | null = null;
  private readonly gate = new TransactionGate();

  constructor(mssql: typeof import('mssql'), pool: import('mssql').ConnectionPool) {
    this.mssql = mssql;
    this.pool = pool;
  }

  /**
   * Requests run on the open transaction when there is one. Taking a fresh
   * connection from the pool mid-transaction would land the statement outside
   * it, so BEGIN/COMMIT must bind to one connection.
   */
  private request(): import('mssql').Request {
    return this.tx ? new this.mssql.Request(this.tx) : this.pool.request();
  }

  private bind(sql: string, params: unknown[]): { text: string; req: import('mssql').Request } {
    const req = this.request();
    params.forEach((value, i) => {
      req.input(`p${i}`, value === undefined ? null : value);
    });
    return { text: translatePlaceholders(sql), req };
  }

  async exec(sql: string): Promise<void> {
    // batch(), not query(): DDL scripts carry GO-less multi-statement bodies
    // and CREATE SCHEMA/PROCEDURE must be the first statement in its batch.
    await this.request().batch(sql);
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { text, req } = this.bind(sql, params);
    const result = await req.query(text);
    return result.recordset as unknown as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const { text, req } = this.bind(sql, params);
    const result = await req.query(text);
    const affected = Array.isArray(result.rowsAffected)
      ? result.rowsAffected.reduce((a, b) => a + b, 0)
      : 0;
    return { changes: affected };
  }

  private async begin(): Promise<void> {
    if (this.tx) {
      throw new Error('MssqlDriver: a transaction is already open');
    }
    const tx = new this.mssql.Transaction(this.pool);
    await tx.begin();
    this.tx = tx;
  }

  private async commit(): Promise<void> {
    if (!this.tx) {
      throw new Error('MssqlDriver: commit without an open transaction');
    }
    const tx = this.tx;
    this.tx = null;
    await tx.commit();
  }

  private async rollback(): Promise<void> {
    if (!this.tx) {
      return; // rollback on a closed transaction is a no-op, not an error
    }
    const tx = this.tx;
    this.tx = null;
    await tx.rollback();
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.gate.run(async () => {
      await this.begin();
      try {
        const result = await fn();
        await this.commit();
        return result;
      } catch (error) {
        await this.rollback();
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.rollback();
    await this.pool.close();
  }
}

/**
 * Pick a driver from the target string.
 *
 * `mssql://<server>/<database>` selects Azure SQL; anything else is a SQLite
 * path (including `:memory:`), which keeps the test suite offline and fast.
 *
 * Credentials are never taken from the target string. With
 * APPVIEW_DB_CLIENT_ID/_SECRET/_TENANT_ID set, the app authenticates as that
 * service principal; without them it falls back to the ambient Azure identity,
 * which is what lets a developer connect using their own `az login` and no
 * secret at all.
 */
export async function createDriver(target: string): Promise<SqlDriver> {
  if (!target.startsWith('mssql://')) {
    return new SqliteDriver(target);
  }

  const url = new URL(target);
  const database = url.pathname.replace(/^\//, '');
  if (!url.hostname || !database) {
    throw new Error(`Malformed mssql target (need mssql://server/database): ${target}`);
  }

  const mssql = (await import('mssql')).default;
  const clientId = process.env.APPVIEW_DB_CLIENT_ID;
  const clientSecret = process.env.APPVIEW_DB_CLIENT_SECRET;
  const tenantId = process.env.APPVIEW_DB_TENANT_ID;

  const authentication =
    clientId && clientSecret && tenantId
      ? {
          type: 'azure-active-directory-service-principal-secret' as const,
          options: { clientId, clientSecret, tenantId },
        }
      : { type: 'azure-active-directory-default' as const };

  const pool = await new mssql.ConnectionPool({
    server: url.hostname,
    database,
    authentication,
    options: { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 30_000,
    requestTimeout: 60_000,
  } as import('mssql').config).connect();

  return new MssqlDriver(mssql, pool);
}
