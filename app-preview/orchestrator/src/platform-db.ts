import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DashboardBlueprint } from './blueprints/types.js';
import { createDriver, type SqlDriver } from './sql-driver.js';
import type {
  OrchestratorEvent,
  VersionDiffStat,
  VersionFileChange,
} from './types.js';

const migrationsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

export const FOUNDER_USER_ID = 'founder';
export const DEFAULT_PROJECT_ID = 'local-workspace';
const DEFAULT_PROJECT_NAME = 'Local workspace';

/**
 * Bookkeeping table for applied migrations.
 *
 * Named with a prefix rather than the bare `migrations`, because on Azure SQL
 * this database is shared with the factory and `migrations` is too generic a
 * name to claim.
 */
const MIGRATIONS_TABLE = 'appview_migrations';

export interface ChatRow {
  id: string;
  project_id: string;
  workspace_ref: string;
  title: string | null;
}

export interface ChatSeed {
  url: string;
  ref: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  chatCount: number;
  createdAt: string;
}

export interface TurnHistoryRow {
  generationId: string;
  turn_number: number;
  prompt: string;
  narration: string;
  result: string;
  gate_output_tail: string | null;
  started_at: string;
  finished_at: string | null;
  version_commit: string | null;
  version_message: string | null;
}

export interface GenerationRow {
  id: string;
  chatId: string;
  result: string;
}

export interface VersionRow {
  id: string;
  chatId: string;
  generationId: string | null;
  seq: number;
  manifestRef: string;
  message: string | null;
  restoredFromVersionId: string | null;
  createdAt: string;
  diffStat: VersionDiffStat | null;
  files: VersionFileChange[] | null;
}

interface VersionQueryRow {
  id: string;
  chatId: string;
  generationId: string | null;
  seq: number;
  manifestRef: string;
  message: string | null;
  restoredFromVersionId: string | null;
  createdAt: string;
  diffstatJson: string | null;
  filesJson: string | null;
}

export interface TurnEventRow {
  chatId: string;
  generationId: string;
  seq: number;
  type: OrchestratorEvent['type'];
  event: OrchestratorEvent;
  createdAt: string;
}

export interface BlueprintRevisionRow {
  id: string;
  chatId: string;
  revision: number;
  blueprint: DashboardBlueprint;
  approved: boolean;
  approvedAt: string | null;
  createdAt: string;
}

export type ConnectionKind = 'mssql' | 'snowflake' | 'rest';

export interface ConnectionSummary {
  id: string;
  chatId: string;
  name: string;
  kind: ConnectionKind;
  config: Record<string, string>;
  createdAt: string;
}

export interface ConnectionRow extends ConnectionSummary {
  secret: Record<string, string>;
}

/**
 * Metadata store for chats, generations and versions.
 *
 * Runs on either SQLite or Azure SQL through the SqlDriver seam. SQLite stays
 * the default so the test suite is offline and instant; a `mssql://` target
 * moves the same schema to Azure SQL without changing any caller.
 *
 * Every method is async because the MSSQL driver is — the SQLite path is still
 * synchronous underneath and pays nothing but a resolved promise.
 */
export class PlatformDb {
  private readonly driver: SqlDriver;
  private readonly nextEventSeq = new Map<string, number>();
  readonly defaultProjectId: string;

  private constructor(driver: SqlDriver, defaultProjectId: string) {
    this.driver = driver;
    this.defaultProjectId = defaultProjectId;
  }

  /**
   * Open a database and bring it to head.
   *
   * A static factory rather than a constructor: migrate and seed both await,
   * and a constructor cannot.
   */
  static async open(target: string): Promise<PlatformDb> {
    const driver = await createDriver(target);
    await PlatformDb.migrate(driver);
    const defaultProjectId = await PlatformDb.seed(driver);
    return new PlatformDb(driver, defaultProjectId);
  }

  get dialect() {
    return this.driver.dialect;
  }

  /** SQLite-only escape hatch for tests that assert on raw storage. */
  get rawDriver(): SqlDriver {
    return this.driver;
  }

