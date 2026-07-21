import { Injectable, signal } from '@angular/core';

import { errorMessage } from '../lib/http-error';
import { readSseStream } from '../lib/sse-parser';
import { INITIAL_RECONNECT_DELAY_MS, abortableDelay, nextReconnectDelay } from '../lib/retry';
import type { ChatLevelEvent, PreviewStatus } from '../types/orchestrator-events';

@Injectable({ providedIn: 'root' })
export class PreviewService {
  readonly status = signal<PreviewStatus>({ status: 'stopped' });

  private activeChatId: string | null = null;
  private eventsAbort: AbortController | null = null;

  attach(chatId: string): void {
    if (this.activeChatId === chatId) {
      return;
    }

    this.detach();
    this.activeChatId = chatId;
    this.status.set({ status: 'stopped' });
    void this.requestPreview(chatId);
    void this.subscribeToEvents(chatId);
  }

  detach(): void {
    this.eventsAbort?.abort();
    this.eventsAbort = null;
    this.activeChatId = null;
    this.status.set({ status: 'stopped' });
  }

  async restart(): Promise<void> {
    const chatId = this.activeChatId;
    if (!chatId) {
      return;
    }
    await this.requestPreview(chatId);
  }

  private async requestPreview(chatId: string): Promise<void> {
    try {
      const response = await fetch(`/api/chats/${chatId}/preview`, { method: 'POST' });
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to start preview'));
      }
      const body = (await response.json()) as PreviewStatus;
      this.status.set(body);
    } catch (err) {
      this.status.set({
        status: 'failed',
        error: err instanceof Error ? err.message : 'Failed to start preview',
      });
    }
  }

  private async subscribeToEvents(chatId: string): Promise<void> {
    const controller = new AbortController();
    this.eventsAbort = controller;
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

    while (!controller.signal.aborted && this.activeChatId === chatId) {
      try {
        const response = await fetch(`/api/chats/${chatId}/events`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(await errorMessage(response, 'Failed to subscribe to chat events'));
        }

        for await (const frame of readSseStream(response)) {
          if (controller.signal.aborted || this.activeChatId !== chatId) {
            return;
          }
          if (frame.event !== 'preview-status') {
            continue;
          }

          let event: ChatLevelEvent;
          try {
            event = JSON.parse(frame.data) as ChatLevelEvent;
          } catch {
            continue;
          }

          if (event.type === 'preview-status') {
            reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
            this.status.set({
              status: event.status,
              url: event.url,
              error: event.error,
            });
          }
        }
      } catch (err) {
        if (controller.signal.aborted || this.activeChatId !== chatId) {
          return;
        }
        this.status.set({
          status: 'failed',
          error: err instanceof Error ? err.message : 'Preview event stream failed',
        });
      }

      if (controller.signal.aborted || this.activeChatId !== chatId) {
        return;
      }

      const shouldReconnect = await abortableDelay(reconnectDelay, controller.signal);
      if (!shouldReconnect || this.activeChatId !== chatId) {
        return;
      }

      await this.requestPreview(chatId);
      reconnectDelay = nextReconnectDelay(reconnectDelay);
    }
  }
}
