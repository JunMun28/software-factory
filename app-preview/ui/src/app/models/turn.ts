import type { OrchestratorEvent, TurnHistoryEntry } from '../types/orchestrator-events';

export interface ToolActivity {
  id: string;
  name: string;
  detail?: unknown;
  expanded: boolean;
}

export interface FileChangeActivity {
  path: string;
  kind: 'created' | 'modified' | 'deleted';
}

export interface GateActivity {
  status: 'pending' | 'green' | 'red';
  output?: string;
  expanded: boolean;
}

export interface VersionActivity {
  commit: string;
  message: string;
}

export interface TurnState {
  turnId?: string;
  generationId?: string;
  prompt: string;
  narration: string;
  tools: ToolActivity[];
  fileChanges: FileChangeActivity[];
  gate?: GateActivity;
  version?: VersionActivity;
  result?: 'green' | 'red' | 'no-change' | 'error';
  running: boolean;
  startedAt?: number;
  finishedAt?: number;
  // Rehydrated from the metadata store rather than created by the current stream.
  historical?: boolean;
}

export type ActivityIcon = 'file' | 'gate' | 'terminal' | 'search' | 'spark';

// One calm, human-readable line in the turn stream — the in-UI representation
// of one or more raw orchestrator steps. Labels derive from real step data;
// nothing is fabricated.
export interface ActivityRow {
  id: string;
  icon: ActivityIcon;
  label: string;
  status?: 'running' | 'error';
  // Raw step state, present only when this row maps to a single tool so its
  // output can be revealed on expand. Grouped rows carry no detail.
  detail?: unknown;
}

export interface DesignAnnotationPresentation {
  comment: string;
  selector: string;
  tag: string;
  elementLabel: string;
}

const DESIGN_ANNOTATION_PREFIX = 'Update the element annotated in Design mode.';
const ELEMENT_LABEL_LIMIT = 36;

export function parseDesignAnnotationPrompt(
  prompt: string,
): DesignAnnotationPresentation | undefined {
  if (!prompt.startsWith(DESIGN_ANNOTATION_PREFIX)) {
    return undefined;
  }

  const selector = prompt.match(/^Selector:\s*(.+)$/m)?.[1]?.trim();
  const tag = prompt.match(/^Element:\s*<([a-zA-Z][\w-]*)>/m)?.[1];
  const currentText = prompt.match(/^Current text:\s*(.*)$/m)?.[1];
  const annotation = prompt.match(/<design_annotation\b[^>]*>([\s\S]*?)<\/design_annotation>/)?.[1];
  const comment = compactWhitespace(annotation ?? '');

  if (!selector || !tag || currentText === undefined || !comment) {
    return undefined;
  }

  const compactLabel = compactWhitespace(currentText);
  const elementLabel =
    compactLabel.length > ELEMENT_LABEL_LIMIT
      ? `${compactLabel.slice(0, ELEMENT_LABEL_LIMIT - 1)}…`
      : compactLabel;

  return { comment, selector, tag, elementLabel };
}

export function createTurn(prompt: string): TurnState {
  return {
    prompt,
    narration: '',
    tools: [],
    fileChanges: [],
    running: true,
    startedAt: Date.now(),
  };
}

export function historyEntryToTurn(entry: TurnHistoryEntry): TurnState {
  const result =
    entry.result === 'green' ||
    entry.result === 'red' ||
    entry.result === 'no-change' ||
    entry.result === 'error'
      ? entry.result
      : undefined;
  const startedAt = parseTimestamp(entry.started_at);
  const finishedAt = parseTimestamp(entry.finished_at);
  return {
    generationId: entry.generationId,
    prompt: entry.prompt,
    narration: entry.narration,
    tools: [],
    fileChanges: [],
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    gate:
      result === 'red'
        ? {
            status: 'red',
            output: entry.gate_output_tail ?? undefined,
            expanded: false,
          }
        : undefined,
    version: entry.version_commit
      ? { commit: entry.version_commit, message: entry.version_message ?? '' }
      : undefined,
    result,
    running: entry.finished_at === null && entry.result === 'running',
    historical: true,
  };
}

export function applyOrchestratorEvent(turn: TurnState, event: OrchestratorEvent): TurnState {
  switch (event.type) {
    case 'turn-started':
      return {
        ...turn,
        turnId: event.turnId,
        running: true,
      };

    case 'narration':
      return { ...turn, narration: turn.narration + event.text };

    case 'tool': {
      // OpenCode re-emits the same tool part as its state progresses;
      // upsert by part id so one call renders as one activity row.
      const id = event.id ?? `${event.name}-${turn.tools.length}`;
      const index = turn.tools.findIndex((tool) => tool.id === id);
      if (index === -1) {
        return {
          ...turn,
          tools: [...turn.tools, { id, name: event.name, detail: event.detail, expanded: false }],
        };
      }
      const tools = [...turn.tools];
      tools[index] = { ...tools[index]!, name: event.name, detail: event.detail };
      return { ...turn, tools };
    }

    case 'file-changed': {
      const index = turn.fileChanges.findIndex((file) => file.path === event.path);
      if (index === -1) {
        return {
          ...turn,
          fileChanges: [...turn.fileChanges, { path: event.path, kind: event.kind }],
        };
      }
      const fileChanges = [...turn.fileChanges];
      fileChanges[index] = { path: event.path, kind: event.kind };
      return { ...turn, fileChanges };
    }

    case 'gate-status':
      return {
        ...turn,
        gate: {
          status: event.status,
          output: event.output,
          expanded: event.status === 'red',
        },
      };

    case 'version-created':
      return {
        ...turn,
        version: { commit: event.commit, message: event.message },
      };

    case 'turn-finished':
      return {
        ...turn,
        turnId: event.turnId,
        result: event.result,
        running: false,
        finishedAt: Date.now(),
      };

    default:
      return turn;
  }
}

