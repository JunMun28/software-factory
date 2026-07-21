import type { ServerType } from '@hono/node-server';
import type { OrchestratorEvent } from '../src/types.js';

export async function parseSseResponse(
  response: Response,
): Promise<{ events: OrchestratorEvent[]; raw: string }> {
  const raw = await response.text();
  const events: OrchestratorEvent[] = [];

  const chunks = raw.split('\n\n');
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    let dataLine: string | undefined;
    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataLine = line.slice(5).trim();
      }
    }
    if (dataLine) {
      events.push(JSON.parse(dataLine) as OrchestratorEvent);
    }
  }

  return { events, raw };
}

export async function postTurn(
  baseUrl: string,
  chatId: string,
  prompt: string,
  model?: string,
): Promise<{ status: number; events: OrchestratorEvent[] }> {
  const response = await fetch(`${baseUrl}/chats/${chatId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, ...(model ? { model } : {}) }),
  });
  const { events } = await parseSseResponse(response);
  return { status: response.status, events };
}

export async function createChat(baseUrl: string): Promise<{
  status: number;
  chatId: string;
}> {
  const response = await fetch(`${baseUrl}/chats`, { method: 'POST' });
  const body = (await response.json()) as { chatId: string };
  return { status: response.status, chatId: body.chatId };
}

export async function getChat(baseUrl: string, chatId: string) {
  const response = await fetch(`${baseUrl}/chats/${chatId}`);
  return {
    status: response.status,
    body: await response.json(),
  };
}

export async function getPreviewStatus(baseUrl: string, chatId: string) {
  const response = await fetch(`${baseUrl}/chats/${chatId}/preview`);
  return {
    status: response.status,
    body: await response.json(),
  };
}

export async function getWorkspaceFiles(baseUrl: string, chatId: string) {
  const response = await fetch(`${baseUrl}/chats/${chatId}/files`);
  return {
    status: response.status,
    body: (await response.json()) as {
      files?: Array<{ path: string; status: string }>;
      error?: string;
    },
  };
}

export async function getWorkspaceFileContent(
  baseUrl: string,
  chatId: string,
  filePath: string,
) {
  const response = await fetch(
    `${baseUrl}/chats/${chatId}/files/content?path=${encodeURIComponent(filePath)}`,
  );
  return {
    status: response.status,
    body: (await response.json()) as { path?: string; content?: string; error?: string },
  };
}

export async function getWorkspaceFileDiff(
  baseUrl: string,
  chatId: string,
  filePath: string,
) {
  const response = await fetch(
    `${baseUrl}/chats/${chatId}/files/diff?path=${encodeURIComponent(filePath)}`,
  );
  return {
    status: response.status,
    body: (await response.json()) as { path?: string; diff?: string; error?: string },
  };
}

export async function postPreview(baseUrl: string, chatId: string) {
  const response = await fetch(`${baseUrl}/chats/${chatId}/preview`, {
    method: 'POST',
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

export async function waitForPreviewStatus(
  baseUrl: string,
  chatId: string,
  targetStatus: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await getPreviewStatus(baseUrl, chatId);
    if (current.body?.status === targetStatus) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for preview status ${targetStatus}`);
}

export async function parseChatEvents(
  baseUrl: string,
  chatId: string,
  trigger?: () => Promise<void>,
): Promise<Array<{ event: string; data: string }>> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/chats/${chatId}/events`, {
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to open chat events stream (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: Array<{ event: string; data: string }> = [];

  const readLoop = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const lines = part.split('\n');
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith('event:')) {
            event = line.slice('event:'.length).trim();
          }
          if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trimStart());
          }
        }
        if (dataLines.length > 0) {
          frames.push({ event, data: dataLines.join('\n') });
        }
      }
    }
  })();

  if (trigger) {
    await trigger();
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await readLoop.catch(() => undefined);

  return frames;
}

export function startTurnWithoutWaiting(
  baseUrl: string,
  chatId: string,
  prompt: string,
): Promise<Response> {
  return fetch(`${baseUrl}/chats/${chatId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
}

export type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

export async function startTestServer(
  startServer: (port: number) => ServerType,
): Promise<TestServer> {
  const port = await getFreePort();
  const server = startServer(port);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl);
  return {
    baseUrl,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function getFreePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to acquire free port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForServer(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/chats`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become ready at ${baseUrl}`);
}
