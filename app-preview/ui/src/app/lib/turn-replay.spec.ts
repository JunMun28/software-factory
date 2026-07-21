import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyOrchestratorEvent, createTurn, type TurnState } from '../models/turn';
import type { ChatDetail, OrchestratorEvent } from '../types/orchestrator-events';
import { TurnReplayController, type TurnReplayHost } from './turn-replay';

describe('TurnReplayController', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('deduplicates replay frames by event sequence', () => {
    const state = replayState();
    const controller = new TurnReplayController(state.host);
    const frame = {
      id: '2',
      event: 'narration',
      data: JSON.stringify({ type: 'narration', text: 'Hello' }),
    };

    expect(controller.consumeFrame('chat-1', 0, frame, 'generation-1')).toMatchObject({
      type: 'narration',
    });
    expect(controller.consumeFrame('chat-1', 0, frame, 'generation-1')).toBeNull();

    expect(state.turns[0]?.narration).toBe('Hello');
    expect(state.events).toHaveLength(1);
  });

  it('clears per-chat event sequences when stopped', () => {
    const state = replayState();
    const controller = new TurnReplayController(state.host);
    const frame = {
      id: '2',
      event: 'narration',
      data: JSON.stringify({ type: 'narration', text: 'Hello' }),
    };

    controller.consumeFrame('chat-1', 0, frame, 'generation-1');
    controller.stop('chat-1');
    controller.consumeFrame('chat-1', 0, frame, 'generation-1');

    expect(state.turns[0]?.narration).toBe('HelloHello');
    expect(state.events).toHaveLength(2);
  });
});

function replayState(): {
  turns: TurnState[];
  events: OrchestratorEvent[];
  host: TurnReplayHost;
} {
  const turns: TurnState[] = [{ ...createTurn('Build a dashboard'), generationId: 'generation-1' }];
  const events: OrchestratorEvent[] = [];
  const host: TurnReplayHost = {
    isActive: () => true,
    isRunning: () => turns.some((turn) => turn.running),
    getTurns: () => turns,
    updateTurn: (_chatId, turnIndex, updater) => {
      const turn = turns[turnIndex];
      if (turn) {
        turns[turnIndex] = updater(turn);
      }
    },
    applyEvent: (_chatId, turnIndex, event) => {
      const turn = turns[turnIndex];
      if (turn) {
        turns[turnIndex] = applyOrchestratorEvent(turn, event);
        events.push(event);
      }
    },
    refreshChat: async () => null as ChatDetail | null,
    setNotice: () => undefined,
  };
  return { turns, events, host };
}
