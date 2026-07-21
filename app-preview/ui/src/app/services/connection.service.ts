import { Injectable, signal } from '@angular/core';

import { errorMessage } from '../lib/http-error';

export interface ConnectionSummary {
  id: string;
  chatId: string;
  name: string;
  kind: 'mssql' | 'snowflake' | 'rest';
  config: Record<string, string>;
  createdAt: string;
}

export interface ConnectionFieldError {
  path: string;
  message: string;
}

export type ConnectionTestResult = {
  ok: boolean;
  latencyMs: number;
  error?: string;
};

type CreateConnectionResult =
  | { ok: true; connection: ConnectionSummary }
  | { ok: false; errors: ConnectionFieldError[] };

@Injectable({ providedIn: 'root' })
export class ConnectionService {
  readonly connections = signal<ConnectionSummary[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly testResults = signal<Record<string, ConnectionTestResult>>({});
  readonly testingName = signal<string | null>(null);
  readonly deletingName = signal<string | null>(null);

  private requestId = 0;
  private activeChatId: string | null = null;
  private chatGeneration = 0;

  async load(chatId: string): Promise<void> {
    if (chatId !== this.activeChatId) {
      this.activeChatId = chatId;
      this.chatGeneration += 1;
      this.connections.set([]);
      this.testResults.set({});
      this.testingName.set(null);
      this.deletingName.set(null);
    }

    const requestId = ++this.requestId;
    this.loading.set(true);
    this.error.set(null);

    try {
      const response = await fetch(`/api/chats/${chatId}/connections`);
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to load connections'));
      }
      const body = (await response.json()) as { connections: ConnectionSummary[] };
      if (requestId !== this.requestId) {
        return;
      }
      this.connections.set(body.connections);
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.connections.set([]);
      this.error.set(
        error instanceof Error ? error.message : 'Failed to load connections',
      );
    } finally {
      if (requestId === this.requestId) {
        this.loading.set(false);
      }
    }
  }

  async create(
    chatId: string,
    payload: Record<string, unknown>,
  ): Promise<CreateConnectionResult> {
    const chatGeneration = this.chatGeneration;

    try {
      const response = await fetch(`/api/chats/${chatId}/connections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.status === 422) {
        const body = (await response.json()) as { errors: ConnectionFieldError[] };
        return { ok: false, errors: body.errors };
      }
      if (!response.ok) {
        return {
          ok: false,
          errors: [
            {
              path: '',
              message: await errorMessage(response, 'Failed to create connection'),
            },
          ],
        };
      }

      const connection = (await response.json()) as ConnectionSummary;
      if (this.isCurrentChat(chatId, chatGeneration)) {
        this.connections.update((connections) => [...connections, connection]);
      }
      return { ok: true, connection };
    } catch (error) {
      return {
        ok: false,
        errors: [
          {
            path: '',
            message:
              error instanceof Error ? error.message : 'Failed to create connection',
          },
        ],
      };
    }
  }

  async remove(
    chatId: string,
    name: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const chatGeneration = this.chatGeneration;
    this.deletingName.set(name);

    try {
      const response = await fetch(
        `/api/chats/${chatId}/connections/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        return {
          ok: false,
          error: await errorMessage(response, 'Failed to delete connection'),
        };
      }

      if (this.isCurrentChat(chatId, chatGeneration)) {
        this.connections.update((connections) =>
          connections.filter((connection) => connection.name !== name),
        );
        this.testResults.update((results) => {
          const next = { ...results };
          delete next[name];
          return next;
        });
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : 'Failed to delete connection',
      };
    } finally {
      if (
        this.isCurrentChat(chatId, chatGeneration) &&
        this.deletingName() === name
      ) {
        this.deletingName.set(null);
      }
    }
  }

  async test(chatId: string, name: string): Promise<void> {
    const chatGeneration = this.chatGeneration;
    this.testingName.set(name);

    try {
      const response = await fetch(
        `/api/chats/${chatId}/connections/${encodeURIComponent(name)}/test`,
        { method: 'POST' },
      );
      const result: ConnectionTestResult = response.ok
        ? ((await response.json()) as ConnectionTestResult)
        : {
            ok: false,
            latencyMs: 0,
            error: await errorMessage(response, 'Failed to test connection'),
          };
      if (this.isCurrentChat(chatId, chatGeneration)) {
        this.testResults.update((results) => ({ ...results, [name]: result }));
      }
    } catch (error) {
      const result: ConnectionTestResult = {
        ok: false,
        latencyMs: 0,
        error: error instanceof Error ? error.message : 'Failed to test connection',
      };
      if (this.isCurrentChat(chatId, chatGeneration)) {
        this.testResults.update((results) => ({ ...results, [name]: result }));
      }
    } finally {
      if (
        this.isCurrentChat(chatId, chatGeneration) &&
        this.testingName() === name
      ) {
        this.testingName.set(null);
      }
    }
  }

  private isCurrentChat(chatId: string, chatGeneration: number): boolean {
    return (
      chatGeneration === this.chatGeneration &&
      (this.activeChatId === null || this.activeChatId === chatId)
    );
  }
}
