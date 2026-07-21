import { serve } from '@hono/node-server';
import { createOrchestratorDeps } from './factory.js';
import { createApp } from './http/app.js';

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection; orchestrator remains available:', reason);
});

process.on('uncaughtException', (error, origin) => {
  console.error(
    `Uncaught exception (${origin}); orchestrator remains available:`,
    error,
  );
});

const { config, chatStore, previewManager } = await createOrchestratorDeps();
const app = createApp({ chatStore, previewManager });

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down preview servers…`);
  previewManager.dispose();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

serve(
  {
    fetch: app.fetch,
    port: config.port,
    // ADR-0011 defines the current orchestrator as local-only.
    hostname: config.hostname,
  },
  (info) => {
    console.log(`Orchestrator listening on http://${config.hostname}:${info.port}`);
  },
);