  private static async migrate(driver: SqlDriver): Promise<void> {
    const createTable =
      driver.dialect === 'mssql'
        ? `IF OBJECT_ID('${MIGRATIONS_TABLE}') IS NULL CREATE TABLE ${MIGRATIONS_TABLE} (name NVARCHAR(450) PRIMARY KEY, applied_at NVARCHAR(450) NOT NULL)`
        : `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`;
    await driver.exec(createTable);

    // A database created before the table was renamed still records its
    // history under `migrations`. Carry those rows over, or every migration
    // would re-run against a schema that already has them.
    if (driver.dialect === 'sqlite') {
      const legacy = await driver.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'",
      );
      if (legacy) {
        const already = await driver.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${MIGRATIONS_TABLE}`,
        );
        if (!already || already.n === 0) {
          await driver.exec(
            `INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) SELECT name, applied_at FROM migrations`,
          );
        }
      }
    }

    const applied = new Set(
      (await driver.all<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`)).map(
        (row) => row.name,
      ),
    );
    const dir = path.join(migrationsRoot, driver.dialect);
    const files = readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }
      await driver.exec(readFileSync(path.join(dir, file), 'utf8'));
      await driver.run(
        `INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`,
        [file, now()],
      );
    }
  }

  private static async seed(driver: SqlDriver): Promise<string> {
    const user = await driver.get<{ id: string }>('SELECT id FROM users WHERE id = ?', [
      FOUNDER_USER_ID,
    ]);
    if (!user) {
      await driver.run(
        'INSERT INTO users (id, email, display_name, created_at) VALUES (?, NULL, ?, ?)',
        [FOUNDER_USER_ID, 'Founder', now()],
      );
    }
    const canonical = await driver.get<{ id: string }>(
      'SELECT id FROM projects WHERE id = ? AND user_id = ?',
      [DEFAULT_PROJECT_ID, FOUNDER_USER_ID],
    );
    if (!canonical) {
      const legacySql =
        driver.dialect === 'mssql'
          ? `SELECT TOP 1 id, created_at AS createdAt
             FROM projects
             WHERE user_id = ? AND name = 'Default project'
             ORDER BY created_at`
          : `SELECT id, created_at AS createdAt
             FROM projects
             WHERE user_id = ? AND name = 'Default project'
             ORDER BY created_at
             LIMIT 1`;
      const legacy = await driver.get<{ id: string; createdAt: string }>(legacySql, [
        FOUNDER_USER_ID,
      ]);
      await driver.begin();
      try {
        await driver.run(
          'INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)',
          [
            DEFAULT_PROJECT_ID,
            FOUNDER_USER_ID,
            DEFAULT_PROJECT_NAME,
            legacy?.createdAt ?? now(),
          ],
        );
        if (legacy) {
          await driver.run('UPDATE chats SET project_id = ? WHERE project_id = ?', [
            DEFAULT_PROJECT_ID,
            legacy.id,
          ]);
          await driver.run('DELETE FROM projects WHERE id = ?', [legacy.id]);
        }
        await driver.commit();
      } catch (error) {
        await driver.rollback();
        throw error;
      }
    }
    await driver.run('UPDATE projects SET name = ? WHERE id = ? AND user_id = ?', [
      DEFAULT_PROJECT_NAME,
      DEFAULT_PROJECT_ID,
      FOUNDER_USER_ID,
    ]);
    return DEFAULT_PROJECT_ID;
  }

  async listProjects(userId: string): Promise<ProjectRow[]> {
    return this.driver.all<ProjectRow>(
      `SELECT p.id, p.name, COUNT(c.id) AS chatCount,
              p.created_at AS createdAt
       FROM projects p
       LEFT JOIN chats c ON c.project_id = p.id
       WHERE p.user_id = ?
       GROUP BY p.id, p.name, p.created_at
       ORDER BY CASE WHEN p.id = ? THEN 0 ELSE 1 END, p.created_at, p.id`,
      [userId, DEFAULT_PROJECT_ID],
    );
  }

  async getProject(userId: string, id: string): Promise<ProjectRow | null> {
    const row = await this.driver.get<ProjectRow>(
      `SELECT p.id, p.name, COUNT(c.id) AS chatCount,
              p.created_at AS createdAt
       FROM projects p
       LEFT JOIN chats c ON c.project_id = p.id
       WHERE p.user_id = ? AND p.id = ?
       GROUP BY p.id, p.name, p.created_at`,
      [userId, id],
    );
    return row ?? null;
  }

  async createProject(userId: string, name: string): Promise<ProjectRow> {
    const projectId = randomUUID();
    await this.driver.run(
      'INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)',
      [projectId, userId, name, now()],
    );
    const project = await this.getProject(userId, projectId);
    if (!project) {
      throw new Error(`Failed to create project: ${projectId}`);
    }
    return project;
  }

  async insertChat(
    chatId: string,
    workspaceRef: string,
    projectId = this.defaultProjectId,
    title?: string,
    seed?: ChatSeed,
  ): Promise<void> {
    const timestamp = now();
    await this.driver.run(
      'INSERT INTO chats (id, project_id, title, workspace_ref, seed_url, seed_ref, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        chatId,
        projectId,
        title ?? null,
        workspaceRef,
        seed?.url ?? null,
        seed?.ref ?? null,
        timestamp,
        timestamp,
      ],
    );
  }

  // Seed provenance for a chat, or null for a template-born one.
  async getChatSeed(chatId: string): Promise<ChatSeed | null> {
    const row = await this.driver.get<{
      seed_url: string | null;
      seed_ref: string | null;
    }>('SELECT seed_url, seed_ref FROM chats WHERE id = ?', [chatId]);
    if (!row || row.seed_url === null || row.seed_ref === null) {
      return null;
    }
    return { url: row.seed_url, ref: row.seed_ref };
  }

  async touchChat(chatId: string): Promise<void> {
    await this.driver.run('UPDATE chats SET last_active_at = ? WHERE id = ?', [
      now(),
      chatId,
    ]);
  }

  async listChats(): Promise<ChatRow[]> {
    return this.driver.all<ChatRow>(
      'SELECT id, project_id, workspace_ref, title FROM chats ORDER BY created_at',
    );
  }

  // The first prompt names the chat; later prompts never rename it.
  async setChatTitleIfEmpty(chatId: string, title: string): Promise<void> {
    await this.driver.run(
      "UPDATE chats SET title = ? WHERE id = ? AND (title IS NULL OR title = '')",
      [title, chatId],
    );
  }

  async getChatTitle(chatId: string): Promise<string | null> {
    const row = await this.driver.get<{ title: string | null }>(
      'SELECT title FROM chats WHERE id = ?',
      [chatId],
    );
    return row?.title ?? null;
  }

  async updateChatTitle(chatId: string, title: string): Promise<boolean> {
    const result = await this.driver.run(
      'UPDATE chats SET title = ?, last_active_at = ? WHERE id = ?',
      [title, now(), chatId],
    );
    return result.changes > 0;
  }

  async listTurns(chatId: string): Promise<TurnHistoryRow[]> {
    return this.driver.all<TurnHistoryRow>(
      `SELECT g.id AS generationId, g.turn_number, g.prompt, g.narration,
              g.result, g.gate_output_tail,
              g.started_at, g.finished_at,
              v.manifest_ref AS version_commit, v.message AS version_message
       FROM generations g
       LEFT JOIN versions v ON v.generation_id = g.id
       WHERE g.chat_id = ?
       ORDER BY g.turn_number`,
      [chatId],
    );
  }

  async getGeneration(generationId: string): Promise<GenerationRow | null> {
    const row = await this.driver.get<GenerationRow>(
      `SELECT id, chat_id AS chatId, result
       FROM generations
       WHERE id = ?`,
      [generationId],
    );
    return row ?? null;
  }

  async getRunningGeneration(chatId: string): Promise<GenerationRow | null> {
    const sql =
      this.driver.dialect === 'mssql'
        ? `SELECT TOP 1 id, chat_id AS chatId, result
           FROM generations
           WHERE chat_id = ? AND result = 'running' AND finished_at IS NULL
           ORDER BY turn_number DESC`
        : `SELECT id, chat_id AS chatId, result
           FROM generations
           WHERE chat_id = ? AND result = 'running' AND finished_at IS NULL
           ORDER BY turn_number DESC
           LIMIT 1`;
    const row = await this.driver.get<GenerationRow>(sql, [chatId]);
    return row ?? null;
  }

  async beginGeneration(
    chatId: string,
    prompt: string,
    planId: string | null = null,
  ): Promise<string> {
    const generationId = randomUUID();
    const next = await this.driver.get<{ n: number }>(
      'SELECT COALESCE(MAX(turn_number), 0) + 1 AS n FROM generations WHERE chat_id = ?',
      [chatId],
    );
    await this.driver.run(
      "INSERT INTO generations (id, chat_id, turn_number, prompt, plan_id, result, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
      [generationId, chatId, next?.n ?? 1, prompt, planId, now()],
    );
    return generationId;
  }

  async finishGeneration(
    generationId: string,
    result: 'green' | 'red' | 'no-change' | 'error',
    gateOutputTail?: string,
  ): Promise<void> {
    await this.driver.run(
      'UPDATE generations SET result = ?, gate_output_tail = ?, finished_at = ? WHERE id = ?',
      [result, gateOutputTail ?? null, now(), generationId],
    );
    this.nextEventSeq.delete(generationId);
  }

  async appendTurnEvent(
    generationId: string,
    event: OrchestratorEvent,
  ): Promise<TurnEventRow> {
    // String concatenation is `||` in SQLite and `+` in T-SQL.
    const appendNarration =
      this.driver.dialect === 'mssql'
        ? 'UPDATE generations SET narration = narration + ? WHERE id = ?'
        : 'UPDATE generations SET narration = narration || ? WHERE id = ?';

    await this.driver.begin();
    try {
      const generation = await this.driver.get<{ chatId: string }>(
        'SELECT chat_id AS chatId FROM generations WHERE id = ?',
        [generationId],
      );
      if (!generation) {
        throw new Error(`Generation not found: ${generationId}`);
      }
      let next = this.nextEventSeq.get(generationId);
      if (next === undefined) {
        const row = await this.driver.get<{ n: number }>(
          'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM turn_events WHERE generation_id = ?',
          [generationId],
        );
        next = row?.n ?? 1;
      }
      const createdAt = now();
      await this.driver.run(
        'INSERT INTO turn_events (chat_id, generation_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          generation.chatId,
          generationId,
          next,
          event.type,
          JSON.stringify(event),
          createdAt,
        ],
      );
      this.nextEventSeq.set(generationId, next + 1);
      if (event.type === 'narration') {
        await this.driver.run(appendNarration, [event.text, generationId]);
      }
      await this.driver.commit();
      return {
        chatId: generation.chatId,
        generationId,
        seq: next,
        type: event.type,
        event,
        createdAt,
      };
    } catch (error) {
      await this.driver.rollback();
      this.nextEventSeq.delete(generationId);
      throw error;
    }
  }

  async listTurnEvents(generationId: string, sinceSeq = 0): Promise<TurnEventRow[]> {
    const rows = await this.driver.all<{
      chatId: string;
      generationId: string;
      seq: number;
      type: OrchestratorEvent['type'];
      payload: string;
      createdAt: string;
    }>(
      `SELECT chat_id AS chatId, generation_id AS generationId, seq, type,
              payload, created_at AS createdAt
       FROM turn_events
       WHERE generation_id = ? AND seq > ?
       ORDER BY seq`,
      [generationId, sinceSeq],
    );
    return rows.map(({ payload, ...row }) => ({
      ...row,
      event: JSON.parse(payload) as OrchestratorEvent,
    }));
  }

  async reconcileInterruptedGenerations(): Promise<number> {
    const result = await this.driver.run(
      "UPDATE generations SET result = 'error', finished_at = ? WHERE result = 'running' AND finished_at IS NULL",
      [now()],
    );
    return result.changes;
  }

  async insertVersion(
    chatId: string,
    generationId: string | null,
    manifestRef: string,
    message: string,
    restoredFromVersionId: string | null = null,
    diffStat: VersionDiffStat | null = null,
    files: VersionFileChange[] | null = null,
  ): Promise<VersionRow> {
    await this.driver.begin();
    try {
      const next = await this.driver.get<{ n: number }>(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM versions WHERE chat_id = ?',
        [chatId],
      );
      const seq = next?.n ?? 1;
      const id = randomUUID();
      const createdAt = now();
      await this.driver.run(
        'INSERT INTO versions (id, chat_id, generation_id, seq, manifest_ref, message, restored_from_version_id, created_at, diffstat_json, files_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          chatId,
          generationId,
          seq,
          manifestRef,
          message,
          restoredFromVersionId,
          createdAt,
          diffStat ? JSON.stringify(diffStat) : null,
          files ? JSON.stringify(files) : null,
        ],
      );
      await this.driver.commit();
      return {
        id,
        chatId,
        generationId,
        seq,
        manifestRef,
        message,
        restoredFromVersionId,
        createdAt,
        diffStat: diffStat ?? null,
        files: files ?? null,
      };
    } catch (error) {
      await this.driver.rollback();
      throw error;
    }
  }

  async listVersions(chatId: string): Promise<VersionRow[]> {
    const rows = await this.driver.all<VersionQueryRow>(
      `SELECT id, chat_id AS chatId, generation_id AS generationId,
              seq, manifest_ref AS manifestRef, message,
              restored_from_version_id AS restoredFromVersionId,
              created_at AS createdAt,
              diffstat_json AS diffstatJson, files_json AS filesJson
       FROM versions
       WHERE chat_id = ?
       ORDER BY seq`,
      [chatId],
    );
    return rows.map(toVersionRow);
  }

  async getVersion(chatId: string, versionId: string): Promise<VersionRow | null> {
    const row = await this.driver.get<VersionQueryRow>(
      `SELECT id, chat_id AS chatId, generation_id AS generationId,
              seq, manifest_ref AS manifestRef, message,
              restored_from_version_id AS restoredFromVersionId,
              created_at AS createdAt,
              diffstat_json AS diffstatJson, files_json AS filesJson
       FROM versions
       WHERE chat_id = ? AND id = ?`,
      [chatId, versionId],
    );
    return row ? toVersionRow(row) : null;
  }

  // Blueprint revisions are immutable: each POST allocates the next revision
  // number for the chat, mirroring the version numbering above.
  async insertBlueprintRevision(
    chatId: string,
    blueprint: DashboardBlueprint,
  ): Promise<BlueprintRevisionRow> {
    await this.driver.begin();
    try {
      const next = await this.driver.get<{ n: number }>(
        'SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM blueprint_revisions WHERE chat_id = ?',
        [chatId],
      );
      const revision = next?.n ?? 1;
      const id = randomUUID();
      const createdAt = now();
      await this.driver.run(
        'INSERT INTO blueprint_revisions (id, chat_id, revision, blueprint_json, approved_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
        [id, chatId, revision, JSON.stringify(blueprint), createdAt],
      );
      await this.driver.commit();
      return {
        id,
        chatId,
        revision,
        blueprint,
        approved: false,
        approvedAt: null,
        createdAt,
      };
    } catch (error) {
      await this.driver.rollback();
      throw error;
    }
  }

  // At most one approved revision per chat: clearing every other revision's
  // approval and stamping the target happen in one transaction so the
  // single-approved invariant always holds.
  async approveBlueprintRevision(
    chatId: string,
    revisionId: string,
  ): Promise<BlueprintRevisionRow | null> {
    await this.driver.begin();
    try {
      const existing = await this.driver.get<{ id: string }>(
        'SELECT id FROM blueprint_revisions WHERE chat_id = ? AND id = ?',
        [chatId, revisionId],
      );
      if (!existing) {
        await this.driver.rollback();
        return null;
      }
      await this.driver.run(
        'UPDATE blueprint_revisions SET approved_at = NULL WHERE chat_id = ? AND id <> ?',
        [chatId, revisionId],
      );
      await this.driver.run(
        'UPDATE blueprint_revisions SET approved_at = ? WHERE chat_id = ? AND id = ?',
        [now(), chatId, revisionId],
      );
      await this.driver.commit();
    } catch (error) {
      await this.driver.rollback();
      throw error;
    }
    return this.getBlueprintRevision(chatId, revisionId);
  }

  async listBlueprintRevisions(chatId: string): Promise<BlueprintRevisionRow[]> {
    const rows = await this.driver.all<BlueprintRevisionQueryRow>(
      `SELECT id, chat_id AS chatId, revision, blueprint_json AS blueprintJson,
              approved_at AS approvedAt, created_at AS createdAt
       FROM blueprint_revisions
       WHERE chat_id = ?
       ORDER BY revision`,
      [chatId],
    );
    return rows.map(toBlueprintRevisionRow);
  }

  async getBlueprintRevision(
    chatId: string,
    revisionId: string,
  ): Promise<BlueprintRevisionRow | null> {
    const row = await this.driver.get<BlueprintRevisionQueryRow>(
      `SELECT id, chat_id AS chatId, revision, blueprint_json AS blueprintJson,
              approved_at AS approvedAt, created_at AS createdAt
       FROM blueprint_revisions
       WHERE chat_id = ? AND id = ?`,
      [chatId, revisionId],
    );
    return row ? toBlueprintRevisionRow(row) : null;
  }

  async createConnection(
    chatId: string,
    name: string,
    kind: ConnectionKind,
    config: Record<string, string>,
    secret: Record<string, string>,
  ): Promise<ConnectionSummary> {
    const id = randomUUID();
    const createdAt = now();
    await this.driver.begin();
    try {
      const existing = await this.driver.get<{ id: string }>(
        'SELECT id FROM connections WHERE chat_id = ? AND name = ?',
        [chatId, name],
      );
      if (existing) {
        throw new Error(`Connection "${name}" already exists for chat ${chatId}`);
      }
      await this.driver.run(
        'INSERT INTO connections (id, chat_id, name, kind, config_json, secret_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          chatId,
          name,
          kind,
          JSON.stringify(config),
          JSON.stringify(secret),
          createdAt,
        ],
      );
      await this.driver.commit();
      return { id, chatId, name, kind, config, createdAt };
    } catch (error) {
      await this.driver.rollback();
      throw error;
    }
  }

  async listConnections(chatId: string): Promise<ConnectionSummary[]> {
    const rows = await this.driver.all<ConnectionSummaryQueryRow>(
      `SELECT id, chat_id AS chatId, name, kind,
              config_json AS configJson, created_at AS createdAt
       FROM connections
       WHERE chat_id = ?
       ORDER BY created_at, id`,
      [chatId],
    );
    return rows.map(toConnectionSummary);
  }

  async getConnection(chatId: string, name: string): Promise<ConnectionSummary | null> {
    const row = await this.driver.get<ConnectionSummaryQueryRow>(
      `SELECT id, chat_id AS chatId, name, kind,
              config_json AS configJson, created_at AS createdAt
       FROM connections
       WHERE chat_id = ? AND name = ?`,
      [chatId, name],
    );
    return row ? toConnectionSummary(row) : null;
  }

  // Internal only for connection-env.ts and connectivity-test subprocesses.
  // Never call this from an HTTP route handler that serializes its result.
  async getConnectionWithSecret(
    chatId: string,
    name: string,
  ): Promise<ConnectionRow | null> {
    const row = await this.driver.get<ConnectionQueryRow>(
      `SELECT id, chat_id AS chatId, name, kind,
              config_json AS configJson, secret_json AS secretJson,
              created_at AS createdAt
       FROM connections
       WHERE chat_id = ? AND name = ?`,
      [chatId, name],
    );
    return row ? toConnectionRow(row) : null;
  }

  // Internal only for connection-env.ts and connectivity-test subprocesses.
  // Never call this from an HTTP route handler that serializes its result.
  async listConnectionsWithSecrets(chatId: string): Promise<ConnectionRow[]> {
    const rows = await this.driver.all<ConnectionQueryRow>(
      `SELECT id, chat_id AS chatId, name, kind,
              config_json AS configJson, secret_json AS secretJson,
              created_at AS createdAt
       FROM connections
       WHERE chat_id = ?
       ORDER BY created_at, id`,
      [chatId],
    );
    return rows.map(toConnectionRow);
  }

  async deleteConnection(chatId: string, name: string): Promise<boolean> {
    const result = await this.driver.run(
      'DELETE FROM connections WHERE chat_id = ? AND name = ?',
      [chatId, name],
    );
    return result.changes > 0;
  }

  async deleteChat(chatId: string): Promise<boolean> {
    await this.driver.begin();
    try {
      await this.driver.run(
        'UPDATE versions SET restored_from_version_id = NULL WHERE chat_id = ?',
        [chatId],
      );
      await this.driver.run('DELETE FROM turn_events WHERE chat_id = ?', [chatId]);
      await this.driver.run('DELETE FROM versions WHERE chat_id = ?', [chatId]);
      await this.driver.run('DELETE FROM generations WHERE chat_id = ?', [chatId]);
      await this.driver.run('DELETE FROM plans WHERE chat_id = ?', [chatId]);
      await this.driver.run('DELETE FROM blueprint_revisions WHERE chat_id = ?', [
        chatId,
      ]);
      await this.driver.run('DELETE FROM connections WHERE chat_id = ?', [chatId]);
      const result = await this.driver.run('DELETE FROM chats WHERE id = ?', [chatId]);
      await this.driver.commit();
      return result.changes > 0;
    } catch (error) {
      await this.driver.rollback();
      throw error;
    }
  }

  async countVersions(chatId: string): Promise<number> {
    const row = await this.driver.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM versions WHERE chat_id = ?',
      [chatId],
    );
    return row?.n ?? 0;
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

