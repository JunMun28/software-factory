import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleAlert,
  lucideDatabase,
  lucideGlobe2,
  lucideKeyRound,
  lucideLoaderCircle,
  lucidePlus,
  lucideRefreshCw,
  lucideServer,
  lucideSnowflake,
  lucideTable2,
  lucideTrash2,
} from '@ng-icons/lucide';

import { ConfirmDialog } from '../../chats/confirm-dialog/confirm-dialog';
import { ChatService } from '../../services/chat.service';
import {
  ConnectionService,
  type ConnectionSummary,
} from '../../services/connection.service';
import { DatabaseService } from '../../services/database.service';
import { AddConnectionDialog } from './add-connection-dialog';

@Component({
  selector: 'app-database-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AddConnectionDialog, ConfirmDialog, NgIcon],
  providers: [
    provideIcons({
      lucideCircleAlert,
      lucideDatabase,
      lucideGlobe2,
      lucideKeyRound,
      lucideLoaderCircle,
      lucidePlus,
      lucideRefreshCw,
      lucideServer,
      lucideSnowflake,
      lucideTable2,
      lucideTrash2,
    }),
  ],
  template: `
    <div class="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <section class="shrink-0 border-b border-border bg-card/30 px-4 py-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-sm font-semibold">Connections</h2>
            <p class="mt-0.5 text-xs text-muted-foreground">
              Connect external data sources to this chat.
            </p>
          </div>
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-40"
            [disabled]="!chatService.activeChatId()"
            (click)="showAddDialog.set(true)"
          >
            <ng-icon name="lucidePlus" size="14" />
            Add connection
          </button>
        </div>

        @if (connection.loading() && connection.connections().length === 0) {
          <div class="mt-3 flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <ng-icon class="animate-spin" name="lucideLoaderCircle" size="14" />
            Loading connections…
          </div>
        }

        @if (connection.error(); as error) {
          <div
            class="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            <span class="inline-flex min-w-0 items-center gap-2">
              <ng-icon class="shrink-0" name="lucideCircleAlert" size="14" />
              <span>{{ error }}</span>
            </span>
            <button
              type="button"
              class="rounded border border-destructive/30 px-2 py-1 font-medium hover:bg-destructive/10"
              (click)="reloadConnections()"
            >
              Try again
            </button>
          </div>
        }

        @if (connection.connections().length > 0) {
          <div class="mt-3 space-y-2">
            @for (item of connection.connections(); track item.id) {
              <div
                class="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5"
                [attr.data-connection-name]="item.name"
              >
                <div class="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
                  <ng-icon [name]="connectionIcon(item.kind)" size="15" />
                </div>
                <div class="min-w-32 flex-1">
                  <p class="truncate text-xs font-medium">{{ item.name }}</p>
                  <p class="truncate text-[11px] text-muted-foreground" [title]="connectionTarget(item)">
                    {{ connectionTarget(item) }}
                  </p>
                </div>

                <div class="flex min-w-0 items-center gap-2">
                  @if (connection.testResults()[item.name]; as result) {
                    @if (result.ok) {
                      <span
                        data-connection-status
                        class="inline-flex max-w-56 truncate rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                      >
                        Connected · {{ result.latencyMs }}ms
                      </span>
                    } @else {
                      <span
                        data-connection-status
                        class="inline-flex max-w-56 truncate rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive"
                        [title]="result.error || 'Connection test failed'"
                      >
                        Failed · {{ result.error || 'Connection test failed' }}
                      </span>
                    }
                  }
                  <button
                    data-test-connection
                    type="button"
                    class="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11px] font-medium hover:bg-muted disabled:opacity-40"
                    [disabled]="connection.testingName() === item.name"
                    (click)="testConnection(item.name)"
                  >
                    @if (connection.testingName() === item.name) {
                      <ng-icon class="animate-spin" name="lucideLoaderCircle" size="12" />
                    }
                    Test
                  </button>
                  <button
                    data-delete-connection
                    type="button"
                    class="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11px] font-medium text-destructive hover:bg-destructive/10"
                    [attr.aria-label]="'Delete connection ' + item.name"
                    (click)="requestDelete(item.name)"
                  >
                    <ng-icon name="lucideTrash2" size="12" />
                    Delete
                  </button>
                </div>
              </div>
            }
          </div>
        } @else if (!connection.loading() && !connection.error()) {
          <p class="mt-3 text-xs text-muted-foreground">No connections yet.</p>
        }

        <p class="mt-3 text-[11px] text-muted-foreground">
          Generated code can read these credentials while previewing. Use read-only accounts.
        </p>
      </section>

      <div class="min-h-0 flex-1">
        @if (database.loading()) {
        <div class="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <ng-icon class="animate-spin" name="lucideLoaderCircle" size="22" />
          Inspecting database…
        </div>
      } @else if (database.error(); as error) {
        <div class="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
          <ng-icon class="text-destructive" name="lucideCircleAlert" size="26" />
          <p class="text-sm text-destructive">{{ error }}</p>
          <button type="button" class="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted" (click)="reload()">
            Try again
          </button>
        </div>
      } @else if (!database.inspection()?.connected) {
        <div class="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
          <div class="flex size-10 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
            <ng-icon name="lucideDatabase" size="20" />
          </div>
          <div>
            <h2 class="text-base font-medium">No Database Connected</h2>
            <p class="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
              This workspace does not contain backend/app.db yet. Ask the agent to add SQLite persistence and it will appear here.
            </p>
          </div>
          <button type="button" class="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted" (click)="reload()">
            Check again
          </button>
        </div>
      } @else {
        <div class="grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)] max-md:grid-cols-1">
          <aside class="min-h-0 overflow-y-auto border-r border-border bg-card max-md:hidden">
            <div class="border-b border-border px-3 py-3">
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <p class="text-xs font-medium">{{ database.inspection()!.engine }}</p>
                  <p class="truncate font-mono text-[10px] text-muted-foreground">{{ database.inspection()!.path }}</p>
                </div>
                <button type="button" class="workspace-icon-button" aria-label="Refresh database" (click)="reload()">
                  <ng-icon name="lucideRefreshCw" size="13" />
                </button>
              </div>
            </div>
            <div class="p-2">
              <p class="mb-1 px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Tables</p>
              @for (table of database.inspection()!.tables; track table.name) {
                <button
                  type="button"
                  [attr.data-table-name]="table.name"
                  [attr.aria-current]="database.selectedTableName() === table.name ? 'true' : null"
                  class="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  [class.bg-muted]="database.selectedTableName() === table.name"
                  [class.text-foreground]="database.selectedTableName() === table.name"
                  (click)="database.selectTable(table.name)"
                >
                  <ng-icon name="lucideTable2" size="13" />
                  <span class="min-w-0 flex-1 truncate">{{ table.name }}</span>
                  <span class="text-[10px]">{{ table.rows.length }}</span>
                </button>
              }
            </div>
          </aside>

          <main class="min-h-0 overflow-auto p-4">
            @if (database.selectedTable(); as table) {
              <div class="mb-4 flex items-end justify-between gap-4">
                <div>
                  <h2 class="text-lg font-semibold">{{ table.name }}</h2>
                  <p class="text-xs text-muted-foreground">{{ table.rows.length }} preview row{{ table.rows.length === 1 ? '' : 's' }} · read only</p>
                </div>
              </div>

              <div class="overflow-x-auto rounded-md border border-border">
                <table class="w-full border-collapse text-left text-xs">
                  <thead class="bg-card text-muted-foreground">
                    <tr>
                      @for (column of table.columns; track column.name) {
                        <th class="border-b border-border px-3 py-2 font-medium">
                          <span class="inline-flex items-center gap-1.5">
                            @if (column.primaryKey) {
                              <ng-icon name="lucideKeyRound" size="11" />
                            }
                            {{ column.name }}
                            <span class="font-mono text-[9px]">{{ column.type }}</span>
                          </span>
                        </th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of table.rows; track $index) {
                      <tr class="border-b border-border/60 last:border-b-0 hover:bg-muted/20">
                        @for (column of table.columns; track column.name) {
                          <td class="max-w-72 truncate px-3 py-2 font-mono">{{ displayValue(row[column.name]) }}</td>
                        }
                      </tr>
                    } @empty {
                      <tr>
                        <td class="px-3 py-10 text-center text-muted-foreground" [attr.colspan]="table.columns.length || 1">No rows</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </main>
        </div>
        }
      </div>
    </div>

    @if (showAddDialog() && chatService.activeChatId(); as chatId) {
      <app-add-connection-dialog
        [chatId]="chatId"
        (created)="onConnectionCreated($event)"
        (closed)="showAddDialog.set(false)"
      />
    }

    @if (pendingDeleteName(); as name) {
      <app-confirm-dialog
        [title]="deleteDialogTitle()"
        [description]="deleteDialogDescription(name)"
        confirmLabel="Delete"
        [destructive]="true"
        [busy]="connection.deletingName() === name"
        (confirmed)="confirmDelete()"
        (dismissed)="dismissDelete()"
      />
    }
  `,
})
export class DatabasePanel {
  readonly chatService = inject(ChatService);
  readonly connection = inject(ConnectionService);
  readonly database = inject(DatabaseService);
  readonly showAddDialog = signal(false);
  readonly pendingDeleteName = signal<string | null>(null);
  readonly deleteError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const chatId = this.chatService.activeChatId();
      if (chatId) {
        void this.connection.load(chatId);
        void this.database.load(chatId);
      }
    });
  }

  reloadConnections(): void {
    const chatId = this.chatService.activeChatId();
    if (chatId) {
      void this.connection.load(chatId);
    }
  }

  testConnection(name: string): void {
    const chatId = this.chatService.activeChatId();
    if (chatId) {
      void this.connection.test(chatId, name);
    }
  }

  requestDelete(name: string): void {
    this.deleteError.set(null);
    this.pendingDeleteName.set(name);
  }

  dismissDelete(): void {
    if (this.connection.deletingName()) {
      return;
    }
    this.deleteError.set(null);
    this.pendingDeleteName.set(null);
  }

  async confirmDelete(): Promise<void> {
    const chatId = this.chatService.activeChatId();
    const name = this.pendingDeleteName();
    if (!chatId || !name) {
      this.dismissDelete();
      return;
    }
    if (this.connection.deletingName()) {
      return;
    }

    this.deleteError.set(null);
    const result = await this.connection.remove(chatId, name);
    if (result.ok) {
      this.dismissDelete();
      return;
    }
    this.deleteError.set(result.error ?? 'Failed to delete connection');
  }

  onConnectionCreated(_connection: ConnectionSummary): void {
    this.showAddDialog.set(false);
  }

  connectionIcon(kind: ConnectionSummary['kind']): string {
    if (kind === 'mssql') {
      return 'lucideServer';
    }
    if (kind === 'rest') {
      return 'lucideGlobe2';
    }
    return 'lucideSnowflake';
  }

  connectionTarget(connection: ConnectionSummary): string {
    const config = connection.config;
    if (connection.kind === 'mssql') {
      return `${config['user']}@${config['host']}:${config['port'] ?? '1433'}/${config['database']}`;
    }
    if (connection.kind === 'snowflake') {
      const schema = config['schema'] ? `.${config['schema']}` : '';
      return `${config['user']}@${config['account']}/${config['database']}${schema}`;
    }
    return config['base_url'] ?? '';
  }

  deleteDialogTitle(): string {
    return this.deleteError() ? 'Could not delete connection' : 'Delete connection?';
  }

  deleteDialogDescription(name: string): string {
    return (
      this.deleteError() ??
      `Delete ${name} and remove its saved credentials from this chat?`
    );
  }

  reload(): void {
    const chatId = this.chatService.activeChatId();
    if (chatId) {
      void this.database.load(chatId);
    }
  }

  displayValue(value: unknown): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}
