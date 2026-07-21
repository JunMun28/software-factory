import { serve } from '@hono/node-server';
import { createOrchestratorDeps } from './factory.js';
import { createApp } from './http/app.js';
import { tunnelUpgrade } from './preview-bridge.js';

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

/** Give sandbox teardown this long before exiting anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down preview servers…`);
  // Await it: dispose() deletes each chat's sandbox Deployment, and exiting
  // first orphaned every one of them (plans/013). Bounded so a wedged k8s API
  // call cannot hold the pod past its grace period.
  await Promise.race([
    previewManager.dispose(),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]).catch((error) => {
    console.error('Preview teardown failed during shutdown:', error);
  });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const server = serve(
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

// Host-routed kube previews: the dev server's HMR/live-reload WebSocket arrives
// as an upgrade on the main server. Route it to the matching sandbox by Host,
// reusing the same tunnel as the local per-chat bridge. Non-preview upgrades
// (none in local mode) are closed.
server.on('upgrade', (req, socket, head) => {
  const target = previewManager.resolvePreviewTarget(req.headers.host);
  if (target) {
    tunnelUpgrade(target, req, socket, head);
  } else {
    socket.destroy();
  }
});
