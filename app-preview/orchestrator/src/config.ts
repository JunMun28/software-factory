import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrchestratorConfig } from './types.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** Parse a non-negative integer env var, falling back to `fallback` when unset
 * or unparseable. Guards against a stray `APPVIEW_SANDBOX_MAX=""` disabling the
 * cap by accident. */
function numberFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

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
    // Default local so nothing changes off-cluster; set APPVIEW_SANDBOX=kube
    // in-cluster to run each chat's dev server as a pod.
    sandboxMode: process.env.APPVIEW_SANDBOX === 'kube' ? 'kube' : 'local',
    // Dev-server sandboxes are expensive, so guard them: idle GC + a global
    // concurrency cap. Defaults keep live sandboxes bounded without any config.
    sandboxIdleTtlMs: numberFromEnv(
      process.env.APPVIEW_SANDBOX_IDLE_TTL_MS,
      30 * 60 * 1000,
    ),
    sandboxIdleSweepMs: numberFromEnv(
      process.env.APPVIEW_SANDBOX_IDLE_SWEEP_MS,
      60 * 1000,
    ),
    sandboxMaxLive: numberFromEnv(process.env.APPVIEW_SANDBOX_MAX, 5),
    // Host-routed kube previews (see types.ts). Empty domain = disabled, so
    // off-cluster/local keeps the per-chat localhost bridge. Empty port omits
    // the `:port` from the browser-facing URL (i.e. default 80).
    previewDomain: process.env.APPVIEW_PREVIEW_DOMAIN ?? '',
    previewExternalPort: process.env.APPVIEW_PREVIEW_PORT ?? '',
    ...overrides,
  };
}
