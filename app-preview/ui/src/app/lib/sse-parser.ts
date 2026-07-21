export interface SseFrame {
  id?: string;
  event: string;
  data: string;
}

export function parseSseFrame(raw: string): SseFrame | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let event = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of trimmed.split('\n')) {
    if (line.startsWith('id:')) {
      id = line.slice('id:'.length).trim();
      continue;
    }

    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (dataLines.length === 0 && event === 'message') {
    return null;
  }

  return { ...(id === undefined ? {} : { id }), event, data: dataLines.join('\n') };
}

export function parseSseBuffer(buffer: string): { frames: SseFrame[]; remainder: string } {
  const frames: SseFrame[] = [];
  const parts = buffer.split(/\r?\n\r?\n/);
  const remainder = parts.pop() ?? '';

  for (const part of parts) {
    const frame = parseSseFrame(part);
    if (frame) {
      frames.push(frame);
    }
  }

  return { frames, remainder };
}

export async function* readSseStream(
  response: Response,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseBuffer(buffer);
    buffer = parsed.remainder;

    for (const frame of parsed.frames) {
      yield frame;
    }
  }

  const trailing = parseSseFrame(buffer);
  if (trailing) {
    yield trailing;
  }
}
