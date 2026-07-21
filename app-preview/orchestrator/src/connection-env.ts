import type { ConnectionRow } from './platform-db.js';

export interface ConnectionStore {
  listConnectionsWithSecrets(chatId: string): Promise<ConnectionRow[]>;
}

export function sanitizeConnectionName(name: string): string {
  if (name.length === 0) {
    throw new Error('Connection name must not be empty');
  }
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(
      `Connection name "${name}" contains invalid characters; use only letters, numbers, and underscores`,
    );
  }
  if (/^[0-9]/.test(name)) {
    throw new Error(`Connection name "${name}" must not start with a digit`);
  }
  return name.toUpperCase();
}

export async function connectionEnv(
  store: ConnectionStore,
  chatId: string,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const names: string[] = [];

  for (const row of await store.listConnectionsWithSecrets(chatId)) {
    const connection = composeConnectionEnv(row);
    if (!connection) {
      continue;
    }

    Object.assign(env, connection.env);
    names.push(connection.name);
  }

  if (names.length > 0) {
    env.DATASOURCE_NAMES = names.join(',');
  }

  return env;
}

export async function singleConnectionEnv(
  store: ConnectionStore,
  chatId: string,
  name: string,
): Promise<Record<string, string> | null> {
  const rows = await store.listConnectionsWithSecrets(chatId);
  const exactMatch = rows.find((row) => row.name === name);
  const sanitizedName = trySanitizeConnectionName(name);
  const row =
    exactMatch ??
    (sanitizedName === null
      ? undefined
      : rows.find(
          (candidate) =>
            trySanitizeConnectionName(candidate.name) === sanitizedName,
        ));
  if (!row) {
    return null;
  }

  const connection = composeConnectionEnv(row);
  if (!connection) {
    return null;
  }
  return {
    ...connection.env,
    DATASOURCE_NAMES: connection.name,
  };
}

function composeConnectionEnv(
  row: ConnectionRow,
): { name: string; env: Record<string, string> } | null {
  const name = trySanitizeConnectionName(row.name);
  if (name === null) {
    return null;
  }

  const env: Record<string, string> = {};
  const prefix = `DATASOURCE_${name}`;
  env[`${prefix}_KIND`] = row.kind;

  if (row.kind === 'rest') {
    env[`${prefix}_BASE_URL`] = row.config.base_url;
    if (row.config.auth_header !== undefined) {
      env[`${prefix}_AUTH_HEADER`] = row.config.auth_header;
    }
    if (row.secret.auth_value !== undefined) {
      env[`${prefix}_AUTH_VALUE`] = row.secret.auth_value;
    }
  } else {
    env[`${prefix}_URL`] = buildConnectionUrl(row);
  }

  return { name, env };
}

function trySanitizeConnectionName(name: string): string | null {
  try {
    return sanitizeConnectionName(name);
  } catch {
    return null;
  }
}

function buildConnectionUrl(row: ConnectionRow): string {
  const user = encodeURIComponent(row.config.user);
  const password = encodeURIComponent(row.secret.password);

  if (row.kind === 'mssql') {
    const port = row.config.port ?? '1433';
    const host = encodeURIComponent(row.config.host);
    const database = encodeURIComponent(row.config.database);
    return `mssql+pymssql://${user}:${password}@${host}:${port}/${database}`;
  }

  if (row.kind === 'snowflake') {
    const account = encodeURIComponent(row.config.account);
    const database = encodeURIComponent(row.config.database);
    const schemaPath = row.config.schema
      ? `/${encodeURIComponent(row.config.schema)}`
      : '';
    const warehouseQuery = row.config.warehouse
      ? `?warehouse=${encodeURIComponent(row.config.warehouse)}`
      : '';
    return `snowflake://${user}:${password}@${account}/${database}${schemaPath}${warehouseQuery}`;
  }

  throw new Error(`Cannot build a SQLAlchemy URL for connection kind ${row.kind}`);
}
