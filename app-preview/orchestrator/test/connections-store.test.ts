import { describe, expect, it } from 'vitest';
import { PlatformDb } from '../src/platform-db.js';

function memoryDb(): Promise<PlatformDb> {
  return PlatformDb.open(':memory:');
}

describe('PlatformDb connections', () => {
  it('creates and lists connections with parsed config and no secret fields', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    const config = {
      host: 'sql.internal',
      port: '1433',
      database: 'analytics',
      user: 'readonly',
    };

    const created = await db.createConnection(
      'chat-1',
      'Analytics warehouse',
      'mssql',
      config,
      { password: 'roundtrip-secret' },
    );

    expect(created).toMatchObject({
      chatId: 'chat-1',
      name: 'Analytics warehouse',
      kind: 'mssql',
      config,
      createdAt: expect.any(String),
    });
    expect(created).not.toHaveProperty('secret');
    expect(await db.listConnections('chat-1')).toEqual([created]);
    await db.close();
  });

  it('never leaks secrets through display reads', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    const secretValue = 's3cr3t-test-value';
    await db.createConnection(
      'chat-1',
      'Reporting API',
      'rest',
      {
        base_url: 'https://reports.example.test',
        auth_header: 'Authorization',
      },
      { auth_value: secretValue },
    );

    const listed = await db.listConnections('chat-1');
    const found = await db.getConnection('chat-1', 'Reporting API');

    expect(found).not.toBeNull();
    expect(listed[0]).not.toHaveProperty('secret');
    expect(found).not.toHaveProperty('secret');
    expect(JSON.stringify(listed)).not.toContain(secretValue);
    expect(JSON.stringify(found)).not.toContain(secretValue);
    await db.close();
  });

  it('returns secrets through trusted internal reads', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    const config = {
      account: 'acme-org',
      database: 'analytics',
      schema: 'public',
      warehouse: 'reporting',
      user: 'readonly',
    };
    const secret = { password: 'trusted-read-secret' };
    await db.createConnection(
      'chat-1',
      'Snowflake',
      'snowflake',
      config,
      secret,
    );

    expect(await db.getConnectionWithSecret('chat-1', 'Snowflake')).toMatchObject({
      chatId: 'chat-1',
      name: 'Snowflake',
      kind: 'snowflake',
      config,
      secret,
    });
    expect(await db.listConnectionsWithSecrets('chat-1')).toMatchObject([
      { name: 'Snowflake', config, secret },
    ]);
    expect(await db.getConnectionWithSecret('chat-1', 'missing')).toBeNull();
    await db.close();
  });

  it('enforces unique connection names per chat', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws-1');
    await db.insertChat('chat-2', '/tmp/ws-2');
    await db.createConnection(
      'chat-1',
      'Warehouse',
      'mssql',
      { host: 'primary.internal' },
      { password: 'first-secret' },
    );

    await expect(
      db.createConnection(
        'chat-1',
        'Warehouse',
        'mssql',
        { host: 'secondary.internal' },
        { password: 'second-secret' },
      ),
    ).rejects.toThrow('Connection "Warehouse" already exists for chat chat-1');
    await expect(
      db.createConnection(
        'chat-2',
        'Warehouse',
        'mssql',
        { host: 'secondary.internal' },
        { password: 'second-secret' },
      ),
    ).resolves.not.toThrow();
    expect(await db.listConnections('chat-2')).toHaveLength(1);
    await db.close();
  });

  it('deletes connections by chat and name', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    await db.createConnection(
      'chat-1',
      'Reporting API',
      'rest',
      { base_url: 'https://reports.example.test' },
      {},
    );

    expect(await db.deleteConnection('chat-1', 'Reporting API')).toBe(true);
    expect(await db.deleteConnection('chat-1', 'Reporting API')).toBe(false);
    expect(await db.getConnection('chat-1', 'Reporting API')).toBeNull();
    expect(await db.listConnections('chat-1')).toEqual([]);
    await db.close();
  });

  it('removes connections when the owning chat is deleted', async () => {
    const db = await memoryDb();
    await db.insertChat('chat-1', '/tmp/ws');
    await db.createConnection(
      'chat-1',
      'Reporting API',
      'rest',
      { base_url: 'https://reports.example.test' },
      {},
    );

    expect(await db.deleteChat('chat-1')).toBe(true);
    expect(await db.listConnections('chat-1')).toEqual([]);
    await db.close();
  });
});
