import path from 'node:path';
import { loadConfig } from './config.js';
import { connectionEnv } from './connection-env.js';
import { ConnectionTester } from './connection-tester.js';
import { ShellGateRunner } from './gate-runner.js';
import { ChatStore } from './chat-store.js';
import { OpenCodeHarness } from './harness/opencode-harness.js';
import { PlatformDb } from './platform-db.js';
import { PreviewManager } from './preview-manager.js';
import { LocalWorkspaceProvider } from './workspace-provider.js';
import type { GateRunner, Harness, OrchestratorConfig, WorkspaceProvider } from './types.js';

export interface OrchestratorDeps {
  config: OrchestratorConfig;
  chatStore: ChatStore;
  previewManager: PreviewManager;
  platformDb: PlatformDb;
}

export async function createOrchestratorDeps(options?: {
  config?: Partial<OrchestratorConfig>;
  harness?: Harness;
  gateRunner?: GateRunner;
  workspaceProvider?: WorkspaceProvider;
  previewManager?: PreviewManager;
  platformDb?: PlatformDb;
  connectionTester?: ConnectionTester;
}): Promise<OrchestratorDeps> {
  const config = loadConfig(options?.config);
  const workspaceProvider =
    options?.workspaceProvider ??
    new LocalWorkspaceProvider(config.templatePath, config.workspacesRoot);
  const gateRunner =
    options?.gateRunner ??
    new ShellGateRunner({
      timeoutMs: config.gateTimeoutMs,
      sourceGatePath: path.join(config.templatePath, 'gate.sh'),
      trustedGatePath: path.join(config.trustedRoot, 'gate.sh'),
    });
  const harness =
    options?.harness ?? new OpenCodeHarness({ model: config.opencodeModel });
  const platformDb = options?.platformDb ?? await PlatformDb.open(config.dbTarget);
  const connectionTester = options?.connectionTester ?? new ConnectionTester();
  const chatStore = new ChatStore(
    workspaceProvider,
    harness,
    gateRunner,
    platformDb,
    connectionTester,
  );
  const restored = await chatStore.rehydrate();
  if (restored > 0) {
    console.log(`Rehydrated ${restored} chat(s) from ${config.dbTarget}`);
  }
  const previewManager =
    options?.previewManager ??
    new PreviewManager({
      workspacesRoot: config.workspacesRoot,
      previewRoot: config.previewRoot,
      connectionEnv: (chatId) => connectionEnv(platformDb, chatId),
    });

  return { config, chatStore, previewManager, platformDb };
}