export function shortSha(commit: string): string {
  return commit.slice(0, 7);
}

interface ToolStateShape {
  status?: string;
  title?: string;
  input?: Record<string, unknown>;
}

// Completed-turn duration as a short human string. Null while the turn is
// still running (no finish time yet) or when timing is missing on a legacy
// row — callers hide the duration in that case.
export function turnDuration(startedAt?: number, finishedAt?: number): string | null {
  if (startedAt === undefined || finishedAt === undefined || finishedAt < startedAt) {
    return null;
  }
  const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

type ActivityKind = 'suppress' | 'explore' | 'file-created' | 'file-updated' | 'gate' | 'shell';

interface ClassifiedStep {
  kind: ActivityKind;
  icon: ActivityIcon;
  label: string;
  // Grouping key: consecutive steps with the same kind+key fold into one row.
  key: string;
  status?: 'running' | 'error';
  detail?: unknown;
}

// Map one raw tool/command step onto the calm-stream vocabulary. Every label
// derives from the real step name and its input — never invented.
function classifyStep(tool: ToolActivity): ClassifiedStep | null {
  const state = (tool.detail ?? {}) as ToolStateShape;
  const input = state.input ?? {};
  const name = tool.name.toLowerCase();
  const status = stepStatus(state.status);
  const base = { status, detail: tool.detail } as const;

  if (name.startsWith('todo')) {
    return null;
  }

  if (name === 'write') {
    const file = firstString(input, ['filePath', 'path', 'file']);
    const label = file ? `Created ${basename(file)}` : 'Created a file';
    return { kind: 'file-created', icon: 'file', label, key: file ?? label, ...base };
  }

  if (name === 'edit' || name === 'patch' || name === 'multiedit') {
    const file = firstString(input, ['filePath', 'path', 'file']);
    const label = file ? `Updated ${basename(file)}` : 'Updated a file';
    return { kind: 'file-updated', icon: 'file', label, key: file ?? label, ...base };
  }

  if (name === 'read' || name === 'grep' || name === 'glob' || name === 'list' || name === 'ls') {
    return { kind: 'explore', icon: 'search', label: 'Explored files', key: 'explore', ...base };
  }

  if (name === 'bash' || name === 'shell') {
    const command = firstString(input, ['command']) ?? '';
    if (isGateCommand(command)) {
      return { kind: 'gate', icon: 'gate', label: 'Ran quality gate', key: 'gate', ...base };
    }
    const first = command.trim().split(/\s+/)[0] ?? '';
    const label = first ? `Ran ${basename(first)}` : 'Ran a command';
    return { kind: 'shell', icon: 'terminal', label, key: command, ...base };
  }

  // Any other step (command.executed, task, webfetch, …): prefer the harness's
  // own human title, else a humanized tool name. Never a raw tool string alone.
  const title = typeof state.title === 'string' && state.title.trim() ? state.title.trim() : '';
  const command = firstString(input, ['command']);
  if (command && isGateCommand(command)) {
    return { kind: 'gate', icon: 'gate', label: 'Ran quality gate', key: 'gate', ...base };
  }
  const label = title || humanizeToolName(tool.name);
  return { kind: 'shell', icon: 'spark', label, key: `other:${tool.id}`, ...base };
}

// Fold classified steps into calm rows: suppress bookkeeping, collapse
// consecutive explores, and group consecutive edits of the same file.
export function activityRows(tools: ToolActivity[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  let group: { step: ClassifiedStep; firstId: string; statuses: Array<'running' | 'error' | undefined>; count: number } | null = null;

  const flush = () => {
    if (!group) {
      return;
    }
    const status = group.statuses.includes('error')
      ? 'error'
      : group.statuses[group.statuses.length - 1] === 'running'
        ? 'running'
        : undefined;
    rows.push({
      id: group.firstId,
      icon: group.step.icon,
      label: group.step.label,
      ...(status ? { status } : {}),
      // Only single-step rows expose raw detail; grouped rows have no single output.
      ...(group.count === 1 && group.step.detail !== undefined ? { detail: group.step.detail } : {}),
    });
    group = null;
  };

  for (const tool of tools) {
    const step = classifyStep(tool);
    if (!step) {
      continue;
    }
    const groupable = step.kind === 'explore' || step.kind === 'file-updated';
    if (group && groupable && group.step.kind === step.kind && group.step.key === step.key) {
      group.statuses.push(step.status);
      group.count += 1;
      continue;
    }
    flush();
    group = { step, firstId: tool.id, statuses: [step.status], count: 1 };
  }
  flush();

  return rows;
}

function stepStatus(status?: string): 'running' | 'error' | undefined {
  if (status === 'error') {
    return 'error';
  }
  if (status === 'running' || status === 'pending') {
    return 'running';
  }
  return undefined;
}

function isGateCommand(command: string): boolean {
  return /(^|[\s./])gate(\.sh)?(\s|$)/i.test(command);
}

function humanizeToolName(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : 'Ran a step';
}

function parseTimestamp(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
