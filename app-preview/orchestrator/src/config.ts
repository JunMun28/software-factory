import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrchestratorConfig } from './types.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

export function loadConfig(
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  // The golden template is NOT vendored under app-preview — the factory already
  // tracks the one true copy at <repo-root>/templates/golden (see VENDORED.md),
  // so a second copy would drift silently. repoRoot is app-preview, so its
  // parent is the factory repo root.
  //
  // Honour a platformDbPath override here so dbTarget derives from it: tests
  // point platformDbPath at a temp file and expect the store to follow.
  const platformDbPath =
    overrides.platformDbPath ??
    process.env.PLATFORM_DB_PATH ??
    path.join(repoRoot, 'orchestrator', 'var', 'platform.db');
  return {
    port: Number(process.env.PORT ?? 7071),
    hostname: process.env.ORCHESTRATOR_HOSTNAME ?? '127.0.0.1',
    templatePath:
      process.env.TEMPLATE_PATH ??
      path.resolve(repoRoot, '..', 'templates', 'golden'),
    workspacesRoot:
      process.env.WORKSPACES_ROOT ??
      path.join(repoRoot, 'orchestrator', 'var', 'chats'),
    previewRoot:
      process.env.PREVIEW_ROOT ??
      path.join(repoRoot, 'orchestrator', 'var', 'preview'),
    trustedRoot:
      process.env.TRUSTED_ROOT ??
      path.join(repoRoot, 'orchestrator', 'var', 'trusted'),
    platformDbPath,
    // dbTarget is what PlatformDb actually opens. APPVIEW_DB_URL (an
    // `mssql://server/database` URL) moves the store to Azure SQL; without it
    // we fall back to the local SQLite path, so PLATFORM_DB_PATH keeps working.
    // A caller can still override dbTarget directly via `overrides` below.
    dbTarget: process.env.APPVIEW_DB_URL ?? platformDbPath,
    gateTimeoutMs: 15 * 60 * 1000,
    opencodeModel: process.env.OPENCODE_MODEL,
    ...overrides,
  };
}
