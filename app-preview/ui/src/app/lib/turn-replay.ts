import type { TurnState } from '../models/turn';
import type { ChatDetail, OrchestratorEvent } from '../types/orchestrator-events';
import { INITIAL_RECONNECT_DELAY_MS, abortableDelay, nextReconnectDelay } from './retry';
import { readSseStream, type SseFrame } from './sse-parser';

export interface TurnReplayHost {
  isActive(chatId: string): boolean;
  isRunning(chatId: string): boolean;
  getTurns(chatId: string): TurnState[];
  updateTurn(chatId: string, turnIndex: number, updater: (turn: TurnState) => TurnState): void;
  applyEvent(chatId: string, turnIndex: number, event: OrchestratorEvent): void;
  refreshChat(chatId: string): Promise<ChatDetail | null>;
  setNotice(message: string): void;
}

export class TurnReplayController {
  private readonly replayControllers = new Map<string, AbortController>();
  private readonly replayGenerationByChat = new Map<string, string>();
  private readonly lastEventSeq = new Map<string, number>();
  private readonly preparedReplayGenerations = new Set<string>();

  constructor(private readonly host: TurnReplayHost) {}

  attach(chatId: string, generationId: string): void {
    if (!this.host.isActive(chatId)) {
      return;
    }
    if (
      this.replayGenerationByChat.get(chatId) === generationId &&
      this.replayControllers.has(chatId)
    ) {
      return;
    }

    this.stopConnection(chatId);
    const controller = new AbortController();
    this.replayControllers.set(chatId, controller);
    this.replayGenerationByChat.set(chatId, generationId);

    const replayKey = this.replayKey(chatId, generationId);
    this.bindRunningTurnToGeneration(chatId, generationId);
    if (!this.preparedReplayGenerations.has(replayKey)) {
      this.preparedReplayGenerations.add(replayKey);
      if ((this.lastEventSeq.get(replayKey) ?? 0) === 0) {
        this.resetRunningTurnForReplay(chatId, generationId);
      }
    }

    void this.runReplayLoop(chatId, generationId, controller);
  }

