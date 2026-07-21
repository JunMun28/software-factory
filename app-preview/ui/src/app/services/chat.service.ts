import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { errorMessage } from '../lib/http-error';
import { readSseStream } from '../lib/sse-parser';
import { TurnReplayController } from '../lib/turn-replay';
import {
  applyOrchestratorEvent,
  createTurn,
  historyEntryToTurn,
  type TurnState,
} from '../models/turn';
import type {
  ChatDetail,
  ChatSummary,
  ChatVersion,
  CreateChatResponse,
  OrchestratorEvent,
  TurnHistoryEntry,
  VersionDiffFile,
} from '../types/orchestrator-events';
import { ModelService } from './model.service';

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly router = inject(Router);
  private readonly modelService = inject(ModelService);
  private readonly destroyRef = inject(DestroyRef);

  readonly chats = signal<ChatSummary[]>([]);
  readonly activeChatId = signal<string | null>(null);
  readonly loadingChats = signal(false);
  readonly creatingChat = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly previewReloadTick = signal(0);
  readonly fileChangedTick = signal(0);
  readonly turnFinishedTick = signal(0);
  readonly turnStartedTick = signal(0);
  readonly streamActivityTick = signal(0);
  readonly currentTurnTouchedFiles = signal<Record<string, 'created' | 'modified' | 'deleted'>>({});

  private readonly turnsByChat = signal<Record<string, TurnState[]>>({});
  private readonly versionsByChat = signal<Record<string, ChatVersion[]>>({});
  private readonly generationIdsByChat = signal<Record<string, string>>({});
  private readonly pendingNarration = new Map<string, { turnIndex: number; text: string }>();
  private narrationFlushHandle:
    | ReturnType<typeof requestAnimationFrame>
    | ReturnType<typeof setTimeout>
    | null = null;
  private readonly turnReplay = new TurnReplayController({
    isActive: (chatId) => this.activeChatId() === chatId,
    isRunning: (chatId) => this.isChatRunning(chatId),
    getTurns: (chatId) => this.getTurns(chatId),
    updateTurn: (chatId, turnIndex, updater) => this.updateTurn(chatId, turnIndex, updater),
    applyEvent: (chatId, turnIndex, event) => {
      if (event.type === 'narration') {
        this.bufferNarration(chatId, turnIndex, event.text);
        return;
      }
      this.flushNarration(chatId);
      this.updateTurn(chatId, turnIndex, (turn) => applyOrchestratorEvent(turn, event));
      this.handleEventSideEffects(chatId, event);
    },
    refreshChat: (chatId) => this.refreshChatState(chatId),
    setNotice: (message) => this.notice.set(message),
  });

  readonly turnRunning = computed(() => {
    const chatId = this.activeChatId();
    return chatId ? this.isChatRunning(chatId) : false;
  });

  readonly activeTurns = computed(() => {
    const chatId = this.activeChatId();
    if (!chatId) {
      return [];
    }
    return this.turnsByChat()[chatId] ?? [];
  });

  // Versions for the active chat, keyed by commit so a turn's inline version
  // chip can look up its seq, diffstat and changed files.
  readonly activeVersionsByCommit = computed(() => {
    const chatId = this.activeChatId();
    const versions = chatId ? (this.versionsByChat()[chatId] ?? []) : [];
    return new Map(versions.map((version) => [version.commit, version]));
  });

  readonly activeChat = computed(() => {
    const chatId = this.activeChatId();
    if (!chatId) {
      return null;
    }
    return this.chats().find((chat) => chat.chatId === chatId) ?? null;
  });

  // Lists show only chats with content; untouched drafts (no title, no
  // versions, idle) stay hidden until a first prompt lands — matching v0.
  readonly visibleChats = computed(() => {
    return this.chats()
      .filter((chat) => chat.title || chat.status === 'running' || chat.versions.length > 0)
      .slice()
      .reverse();
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      const activeChatId = this.activeChatId();
      if (activeChatId) {
        this.stopReplay(activeChatId);
      }
    });
  }

  async loadChats(): Promise<void> {
    this.loadingChats.set(true);
    this.error.set(null);

    try {
      const response = await fetch('/api/chats');
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to load chats'));
      }
      const chats = (await response.json()) as ChatSummary[];
      this.chats.set(chats);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load chats');
    } finally {
      this.loadingChats.set(false);
    }
  }

  async refreshActiveChat(): Promise<ChatDetail | null> {
    const chatId = this.activeChatId();
    if (!chatId) {
      return null;
    }

    return this.refreshChatState(chatId);
  }

  async loadVersions(chatId: string): Promise<ChatVersion[]> {
    const response = await fetch(`/api/chats/${chatId}/versions`);
    if (!response.ok) {
      throw new Error(await errorMessage(response, 'Failed to load version history'));
    }
    const versions = (await response.json()) as ChatVersion[];
    this.versionsByChat.update((state) => ({ ...state, [chatId]: versions }));
    return versions;
  }

  // Best-effort refresh of the version cache that feeds inline chips. Failures
  // are swallowed: the chip degrades to commit-only, the chat still works.
  private async refreshVersions(chatId: string): Promise<void> {
    try {
      await this.loadVersions(chatId);
    } catch {
      // The inline chip falls back to the short commit without diffstat.
    }
  }

  async loadVersionDiff(chatId: string, versionId: string): Promise<VersionDiffFile[]> {
    const response = await fetch(`/api/chats/${chatId}/versions/${versionId}/diff`);
    if (!response.ok) {
      throw new Error(await errorMessage(response, 'Failed to load version diff'));
    }
    const body = (await response.json()) as { files: VersionDiffFile[] };
    return body.files ?? [];
  }

  async restoreVersion(chatId: string, versionId: string): Promise<ChatVersion | null> {
    this.error.set(null);
    this.notice.set(null);
    try {
      const response = await fetch(`/api/chats/${chatId}/versions/${versionId}/restore`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to restore version'));
      }
      const version = (await response.json()) as ChatVersion;
      await Promise.all([
        this.refreshChatState(chatId),
        this.loadTurnHistory(chatId, true),
        this.refreshVersions(chatId),
      ]);
      this.previewReloadTick.update((tick) => tick + 1);
      this.notice.set(`Restored version ${version.seq} as a new version.`);
      return version;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to restore version');
      return null;
    }
  }

  async forkVersion(chatId: string, versionId: string): Promise<string | null> {
    this.error.set(null);
    this.notice.set(null);
    try {
      const response = await fetch(`/api/chats/${chatId}/versions/${versionId}/fork`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to fork version'));
      }
      const body = (await response.json()) as CreateChatResponse;
      await this.loadChats();
      await this.router.navigate(['/chats', body.chatId]);
      return body.chatId;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to fork version');
      return null;
    }
  }

  async renameChat(chatId: string, title: string): Promise<ChatSummary | null> {
    const trimmed = title.trim();
    if (!trimmed) {
      return null;
    }

    this.error.set(null);
    this.notice.set(null);
    try {
      const response = await fetch(`/api/chats/${chatId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to rename chat'));
      }
      const updated = (await response.json()) as ChatSummary;
      this.chats.update((items) => {
        const index = items.findIndex((chat) => chat.chatId === chatId);
        if (index === -1) {
          return [...items, updated];
        }
        const next = [...items];
        next[index] = updated;
        return next;
      });
      return updated;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to rename chat');
      return null;
    }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    this.error.set(null);
    this.notice.set(null);
    try {
      const response = await fetch(`/api/chats/${chatId}`, { method: 'DELETE' });
      if (response.status === 409) {
        this.notice.set('Wait for the running turn to finish before deleting this chat.');
        return false;
      }
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to delete chat'));
      }

      this.stopReplay(chatId);
      this.chats.update((items) => items.filter((chat) => chat.chatId !== chatId));
      this.turnsByChat.update((state) => {
        const next = { ...state };
        delete next[chatId];
        return next;
      });
      this.versionsByChat.update((state) => {
        const next = { ...state };
        delete next[chatId];
        return next;
      });
      if (this.activeChatId() === chatId) {
        this.activeChatId.set(null);
      }
      await this.router.navigate(['/']);
      return true;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to delete chat');
      return false;
    }
  }

  async hydrateChat(chatId: string, forceHistory = false): Promise<void> {
    const [chat] = await Promise.all([
      this.refreshChatState(chatId),
      this.loadTurnHistory(chatId, forceHistory),
      this.refreshVersions(chatId),
    ]);

    if (!chat) {
      return;
    }

    if (chat.turnRunning) {
      this.markChatRunning(chatId, chat.runningGenerationId);
      if (chat.runningGenerationId && this.activeChatId() === chatId) {
        this.turnReplay.attach(chatId, chat.runningGenerationId);
      }
      return;
    }

    this.markChatIdle(chatId);
  }

  private async refreshChatState(chatId: string): Promise<ChatDetail | null> {
    const response = await fetch(`/api/chats/${chatId}`);
    if (!response.ok) {
      if (response.status === 404) {
        this.error.set('Chat not found');
      }
      return null;
    }

    const chat = (await response.json()) as ChatDetail;
    this.chats.update((items) => {
      const index = items.findIndex((item) => item.chatId === chat.chatId);
      if (index === -1) {
        return [...items, chat];
      }
      const next = [...items];
      next[index] = chat;
      return next;
    });

    if (chat.turnRunning) {
      this.markChatRunning(chatId, chat.runningGenerationId);
    } else {
      this.markChatIdle(chatId);
    }

    return chat;
  }

  async createChat(projectId?: string): Promise<string | null> {
    if (this.creatingChat()) {
      return null;
    }

    this.error.set(null);

    // Clicking "New Chat" repeatedly must not pile up empty chats: reuse any
    // untouched chat (no title, idle, no versions, nothing sent locally).
    const emptyChat = this.chats().find(
      (chat) =>
        (!projectId || chat.projectId === projectId) &&
        !chat.title &&
        chat.status === 'idle' &&
        chat.versions.length === 0 &&
        (this.turnsByChat()[chat.chatId] ?? []).length === 0,
    );
    if (emptyChat) {
      await this.router.navigate(['/chats', emptyChat.chatId]);
      return emptyChat.chatId;
    }

    this.creatingChat.set(true);

    try {
      const response = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(projectId ? { projectId } : {}),
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to create chat'));
      }

      const body = (await response.json()) as CreateChatResponse;
      this.turnsByChat.update((state) => ({ ...state, [body.chatId]: [] }));
      await this.loadChats();
      await this.router.navigate(['/chats', body.chatId]);
      return body.chatId;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to create chat');
      return null;
    } finally {
      this.creatingChat.set(false);
    }
  }

  /**
   * Create a chat seeded from an existing repo state (ng-v0 bridge, piece 1).
   * Unlike `createChat`, this never reuses an empty draft — a seed always births
   * a fresh workspace. Returns the new chatId, or a structured error; a red seed
   * gate comes back as 422 with the gate tail in `gateOutput` so the caller can
   * render it instead of spinning forever.
   */
  async createSeededChat(opts: {
    title: string;
    seed: { kind: 'git'; url: string; ref: string };
  }): Promise<{ chatId: string } | { error: string; gateOutput?: string }> {
    try {
      const response = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      if (response.status === 201) {
        const body = (await response.json()) as CreateChatResponse;
        this.turnsByChat.update((state) => ({ ...state, [body.chatId]: [] }));
        await this.loadChats();
        return { chatId: body.chatId };
      }
      let payload: { error?: string; gateOutput?: string } = {};
      try {
        payload = (await response.json()) as { error?: string; gateOutput?: string };
      } catch {
        // non-JSON error body — fall back to the status line
      }
      return {
        error: payload.error ?? `Failed to create chat (${response.status})`,
        gateOutput: payload.gateOutput,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to create chat' };
    }
  }

  setActiveChat(chatId: string): void {
    const previousChatId = this.activeChatId();
    if (previousChatId && previousChatId !== chatId) {
      this.stopReplay(previousChatId);
    }
    this.activeChatId.set(chatId);
    this.error.set(null);
    this.notice.set(null);
    this.currentTurnTouchedFiles.set({});
    this.turnsByChat.update((state) => (state[chatId] ? state : { ...state, [chatId]: [] }));
  }

  // Past turns live in the orchestrator's metadata store; hydrate them once
  // per chat so history survives reloads. Live turns always win.
  async loadTurnHistory(chatId: string, force = false): Promise<void> {
    if (!force && (this.turnsByChat()[chatId] ?? []).length > 0) {
      return;
    }
    try {
      const response = await fetch(`/api/chats/${chatId}/turns`);
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { turns: TurnHistoryEntry[] };
      const turns = body.turns.map((entry) =>
        historyEntryToTurn({
          ...entry,
          narration: entry.narration ?? '',
          generationId: entry.generationId,
        }),
      );
      this.turnsByChat.update((state) => {
        if (!force && (state[chatId] ?? []).length > 0) {
          return state;
        }
        return { ...state, [chatId]: turns };
      });
    } catch {
      // History is a nicety; the chat still works without it.
    }
  }

  getTurns(chatId: string): TurnState[] {
    return this.turnsByChat()[chatId] ?? [];
  }

  toggleGateExpanded(chatId: string, turnIndex: number): void {
    this.updateTurn(chatId, turnIndex, (turn) => {
      if (!turn.gate) {
        return turn;
      }
      return {
        ...turn,
        gate: { ...turn.gate, expanded: !turn.gate.expanded },
      };
    });
  }

  async sendTurn(chatId: string, prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed || this.isChatRunning(chatId)) {
      return;
    }

    this.error.set(null);
    this.notice.set(null);
    this.markChatRunning(chatId, null);
    const selectedModel = this.modelService.selectedModel();

    const turns = [...(this.turnsByChat()[chatId] ?? [])];
    const turnIndex = turns.length;
    turns.push(createTurn(trimmed));
    this.setTurns(chatId, turns);

    this.chats.update((items) =>
      items.map((chat) =>
        chat.chatId === chatId
          ? {
              ...chat,
              status: 'running' as const,
              title: chat.title ?? deriveTitle(trimmed),
            }
          : chat,
      ),
    );

    let requestAccepted = false;
    let collided = false;

    try {
      const response = await fetch(`/api/chats/${chatId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: trimmed,
          ...(selectedModel ? { model: selectedModel } : {}),
        }),
      });

      if (response.status === 409) {
        collided = true;
        this.removeTurn(chatId, turnIndex);
        this.notice.set('A turn is already running for this chat');
        await this.hydrateChat(chatId, true);
        return;
      }

      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to start turn'));
      }
      requestAccepted = true;

      for await (const frame of readSseStream(response)) {
        this.turnReplay.consumeFrame(chatId, turnIndex, frame);
      }
      this.flushNarration(chatId);
    } catch (err) {
      this.flushNarration(chatId);
      const message = err instanceof Error ? err.message : 'Turn failed';
      if (requestAccepted) {
        this.notice.set('Connection interrupted. Reattaching to the running turn…');
      } else {
        this.error.set(message);
        this.markChatIdle(chatId);
        this.updateTurn(chatId, turnIndex, (turn) => ({
          ...turn,
          running: false,
          gate: {
            status: 'red',
            output: message,
            expanded: true,
          },
          result: 'red',
        }));
      }
    } finally {
      if (!collided) {
        let chat: ChatDetail | null = null;
        try {
          chat = await this.refreshChatState(chatId);
        } catch {
          // Keep the local running state until the replay stream can reconcile it.
        }

        const generationId =
          chat?.runningGenerationId ??
          this.getTurns(chatId)[turnIndex]?.generationId ??
          this.generationIdsByChat()[chatId] ??
          null;
        if (
          requestAccepted &&
          this.isChatRunning(chatId) &&
          generationId &&
          this.activeChatId() === chatId
        ) {
          this.turnReplay.attach(chatId, generationId);
        }
      }
    }
  }

  private bufferNarration(chatId: string, turnIndex: number, text: string): void {
    let pending = this.pendingNarration.get(chatId);
    if (pending && pending.turnIndex !== turnIndex) {
      this.flushNarration(chatId);
      pending = undefined;
    }

    this.pendingNarration.set(chatId, {
      turnIndex,
      text: `${pending?.text ?? ''}${text}`,
    });
    this.scheduleNarrationFlush();
  }

  private scheduleNarrationFlush(): void {
    if (this.narrationFlushHandle !== null) {
      return;
    }

    const runFlush = () => {
      this.narrationFlushHandle = null;
      for (const chatId of [...this.pendingNarration.keys()]) {
        this.flushNarration(chatId);
      }
    };

    if (typeof requestAnimationFrame === 'function') {
      this.narrationFlushHandle = requestAnimationFrame(runFlush);
    } else {
      this.narrationFlushHandle = setTimeout(runFlush, 16);
    }
  }

  private flushNarration(chatId: string): void {
    const pending = this.pendingNarration.get(chatId);
    if (!pending) {
      return;
    }

    this.pendingNarration.delete(chatId);
    const syntheticEvent: OrchestratorEvent = { type: 'narration', text: pending.text };
    this.updateTurn(chatId, pending.turnIndex, (turn) =>
      applyOrchestratorEvent(turn, syntheticEvent),
    );
    this.handleEventSideEffects(chatId, syntheticEvent);
  }

  private handleEventSideEffects(chatId: string, event: OrchestratorEvent): void {
    this.streamActivityTick.update((tick) => tick + 1);

    if (event.type === 'turn-started') {
      this.markChatRunning(chatId, event.turnId);
      this.currentTurnTouchedFiles.set({});
      this.turnStartedTick.update((tick) => tick + 1);
    }

    if (event.type === 'file-changed') {
      this.currentTurnTouchedFiles.update((files) => ({
        ...files,
        [event.path]: event.kind,
      }));
      this.fileChangedTick.update((tick) => tick + 1);
    }

    if (event.type === 'version-created') {
      // diffstat/files are computed server-side at cut time and only exposed
      // via the versions list; refresh so the inline chip can show them.
      void this.refreshVersions(chatId);
    }

    if (event.type === 'turn-finished') {
      this.markChatIdle(chatId);
      this.notice.set(null);
      this.turnFinishedTick.update((tick) => tick + 1);
    }

    if (
      event.type === 'gate-status' &&
      event.status === 'green' &&
      this.activeChatId() === chatId
    ) {
      this.previewReloadTick.update((tick) => tick + 1);
    }
  }

  private markChatRunning(chatId: string, generationId: string | null): void {
    this.generationIdsByChat.update((current) => {
      const next = { ...current };
      if (generationId) {
        next[chatId] = generationId;
      } else {
        delete next[chatId];
      }
      return next;
    });
    this.setChatStatus(chatId, 'running');
  }

  private markChatIdle(chatId: string): void {
    this.generationIdsByChat.update((current) => {
      const next = { ...current };
      delete next[chatId];
      return next;
    });
    this.setChatStatus(chatId, 'idle');
  }

  private isChatRunning(chatId: string): boolean {
    return this.chats().some((chat) => chat.chatId === chatId && chat.status === 'running');
  }

  private setChatStatus(chatId: string, status: ChatSummary['status']): void {
    this.chats.update((items) =>
      items.map((chat) => (chat.chatId === chatId ? { ...chat, status } : chat)),
    );
  }

  private stopReplay(chatId: string): void {
    this.flushNarration(chatId);
    this.turnReplay.stop(chatId);
  }

  private removeTurn(chatId: string, turnIndex: number): void {
    const turns = [...this.getTurns(chatId)];
    turns.splice(turnIndex, 1);
    this.setTurns(chatId, turns);
  }

  private updateTurn(
    chatId: string,
    turnIndex: number,
    updater: (turn: TurnState) => TurnState,
  ): void {
    const turns = [...(this.turnsByChat()[chatId] ?? [])];
    const current = turns[turnIndex];
    if (!current) {
      return;
    }
    turns[turnIndex] = updater(current);
    this.setTurns(chatId, turns);
  }

  private setTurns(chatId: string, turns: TurnState[]): void {
    this.turnsByChat.update((state) => ({ ...state, [chatId]: turns }));
  }
}

// A momentary optimistic placeholder only: the server is authoritative on
// titles (it derives and sets the real one, and sendTurn's finally block
// refreshes the chat from the server), so this doesn't need to replicate the
// orchestrator's full deriveChatTitle logic.
function deriveTitle(prompt: string): string {
  const title = prompt.split('\n')[0]?.trim() ?? '';
  return title.slice(0, 60);
}