interface BlueprintRevisionQueryRow {
  id: string;
  chatId: string;
  revision: number;
  blueprintJson: string;
  approvedAt: string | null;
  createdAt: string;
}

interface ConnectionSummaryQueryRow {
  id: string;
  chatId: string;
  name: string;
  kind: ConnectionKind;
  configJson: string;
  createdAt: string;
}

interface ConnectionQueryRow extends ConnectionSummaryQueryRow {
  secretJson: string;
}

function toBlueprintRevisionRow(
  row: BlueprintRevisionQueryRow,
): BlueprintRevisionRow {
  return {
    id: row.id,
    chatId: row.chatId,
    revision: row.revision,
    blueprint: JSON.parse(row.blueprintJson) as DashboardBlueprint,
    approved: row.approvedAt !== null,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
  };
}

function toConnectionSummary(
  row: ConnectionSummaryQueryRow,
): ConnectionSummary {
  const { configJson, ...summary } = row;
  return {
    ...summary,
    config: JSON.parse(configJson) as Record<string, string>,
  };
}

function toConnectionRow(row: ConnectionQueryRow): ConnectionRow {
  const { secretJson, ...summary } = row;
  return {
    ...toConnectionSummary(summary),
    secret: JSON.parse(secretJson) as Record<string, string>,
  };
}

function toVersionRow(row: VersionQueryRow): VersionRow {
  const { diffstatJson, filesJson, ...rest } = row;
  return {
    ...rest,
    diffStat: diffstatJson
      ? (JSON.parse(diffstatJson) as VersionDiffStat)
      : null,
    files: filesJson ? (JSON.parse(filesJson) as VersionFileChange[]) : null,
  };
}

function now(): string {
  return new Date().toISOString();
}
