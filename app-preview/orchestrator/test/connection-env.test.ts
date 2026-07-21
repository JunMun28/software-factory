import { describe, expect, it } from 'vitest';
import {
  connectionEnv,
  sanitizeConnectionName,
} from '../src/connection-env.js';
import type { ConnectionKind, ConnectionRow } from '../src/platform-db.js';
import { workspaceEnv } from '../src/workspace-env.js';

function connection(
  name: string,
  kind: ConnectionKind,
  config: Record<string, string>,
  secret: Record<string, string> = {},
): ConnectionRow {
  return {
    id: `connection-${name}`,
    chatId: 'chat-1',
    name,
    kind,
    config,
    secret,
    createdAt: '2026-07-18T00:00:00.000Z',
  };
}

function store(rows: ConnectionRow[]): {
  listConnectionsWithSecrets(chatId: string): Promise<ConnectionRow[]>;
} {
  return {
    listConnectionsWithSecrets: async () => rows,
  };
}

describe('sanitizeConnectionName', () => {
  it('uppercases a valid stored name', () => {
    expect(sanitizeConnectionName('reporting_api')).toBe('REPORTING_API');
  });

  it('rejects names containing characters outside the env-safe set', () => {
    expect(() => sanitizeConnectionName('my-api')).toThrow(
      'Connection name "my-api" contains invalid characters; use only letters, numbers, and underscores',
    );
  });

  it('rejects names that start with a digit', () => {
    expect(() => sanitizeConnectionName('1warehouse')).toThrow(
      'Connection name "1warehouse" must not start with a digit',
    );
  });

  it('rejects an empty name', () => {
    expect(() => sanitizeConnectionName('')).toThrow(
      'Connection name must not be empty',
    );
  });
});

