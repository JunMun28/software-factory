import { describe, expect, it } from 'vitest';
import type { Event } from '@opencode-ai/sdk';
import {
  createTurnEventContext,
  mapOpenCodeEvent,
} from '../src/harness/opencode-harness.js';

function assistantMessage(id: string): Event {
  return {
    type: 'message.updated',
    properties: {
      info: { id, role: 'assistant', sessionID: 'ses_1' },
    },
  } as unknown as Event;
}

function textPart(
  messageID: string,
  partID: string,
  text: string,
  delta?: string,
): Event {
  return {
    type: 'message.part.updated',
    properties: {
      part: { id: partID, sessionID: 'ses_1', messageID, type: 'text', text },
      ...(delta === undefined ? {} : { delta }),
    },
  } as unknown as Event;
}

function narrationTexts(events: Event[]): string[] {
  const ctx = createTurnEventContext();
  return events
    .flatMap((event) => mapOpenCodeEvent(event, ctx))
    .filter((event) => event.type === 'narration')
    .map((event) => (event as { text: string }).text);
}

describe('mapOpenCodeEvent narration', () => {
  it('emits narration from assistant text parts that carry a delta', () => {
    expect(
      narrationTexts([
        assistantMessage('msg_a'),
        textPart('msg_a', 'prt_1', 'Hello', 'Hello'),
        textPart('msg_a', 'prt_1', 'Hello world', ' world'),
      ]),
    ).toEqual(['Hello', ' world']);
  });

  it('derives increments when full-part updates arrive without delta', () => {
    expect(
      narrationTexts([
        assistantMessage('msg_a'),
        textPart('msg_a', 'prt_1', 'Hello'),
        textPart('msg_a', 'prt_1', 'Hello world'),
        textPart('msg_a', 'prt_1', 'Hello world'),
      ]),
    ).toEqual(['Hello', ' world']);
  });

  it('ignores text parts of non-assistant messages (user prompt echo)', () => {
    expect(
      narrationTexts([textPart('msg_user', 'prt_1', 'Build me an app')]),
    ).toEqual([]);
  });

  it('separates distinct text parts with a paragraph break', () => {
    expect(
      narrationTexts([
        assistantMessage('msg_a'),
        assistantMessage('msg_b'),
        textPart('msg_a', 'prt_1', 'first'),
        textPart('msg_b', 'prt_2', 'second'),
      ]),
    ).toEqual(['first', '\n\nsecond']);
  });

  it('skips synthetic text parts', () => {
    const ctx = createTurnEventContext();
    const events = [
      assistantMessage('msg_a'),
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_1',
            sessionID: 'ses_1',
            messageID: 'msg_a',
            type: 'text',
            text: 'injected',
            synthetic: true,
          },
        },
      } as unknown as Event,
    ];
    const mapped = events.flatMap((event) => mapOpenCodeEvent(event, ctx));
    expect(mapped.filter((event) => event.type === 'narration')).toEqual([]);
  });

  it('still maps tool parts', () => {
    const ctx = createTurnEventContext();
    const event = {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_t',
          sessionID: 'ses_1',
          messageID: 'msg_a',
          type: 'tool',
          tool: 'bash',
          state: { status: 'running' },
        },
      },
    } as unknown as Event;
    expect(mapOpenCodeEvent(event, createTurnEventContext())).toEqual([
      { type: 'tool', id: 'prt_t', name: 'bash', detail: { status: 'running' } },
    ]);
    void event;
    void ctx;
  });
});

describe('mapOpenCodeEvent file paths', () => {
  function watcherEvent(file: string, kind = 'change'): Event {
    return {
      type: 'file.watcher.updated',
      properties: { file, event: kind },
    } as unknown as Event;
  }

  it('relativizes absolute watcher paths against the workspace', () => {
    const ctx = createTurnEventContext('/ws/chat-1');
    expect(mapOpenCodeEvent(watcherEvent('/ws/chat-1/src/app.ts'), ctx)).toEqual([
      { type: 'file-changed', path: 'src/app.ts', kind: 'modified' },
    ]);
  });

  it('drops git internals and dependency trees', () => {
    const ctx = createTurnEventContext('/ws/chat-1');
    expect(mapOpenCodeEvent(watcherEvent('/ws/chat-1/.git/index.lock'), ctx)).toEqual([]);
    expect(
      mapOpenCodeEvent(watcherEvent('/ws/chat-1/frontend/node_modules/x/y.js'), ctx),
    ).toEqual([]);
  });

  it('drops files outside the workspace', () => {
    const ctx = createTurnEventContext('/ws/chat-1');
    expect(mapOpenCodeEvent(watcherEvent('/somewhere/else.ts'), ctx)).toEqual([]);
  });
});
