import { describe, expect, it } from 'vitest';

import { parseSseBuffer, parseSseFrame } from './sse-parser';

describe('parseSseFrame', () => {
  it('parses event and data lines', () => {
    const frame = parseSseFrame(
      'id: 42\nevent: narration\ndata: {"type":"narration","text":"hello"}',
    );

    expect(frame).toEqual({
      id: '42',
      event: 'narration',
      data: '{"type":"narration","text":"hello"}',
    });
  });

  it('joins multi-line data payloads', () => {
    const frame = parseSseFrame('event: tool\ndata: line-one\ndata: line-two');

    expect(frame).toEqual({
      event: 'tool',
      data: 'line-one\nline-two',
    });
  });

  it('returns null for empty frames', () => {
    expect(parseSseFrame('')).toBeNull();
    expect(parseSseFrame('   \n  ')).toBeNull();
  });
});

describe('parseSseBuffer', () => {
  it('splits complete frames and keeps partial remainder', () => {
    const buffer =
      'event: turn-started\ndata: {"type":"turn-started"}\n\n' +
      'event: narration\ndata: {"type":"narration","text":"hi"}\n\n' +
      'event: tool\ndata: {"type":"tool","name":"bash"';

    const parsed = parseSseBuffer(buffer);

    expect(parsed.frames).toHaveLength(2);
    expect(parsed.frames[0]?.event).toBe('turn-started');
    expect(parsed.frames[1]?.event).toBe('narration');
    expect(parsed.remainder).toBe('event: tool\ndata: {"type":"tool","name":"bash"');
  });

  it('handles chunk boundaries across CRLF separators', () => {
    const first = parseSseBuffer('event: gate-status\r\ndata: {"status":"pending"}\r\n');
    expect(first.frames).toHaveLength(0);
    expect(first.remainder).toContain('gate-status');

    const second = parseSseBuffer(
      first.remainder + '\r\n\r\nevent: turn-finished\ndata: {}\r\n\r\n',
    );
    expect(second.frames).toHaveLength(2);
    expect(second.frames[0]?.event).toBe('gate-status');
    expect(second.frames[1]?.event).toBe('turn-finished');
  });
});