describe('connectionEnv', () => {
  it('composes an MSSQL SQLAlchemy URL and encodes credentials', async () => {
    const password = 'p@ss:w/rd';
    const env = await connectionEnv(
      store([
        connection(
          'primary_db',
          'mssql',
          {
            host: 'sql.internal',
            port: '1444',
            database: 'analytics',
            user: 'read@only',
          },
          { password },
        ),
      ]),
      'chat-1',
    );

    expect(env).toEqual({
      DATASOURCE_PRIMARY_DB_KIND: 'mssql',
      DATASOURCE_PRIMARY_DB_URL:
        'mssql+pymssql://read%40only:p%40ss%3Aw%2Frd@sql.internal:1444/analytics',
      DATASOURCE_NAMES: 'PRIMARY_DB',
    });
    expect(env.DATASOURCE_PRIMARY_DB_URL).not.toContain(password);
  });

  it('defaults the MSSQL port to 1433 when it is absent', async () => {
    const env = await connectionEnv(
      store([
        connection(
          'warehouse',
          'mssql',
          {
            host: 'sql.internal',
            database: 'analytics',
            user: 'readonly',
          },
          { password: 'secret' },
        ),
      ]),
      'chat-1',
    );

    expect(env.DATASOURCE_WAREHOUSE_URL).toBe(
      'mssql+pymssql://readonly:secret@sql.internal:1433/analytics',
    );
  });

  it('composes a Snowflake URL with schema and warehouse', async () => {
    const env = await connectionEnv(
      store([
        connection(
          'snowflake',
          'snowflake',
          {
            account: 'acme-org',
            database: 'analytics',
            schema: 'public',
            warehouse: 'reporting_wh',
            user: 'read@only',
          },
          { password: 'p@ss:w/rd' },
        ),
      ]),
      'chat-1',
    );

    expect(env.DATASOURCE_SNOWFLAKE_URL).toBe(
      'snowflake://read%40only:p%40ss%3Aw%2Frd@acme-org/analytics/public?warehouse=reporting_wh',
    );
  });

  it('encodes non-credential URL components (host, database, warehouse)', async () => {
    const env = await connectionEnv(
      store([
        connection(
          'quirky_db',
          'mssql',
          {
            host: 'sql host.internal',
            database: 'sales&marketing',
            user: 'readonly',
          },
          { password: 'secret' },
        ),
        connection(
          'quirky_wh',
          'snowflake',
          {
            account: 'acme-org',
            database: 'analytics db',
            warehouse: 'wh&primary',
            user: 'readonly',
          },
          { password: 'secret' },
        ),
      ]),
      'chat-1',
    );

    expect(env.DATASOURCE_QUIRKY_DB_URL).toBe(
      'mssql+pymssql://readonly:secret@sql%20host.internal:1433/sales%26marketing',
    );
    expect(env.DATASOURCE_QUIRKY_WH_URL).toBe(
      'snowflake://readonly:secret@acme-org/analytics%20db?warehouse=wh%26primary',
    );
    expect(env.DATASOURCE_QUIRKY_DB_URL).not.toContain('sales&marketing');
    expect(env.DATASOURCE_QUIRKY_WH_URL).not.toContain('wh&primary');
  });

  it('omits Snowflake schema and warehouse segments when not configured', async () => {
    const env = await connectionEnv(
      store([
        connection(
          'snowflake',
          'snowflake',
          {
            account: 'acme-org',
            database: 'analytics',
            user: 'readonly',
          },
          { password: 'secret' },
        ),
      ]),
      'chat-1',
    );

    expect(env.DATASOURCE_SNOWFLAKE_URL).toBe(
      'snowflake://readonly:secret@acme-org/analytics',
    );
  });

  it('composes REST base URL and auth variables when configured', async () => {
    const env = await connectionEnv(
      store([
        connection(
          'reporting_api',
          'rest',
          {
            base_url: 'https://reports.example.test',
            auth_header: 'Authorization',
          },
          { auth_value: 'Bearer secret-token' },
        ),
      ]),
      'chat-1',
    );

    expect(env).toEqual({
      DATASOURCE_REPORTING_API_KIND: 'rest',
      DATASOURCE_REPORTING_API_BASE_URL: 'https://reports.example.test',
      DATASOURCE_REPORTING_API_AUTH_HEADER: 'Authorization',
      DATASOURCE_REPORTING_API_AUTH_VALUE: 'Bearer secret-token',
      DATASOURCE_NAMES: 'REPORTING_API',
    });
  });

  it('omits REST auth variables when they are not configured', async () => {
    const env = await connectionEnv(
      store([
        connection('public_api', 'rest', {
          base_url: 'https://public.example.test',
        }),
      ]),
      'chat-1',
    );

    expect(env).toEqual({
      DATASOURCE_PUBLIC_API_KIND: 'rest',
      DATASOURCE_PUBLIC_API_BASE_URL: 'https://public.example.test',
      DATASOURCE_NAMES: 'PUBLIC_API',
    });
    expect(env).not.toHaveProperty('DATASOURCE_PUBLIC_API_AUTH_HEADER');
    expect(env).not.toHaveProperty('DATASOURCE_PUBLIC_API_AUTH_VALUE');
  });

  it('lists multiple sanitized connection names in store order', async () => {
    const env = await connectionEnv(
      store([
        connection('primary_db', 'rest', { base_url: 'https://one.test' }),
        connection('reportingApi', 'rest', { base_url: 'https://two.test' }),
        connection('snow_2', 'rest', { base_url: 'https://three.test' }),
      ]),
      'chat-1',
    );

    expect(env.DATASOURCE_NAMES).toBe('PRIMARY_DB,REPORTINGAPI,SNOW_2');
  });

  it('returns an empty object when the chat has no connections', async () => {
    expect(await connectionEnv(store([]), 'chat-1')).toEqual({});
  });

  it('skips a stored connection whose name cannot be sanitized', async () => {
    const env = await connectionEnv(
      store([
        connection('my-api', 'rest', { base_url: 'https://bad.test' }),
        connection('valid_api', 'rest', { base_url: 'https://valid.test' }),
      ]),
      'chat-1',
    );

    expect(env.DATASOURCE_NAMES).toBe('VALID_API');
    expect(env).toHaveProperty(
      'DATASOURCE_VALID_API_BASE_URL',
      'https://valid.test',
    );
    expect(Object.keys(env).some((key) => key.includes('MY-API'))).toBe(false);
  });
});

describe('workspaceEnv connection isolation', () => {
  it('strips ambient DATASOURCE variables from the workspace and gate env', () => {
    const env = workspaceEnv({
      PATH: '/usr/bin',
      NODE_ENV: 'test',
      DATASOURCE_FOO_URL: 'mssql+pymssql://user:password@host/db',
      DATASOURCE_NAMES: 'FOO',
    });

    expect(env).toMatchObject({ PATH: '/usr/bin', NODE_ENV: 'test' });
    expect(env).not.toHaveProperty('DATASOURCE_FOO_URL');
    expect(env).not.toHaveProperty('DATASOURCE_NAMES');
    expect(
      Object.keys(env).every((key) => !key.startsWith('DATASOURCE_')),
    ).toBe(true);
  });
});
