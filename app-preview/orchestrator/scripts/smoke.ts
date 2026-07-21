import { createOrchestratorDeps } from '../src/factory.js';
import { createApp } from '../src/http/app.js';
import { serve } from '@hono/node-server';
import { parseSseResponse } from '../test/helpers.js';
import type { OrchestratorEvent } from '../src/types.js';

const PROMPT =
  "Change the main page heading from 'Golden Template' to 'Hello ng-v0'. Keep everything else. Run ./gate.sh to verify before finishing.";

async function main(): Promise<number> {
  const { config, chatStore, previewManager } = await createOrchestratorDeps();
  const app = createApp({ chatStore, previewManager });

  const server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: '127.0.0.1',
  });

  const baseUrl = `http://127.0.0.1:${config.port}`;
  console.log(`Smoke server listening on ${baseUrl}`);

  try {
    const createResponse = await fetch(`${baseUrl}/chats`, { method: 'POST' });
    if (!createResponse.ok) {
      console.error('Failed to create chat', await createResponse.text());
      return 1;
    }

    const { chatId } = (await createResponse.json()) as { chatId: string };
    console.log(`Created chat ${chatId}`);

    const turnResponse = await fetch(`${baseUrl}/chats/${chatId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: PROMPT }),
    });

    if (!turnResponse.ok) {
      console.error('Turn request failed', turnResponse.status, await turnResponse.text());
      return 1;
    }

    const { events } = await parseSseResponse(turnResponse);
    for (const event of events) {
      logEvent(event);
    }

    const finished = events.find((event) => event.type === 'turn-finished');
    const version = events.find((event) => event.type === 'version-created');

    if (finished?.type === 'turn-finished' && finished.result === 'green' && version) {
      console.log('\nSMOKE PASS: green turn with version-created');
      return 0;
    }

    console.error('\nSMOKE FAIL: missing green turn-finished or version-created');
    return 1;
  } catch (error) {
    console.error('Smoke run crashed:', error);
    return 1;
  } finally {
    server.close();
  }
}

function logEvent(event: OrchestratorEvent): void {
  switch (event.type) {
    case 'narration':
      process.stdout.write(event.text);
      return;
    case 'gate-status':
      console.log(`\n[gate-status] ${event.status}${event.output ? `\n${event.output}` : ''}`);
      return;
    case 'version-created':
      console.log(`\n[version-created] ${event.commit} ${event.message}`);
      return;
    case 'turn-finished':
      console.log(`\n[turn-finished] ${event.result}`);
      return;
    case 'tool':
      console.log(`\n[tool] ${event.name}`);
      return;
    case 'file-changed':
      console.log(`\n[file-changed] ${event.kind} ${event.path}`);
      return;
    case 'turn-started':
      console.log(`\n[turn-started] chat=${event.chatId} turn=${event.turnId}`);
      return;
    default:
      console.log('\n[event]', event);
  }
}

const code = await main();
process.exit(code);
