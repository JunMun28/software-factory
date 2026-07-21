export type OrchestratorEvent =
  | { type: 'turn-started'; chatId: string; turnId: string }
  | { type: 'narration'; text: string }
  | { type: 'tool'; name: string; detail?: unknown; id?: string }
  | { type: 'file-changed'; path: string; kind: 'created' | 'modified' | 'deleted' }
  | { type: 'gate-status'; status: 'pending' | 'green' | 'red'; output?: string }
  | { type: 'version-created'; commit: string; message: string }
  | { type: 'turn-finished'; turnId: string; result: 'green' | 'red' | 'no-change' };

export type PreviewStatusValue = 'stopped' | 'starting' | 'ready' | 'failed';

export interface PreviewStatus {
  status: PreviewStatusValue;
  url?: string;
  error?: string;
}

export type ChatLevelEvent = {
  type: 'preview-status';
  status: PreviewStatusValue;
  url?: string;
  error?: string;
};

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

export interface ChatVersion {
  id: string;
  seq: number;
  commit: string;
  message: string;
  restoredFromVersionId: string | null;
  createdAt: string;
  // Change summary computed once at version-cut time (git diff vs the parent
  // commit). Null on legacy rows cut before this was tracked, or when the
  // diffstat computation failed. Null => render the chip without numbers.
  diffStat: VersionDiffStat | null;
  files: VersionFileChange[] | null;
}

export interface VersionDiffFile {
  path: string;
  status: 'created' | 'modified' | 'deleted';
  diff: string;
}

export interface ChatSummary {
  chatId: string;
  projectId: string;
  title: string | null;
  status: 'idle' | 'running';
  versions: VersionInfo[];
  // Seed provenance (ng-v0 bridge): where this chat's workspace was cloned from,
  // so the header can show "seeded from REQ-2136". Absent/null for template chats.
  seedUrl?: string | null;
  seedRef?: string | null;
}

export interface ChatDetail extends ChatSummary {
  turnRunning: boolean;
  runningGenerationId: string | null;
}

export interface TurnHistoryEntry {
  turn_number: number;
  generationId: string;
  prompt: string;
  narration: string;
  result: string;
  gate_output_tail: string | null;
  started_at: string;
  finished_at: string | null;
  version_commit: string | null;
  version_message: string | null;
}

export interface CreateChatResponse {
  chatId: string;
}