  stop(chatId: string): void {
    this.stopConnection(chatId);
    const keyPrefix = `${chatId}:`;
    for (const key of this.lastEventSeq.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.lastEventSeq.delete(key);
      }
    }
    for (const key of this.preparedReplayGenerations) {
      if (key.startsWith(keyPrefix)) {
        this.preparedReplayGenerations.delete(key);
      }
    }
  }

  consumeFrame(
    chatId: string,
    fallbackTurnIndex: number,
    frame: SseFrame,
    replayGenerationId?: string,
  ): OrchestratorEvent | null {
    let event: OrchestratorEvent;
    try {
      event = JSON.parse(frame.data) as OrchestratorEvent;
    } catch {
      return null;
    }

    const sequenceKey =
      replayGenerationId ??
      this.host.getTurns(chatId)[fallbackTurnIndex]?.generationId ??
      (event.type === 'turn-started'
        ? event.turnId
        : this.host.getTurns(chatId)[fallbackTurnIndex]?.turnId);
    const sequence = frame.id === undefined ? undefined : Number(frame.id);
    if (sequenceKey && sequence !== undefined && Number.isFinite(sequence)) {
      const replayKey = this.replayKey(chatId, sequenceKey);
      const lastSequence = this.lastEventSeq.get(replayKey) ?? 0;
      if (sequence <= lastSequence) {
        return null;
      }
      this.lastEventSeq.set(replayKey, sequence);
    }

    const turnIndex = replayGenerationId
      ? this.findRunningTurnIndex(chatId, replayGenerationId)
      : fallbackTurnIndex;
    this.host.applyEvent(chatId, turnIndex, event);
    return event;
  }

  private async runReplayLoop(
    chatId: string,
    generationId: string,
    controller: AbortController,
  ): Promise<void> {
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    const replayKey = this.replayKey(chatId, generationId);

    try {
      while (
        !controller.signal.aborted &&
        this.host.isActive(chatId) &&
        this.host.isRunning(chatId)
      ) {
        const since = this.lastEventSeq.get(replayKey) ?? 0;
        try {
          const response = await fetch(
            `/api/chats/${chatId}/generations/${generationId}/events?since=${since}`,
            { signal: controller.signal },
          );
          if (!response.ok) {
            throw new Error(`Failed to reattach to turn (${response.status})`);
          }

          let turnFinished = false;
          for await (const frame of readSseStream(response)) {
            if (controller.signal.aborted || !this.host.isActive(chatId)) {
              return;
            }
            const event = this.consumeFrame(
              chatId,
              this.findRunningTurnIndex(chatId, generationId),
              frame,
              generationId,
            );
            if (event?.type === 'turn-finished') {
              turnFinished = true;
            }
          }

          if (turnFinished || !this.host.isRunning(chatId)) {
            return;
          }
        } catch (err) {
          if (controller.signal.aborted || !this.host.isActive(chatId)) {
            return;
          }
          this.host.setNotice(
            err instanceof Error
              ? `${err.message}. Retrying…`
              : 'Turn stream interrupted. Retrying…',
          );
        }

        let chat: ChatDetail | null = null;
        try {
          chat = await this.host.refreshChat(chatId);
        } catch {
          // A failed status refresh is recoverable through the replay endpoint.
        }
        if (chat && (!chat.turnRunning || !chat.runningGenerationId)) {
          return;
        }
        if (chat?.runningGenerationId && chat.runningGenerationId !== generationId) {
          this.attach(chatId, chat.runningGenerationId);
          return;
        }

        const shouldRetry = await abortableDelay(reconnectDelay, controller.signal);
        if (!shouldRetry) {
          return;
        }
        reconnectDelay = nextReconnectDelay(reconnectDelay);
      }
    } finally {
      if (this.replayControllers.get(chatId) === controller) {
        this.replayControllers.delete(chatId);
        this.replayGenerationByChat.delete(chatId);
      }
    }
  }

  private resetRunningTurnForReplay(chatId: string, generationId: string): void {
    const turnIndex = this.findRunningTurnIndex(chatId, generationId);
    this.host.updateTurn(chatId, turnIndex, (turn) => ({
      ...turn,
      narration: '',
      tools: [],
      fileChanges: [],
      gate: undefined,
      version: undefined,
      result: undefined,
      running: true,
    }));
  }

  private bindRunningTurnToGeneration(chatId: string, generationId: string): void {
    const turnIndex = this.findRunningTurnIndex(chatId, generationId);
    const turn = this.host.getTurns(chatId)[turnIndex];
    if (!turn) {
      return;
    }

    if (turn.turnId && turn.generationId !== generationId) {
      const temporaryKey = this.replayKey(chatId, turn.turnId);
      const temporarySequence = this.lastEventSeq.get(temporaryKey);
      if (temporarySequence !== undefined) {
        this.lastEventSeq.set(this.replayKey(chatId, generationId), temporarySequence);
        this.lastEventSeq.delete(temporaryKey);
      }
    }

    this.host.updateTurn(chatId, turnIndex, (current) => ({
      ...current,
      generationId,
    }));
  }

  private findRunningTurnIndex(chatId: string, generationId: string): number {
    const turns = this.host.getTurns(chatId);
    const exactIndex = turns.findIndex((turn) => turn.generationId === generationId);
    if (exactIndex !== -1) {
      return exactIndex;
    }
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index]?.running) {
        return index;
      }
    }
    return -1;
  }

  private stopConnection(chatId: string): void {
    this.replayControllers.get(chatId)?.abort();
    this.replayControllers.delete(chatId);
    this.replayGenerationByChat.delete(chatId);
  }

  private replayKey(chatId: string, generationId: string): string {
    return `${chatId}:${generationId}`;
  }
}
