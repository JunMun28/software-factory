import { Injectable, computed, signal } from '@angular/core';

export interface DatabaseColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface DatabaseTable {
  name: string;
  columns: DatabaseColumn[];
  rows: Record<string, unknown>[];
}

export interface DatabaseInspection {
  connected: boolean;
  engine: 'SQLite';
  path: string;
  tables: DatabaseTable[];
}

@Injectable({ providedIn: 'root' })
export class DatabaseService {
  readonly inspection = signal<DatabaseInspection | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly selectedTableName = signal<string | null>(null);

  readonly selectedTable = computed(() => {
    const inspection = this.inspection();
    const selected = this.selectedTableName();
    return inspection?.tables.find((table) => table.name === selected) ?? null;
  });

  private requestId = 0;

  async load(chatId: string): Promise<void> {
    const requestId = ++this.requestId;
    this.loading.set(true);
    this.error.set(null);

    try {
      const response = await fetch(`/api/chats/${chatId}/database`);
      if (!response.ok) {
        throw new Error(`Failed to inspect database (${response.status})`);
      }
      const inspection = (await response.json()) as DatabaseInspection;
      if (requestId !== this.requestId) {
        return;
      }
      this.inspection.set(inspection);
      const current = this.selectedTableName();
      if (!current || !inspection.tables.some((table) => table.name === current)) {
        this.selectedTableName.set(inspection.tables[0]?.name ?? null);
      }
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.inspection.set(null);
      this.selectedTableName.set(null);
      this.error.set(
        error instanceof Error ? error.message : 'Failed to inspect database',
      );
    } finally {
      if (requestId === this.requestId) {
        this.loading.set(false);
      }
    }
  }

  selectTable(name: string): void {
    this.selectedTableName.set(name);
  }
}
