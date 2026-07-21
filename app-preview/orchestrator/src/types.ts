import type { DashboardBlueprint } from './blueprints/types.js';

export type OrchestratorEvent =
  | { type: 'turn-started'; chatId: string; turnId: string }
  | { type: 'narration'; text: string }
  | { type: 'tool'; name: string; detail?: unknown; id?: string }
  | { type: 'file-changed'; path: string; kind: 'created' | 'modified' | 'deleted' }
  | { type: 'gate-status'; status: 'pending' | 'green' | 'red'; output?: string }
  | { type: 'version-created'; commit: string; message: string }
  | { type: 'turn-finished'; turnId: string; result: 'green' | 'red' | 'no-change' };

export interface HarnessSession {
  sendTurn(prompt: string, model?: string): AsyncIterable<OrchestratorEvent>;
  dispose(): Promise<void>;
}

export interface ModelOption {
  id: string;
  provider: string;
  name: string;
}

export interface ModelCatalog {
  models: ModelOption[];
}

export interface Harness {
  listModels(): Promise<ModelCatalog>;
  startSession(workspaceDir: string): Promise<HarnessSession>;
}

export interface GateRunner {
  run(workspaceDir: string): Promise<{ green: boolean; output: string }>;
}

// A chat can be born from an existing repo state (ng-v0 bridge piece 1) instead
// of the golden template: the workspace is cloned/fetched from `url` at `ref`
// rather than copied from the blueprint.
export interface WorkspaceSeed {
  kind: 'git';
  url: string;
  ref: string;
}

export interface WorkspaceProvider {
  create(chatId: string, seed?: WorkspaceSeed): Promise<string>;
}

export interface VersionInfo {
  commit: string;
  message: string;
}

export interface VersionDiffStat {
  additions: number;
  deletions: number;
}

export interface VersionFileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

export interface VersionDetails {
  id: string;
  seq: number;
  commit: string;
  message: string;
  restoredFromVersionId: string | null;
  createdAt: string;
  // Change summary computed once at version-cut time (git diff vs the parent
  // commit). Null on legacy rows cut before this was tracked, or when the
  // diffstat computation failed (never fails the version cut).
  diffStat: VersionDiffStat | null;
  files: VersionFileChange[] | null;
}

export interface BlueprintRevisionDetails {
  id: string;
  revision: number;
  blueprint: DashboardBlueprint;
  approved: boolean;
  approvedAt: string | null;
  createdAt: string;
}

export interface ChatSummary {
  chatId: string;
  projectId: string;
  title: string | null;
  status: 'idle' | 'running';
  turnRunning: boolean;
  runningGenerationId: string | null;
  versions: VersionInfo[];
  // Seed provenance (null for template-born chats): where this chat's workspace
  // was cloned from, so a UI can show "seeded from REQ-2136".
  seedUrl: string | null;
  seedRef: string | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  isDefault: boolean;
  chatCount: number;
  createdAt: string;
}

export interface ProjectDetails extends ProjectSummary {
  chats: ChatSummary[];
}

export interface OrchestratorConfig {
  port: number;
  hostname: string;
  templatePath: string;
  workspacesRoot: string;
  previewRoot: string;
  trustedRoot: string;
  platformDbPath: string;
  // The database PlatformDb opens: a SQLite path or an `mssql://` URL. Defaults
  // to platformDbPath; APPVIEW_DB_URL overrides it (see config.ts).
  dbTarget: string;
  gateTimeoutMs: number;
  opencodeModel?: string;
}

export type PreviewStatusValue = 'stopped' | 'starting' | 'ready' | 'failed';

export interface PreviewStatus {
  status: PreviewStatusValue;
  url?: string;
  error?: string;
}

export type ChatLevelEvent =
  | { type: 'preview-status'; status: PreviewStatusValue; url?: string; error?: string };

export const BASELINE_COMMIT_MESSAGE = 'Baseline: Golden Template';

export const TEMPLATE_EXCLUDES = new Set([
  'node_modules',
  'dist',
  '.venv',
  '.angular',
  'app.db',
]);
