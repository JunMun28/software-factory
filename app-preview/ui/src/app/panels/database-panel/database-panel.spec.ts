import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatService } from '../../services/chat.service';
import {
  ConnectionService,
  type ConnectionSummary,
} from '../../services/connection.service';
import { DatabaseService } from '../../services/database.service';
import { DatabasePanel } from './database-panel';

describe('DatabasePanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders connected SQLite tables and preview rows', async () => {
    await TestBed.configureTestingModule({ imports: [DatabasePanel] }).compileComponents();
    const database = TestBed.inject(DatabaseService);
    database.inspection.set({
      connected: true,
      engine: 'SQLite',
      path: 'backend/app.db',
      tables: [
        {
          name: 'item',
          columns: [
            { name: 'id', type: 'INTEGER', nullable: true, primaryKey: true },
            { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
          ],
          rows: [{ id: 1, name: 'Alpha' }],
        },
      ],
    });
    database.selectedTableName.set('item');

    const fixture = TestBed.createComponent(DatabasePanel);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('SQLite');
    expect(fixture.nativeElement.textContent).toContain('item');
    expect(fixture.nativeElement.textContent).toContain('Alpha');
    expect(fixture.nativeElement.querySelector('table')).toBeTruthy();
    const selectedTable: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-table-name="item"]',
    );
    expect(selectedTable.getAttribute('aria-current')).toBe('true');
  });

  it('renders connection names and targets without a status before testing', async () => {
    const { fixture } = await createConnectionsFixture([
      connectionSummary('warehouse', 'mssql', {
        host: 'sql.example.com',
        database: 'sales',
        user: 'analyst',
      }),
      connectionSummary('snowflake-analytics', 'snowflake', {
        account: 'acme.us-east-1',
        database: 'warehouse',
        schema: 'analytics',
        user: 'loader',
      }),
      connectionSummary('partner-api', 'rest', {
        base_url: 'https://api.example.com',
      }),
    ]);

    expect(connectionRow(fixture.nativeElement, 'warehouse').textContent).toContain(
      'analyst@sql.example.com:1433/sales',
    );
    expect(
      connectionRow(fixture.nativeElement, 'snowflake-analytics').textContent,
    ).toContain('loader@acme.us-east-1/warehouse.analytics');
    expect(connectionRow(fixture.nativeElement, 'partner-api').textContent).toContain(
      'https://api.example.com',
    );
    expect(fixture.nativeElement.querySelector('[data-connection-status]')).toBeNull();
  });

  it('shows a connected status with latency after a successful test', async () => {
    const { connection, fixture } = await createConnectionsFixture([
      connectionSummary('warehouse', 'mssql', {
        host: 'sql.example.com',
        port: '1433',
        database: 'sales',
        user: 'analyst',
      }),
    ]);

    connection.testResults.set({ warehouse: { ok: true, latencyMs: 42 } });
    fixture.detectChanges();

    const badge = connectionRow(fixture.nativeElement, 'warehouse').querySelector(
      '[data-connection-status]',
    ) as HTMLElement;
    expect(badge.textContent).toContain('Connected');
    expect(badge.textContent).toContain('42ms');
  });

  it('shows a failed status with the full error in its title', async () => {
    const { connection, fixture } = await createConnectionsFixture([
      connectionSummary('partner-api', 'rest', {
        base_url: 'https://api.example.com',
      }),
    ]);

    connection.testResults.set({
      'partner-api': { ok: false, latencyMs: 18, error: 'Authentication failed' },
    });
    fixture.detectChanges();

    const badge = connectionRow(fixture.nativeElement, 'partner-api').querySelector(
      '[data-connection-status]',
    ) as HTMLElement;
    expect(badge.textContent).toContain('Failed');
    expect(badge.textContent).toContain('Authentication failed');
    expect(badge.getAttribute('title')).toBe('Authentication failed');
  });

  it('confirms deletion and removes the connection row', async () => {
    const { connection, fixture } = await createConnectionsFixture([
      connectionSummary('warehouse', 'mssql', {
        host: 'sql.example.com',
        database: 'sales',
        user: 'analyst',
      }),
    ]);
    const removeSpy = vi
      .spyOn(connection, 'remove')
      .mockImplementation(async (_chatId, name) => {
        connection.connections.update((items) =>
          items.filter((item) => item.name !== name),
        );
        return { ok: true };
      });

    deleteButton(fixture.nativeElement, 'warehouse').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeTruthy();
    expect(removeSpy).not.toHaveBeenCalled();

    fixture.nativeElement.querySelector('[data-confirm-dialog-confirm]').click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(removeSpy).toHaveBeenCalledWith('chat-1', 'warehouse');
      expect(connectionRow(fixture.nativeElement, 'warehouse')).toBeNull();
    });
  });

  it('dismisses delete confirmation without removing the connection', async () => {
    const { connection, fixture } = await createConnectionsFixture([
      connectionSummary('warehouse', 'mssql', {
        host: 'sql.example.com',
        database: 'sales',
        user: 'analyst',
      }),
    ]);
    const removeSpy = vi.spyOn(connection, 'remove');

    deleteButton(fixture.nativeElement, 'warehouse').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-confirm-dialog-cancel]').click();
    fixture.detectChanges();

    expect(removeSpy).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
    expect(connectionRow(fixture.nativeElement, 'warehouse')).toBeTruthy();
  });

  it('keeps the confirmation open and shows an error when deletion fails', async () => {
    const { connection, fixture } = await createConnectionsFixture([
      connectionSummary('warehouse', 'mssql', {
        host: 'sql.example.com',
        database: 'sales',
        user: 'analyst',
      }),
    ]);
    vi.spyOn(connection, 'remove').mockResolvedValue({
      ok: false,
      error: 'Connection could not be deleted',
    });

    deleteButton(fixture.nativeElement, 'warehouse').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-confirm-dialog-confirm]').click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      const dialog: HTMLElement = fixture.nativeElement.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog.textContent).toContain('Connection could not be deleted');
      expect(connectionRow(fixture.nativeElement, 'warehouse')).toBeTruthy();
    });
  });
});

async function createConnectionsFixture(connections: ConnectionSummary[]) {
  await TestBed.configureTestingModule({ imports: [DatabasePanel] }).compileComponents();
  const chatService = TestBed.inject(ChatService);
  const connection = TestBed.inject(ConnectionService);
  const database = TestBed.inject(DatabaseService);
  vi.spyOn(connection, 'load').mockResolvedValue();
  vi.spyOn(database, 'load').mockResolvedValue();
  connection.connections.set(connections);
  database.inspection.set({
    connected: false,
    engine: 'SQLite',
    path: 'backend/app.db',
    tables: [],
  });
  chatService.activeChatId.set('chat-1');

  const fixture = TestBed.createComponent(DatabasePanel);
  fixture.detectChanges();
  return { connection, fixture };
}

function connectionSummary(
  name: string,
  kind: ConnectionSummary['kind'],
  config: Record<string, string>,
): ConnectionSummary {
  return {
    id: `connection-${name}`,
    chatId: 'chat-1',
    name,
    kind,
    config,
    createdAt: '2026-07-18T08:00:00.000Z',
  };
}

function connectionRow(root: HTMLElement, name: string): HTMLElement {
  return root.querySelector(`[data-connection-name="${name}"]`) as HTMLElement;
}

function deleteButton(root: HTMLElement, name: string): HTMLButtonElement {
  return connectionRow(root, name).querySelector(
    '[data-delete-connection]',
  ) as HTMLButtonElement;
}
