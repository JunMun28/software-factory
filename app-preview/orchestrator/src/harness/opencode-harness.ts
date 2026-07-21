import {
  createOpencodeClient,
  createOpencodeServer,
  type Event,
} from '@opencode-ai/sdk';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  Harness,
  HarnessSession,
  ModelCatalog,
  OrchestratorEvent,
} from '../types.js';

const execFileAsync = promisify(execFile);

// The Platform runs OpenCode in a hermetic sandbox: no user-global config,
// skills, or CLAUDE.md can reach a generated-app workspace. The Prototype
// must match, or the operator's own agent setup leaks into every chat and
// changes model behavior (observed: a global "wait for OK" instruction made
// turns end with no changes). XDG_CONFIG_HOME hides ~/.config/opencode; the
// two flags stop OpenCode's Claude Code compatibility loaders. Auth lives in
// the data dir and is unaffected.
const HERMETIC_ENV: Record<string, string> = {
  XDG_CONFIG_HOME: path.join(os.tmpdir(), 'ng-v0-opencode-config'),
  OPENCODE_DISABLE_CLAUDE_CODE: 'true',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
};

// createOpencodeServer spawns its child process in the synchronous prefix of
// the call, so the hermetic env only needs to be present while fn() starts.
// Restoring before the returned promise settles keeps gate runs and preview
// servers (which spawn from the same process) on the normal environment.
async function withHermeticEnv<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(HERMETIC_ENV.XDG_CONFIG_HOME, { recursive: true });
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(HERMETIC_ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

interface OpenCodeHarnessOptions {
  model?: string;
}

export class OpenCodeHarness implements Harness {
  private modelCatalogPromise?: Promise<ModelCatalog>;

  constructor(private readonly options: OpenCodeHarnessOptions = {}) {}

  listModels(): Promise<ModelCatalog> {
    // A rejected promise must not stick around forever: cache success, but
    // clear the slot on failure so the next call retries instead of
    // replaying the same transient error until the process restarts.
    this.modelCatalogPromise ??= loadModelCatalog().catch((error: unknown) => {
      this.modelCatalogPromise = undefined;
      throw error;
    });
    return this.modelCatalogPromise;
  }

  async startSession(workspaceDir: string): Promise<HarnessSession> {
    // port 0 = ephemeral: the SDK default (4096) is fixed, so a second live
    // chat could never start a server while an earlier chat still held it.
    const server = await withHermeticEnv(() =>
      createOpencodeServer({
        port: 0,
        timeout: 60_000,
      }),
    );
    const client = createOpencodeClient({
      baseUrl: server.url,
      directory: workspaceDir,
    });

    const created = await client.session.create({
      body: { title: 'ng-v0 chat session' },
    });
    if (!created.data) {
      server.close();
      throw new Error('Failed to create OpenCode session');
    }

    return new OpenCodeHarnessSession({
      workspaceDir,
      client,
      server,
      sessionId: created.data.id,
      model: this.options.model,
    });
  }
}

class OpenCodeHarnessSession implements HarnessSession {
  constructor(
    private readonly ctx: {
      workspaceDir: string;
      client: ReturnType<typeof createOpencodeClient>;
      server: { close(): void };
      sessionId: string;
      model?: string;
    },
  ) {}

  async *sendTurn(
    prompt: string,
    selectedModel?: string,
  ): AsyncIterable<OrchestratorEvent> {
    const { workspaceDir, client, sessionId } = this.ctx;
    const activeModel = selectedModel ?? this.ctx.model;
    const statusBefore = await gitPorcelain(workspaceDir);
    const events = await client.event.subscribe();
    const promptPromise = client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
        ...(activeModel ? parseModel(activeModel) : {}),
      },
    });
    void promptPromise.catch((error: unknown) => {
      console.error('OpenCode prompt failed:', error);
    });

    let sawIdle = false;
    const eventContext = createTurnEventContext(workspaceDir);
    const { emittedFiles } = eventContext;

    for await (const event of events.stream) {
      for (const mapped of mapOpenCodeEvent(event, eventContext)) {
        yield mapped;
      }

      if (event.type === 'session.idle' && event.properties.sessionID === sessionId) {
        sawIdle = true;
        break;
      }
      if (
        event.type === 'session.error' &&
        event.properties.sessionID === sessionId
      ) {
        const message =
          stringifyError(event.properties.error) ?? 'OpenCode session error';
        throw new Error(message);
      }
    }

    await promptPromise;

    if (!sawIdle) {
      await waitForSessionIdle(client, sessionId);
    }

    const statusAfter = await gitPorcelain(workspaceDir);
    for (const fileEvent of diffPorcelain(statusBefore, statusAfter)) {
      if (
        fileEvent.type === 'file-changed' &&
        !emittedFiles.has(fileEvent.path)
      ) {
        yield fileEvent;
      }
    }
  }

  async dispose(): Promise<void> {
    this.ctx.server.close();
  }
}

async function loadModelCatalog(): Promise<ModelCatalog> {
  const { stdout } = await execFileAsync('opencode', ['models'], {
    env: { ...process.env, ...HERMETIC_ENV },
    maxBuffer: 4 * 1024 * 1024,
  });
  const ids = [...new Set(stdout.split('\n').map((line) => line.trim()).filter(Boolean))];
  return {
    models: ids.map((id) => {
      const slash = id.indexOf('/');
      return {
        id,
        provider: slash === -1 ? 'openai' : id.slice(0, slash),
        name: slash === -1 ? id : id.slice(slash + 1),
      };
    }),
  };
}

export interface TurnEventContext {
  emittedFiles: Set<string>;
  assistantMessages: Set<string>;
  // Text parts can arrive as full-part updates without a delta; track how
  // much of each part has already been narrated so only the increment flows.
  textProgress: Map<string, number>;
  // Workspace root for relativizing watcher paths; events outside it (or in
  // ignored dirs like .git) never reach clients.
  workspaceDir?: string;
  lastTextPartId?: string;
}

export function createTurnEventContext(workspaceDir?: string): TurnEventContext {
  return {
    emittedFiles: new Set(),
    assistantMessages: new Set(),
    textProgress: new Map(),
    workspaceDir,
  };
}

// Watcher events cover everything under the workspace, including git's own
// bookkeeping and dependency trees; none of that is a user-visible change.
const IGNORED_FILE_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.angular',
  '.venv',
  '__pycache__',
]);

function normalizeWorkspacePath(
  file: string,
  workspaceDir: string | undefined,
): string | null {
  let relative = file;
  if (path.isAbsolute(file)) {
    if (!workspaceDir) {
      return null;
    }
    relative = path.relative(workspaceDir, file);
  }
  if (!relative || relative.startsWith('..')) {
    return null;
  }
  for (const segment of relative.split(path.sep)) {
    if (IGNORED_FILE_SEGMENTS.has(segment)) {
      return null;
    }
  }
  return relative.split(path.sep).join('/');
}

export function mapOpenCodeEvent(
  event: Event,
  context: TurnEventContext,
): OrchestratorEvent[] {
  const mapped: OrchestratorEvent[] = [];
  const { emittedFiles } = context;

  if (event.type === 'message.updated') {
    if (event.properties.info.role === 'assistant') {
      context.assistantMessages.add(event.properties.info.id);
    }
  }

  if (event.type === 'message.part.updated') {
    const { part, delta } = event.properties;
    if (
      part.type === 'text' &&
      !part.synthetic &&
      context.assistantMessages.has(part.messageID)
    ) {
      const seen = context.textProgress.get(part.id) ?? 0;
      let text = delta ?? part.text.slice(seen);
      context.textProgress.set(part.id, part.text.length);
      if (text) {
        // Distinct text parts are separate paragraphs; without a break they
        // render glued together ("…quality gate.The existing home screen…").
        if (context.lastTextPartId && context.lastTextPartId !== part.id) {
          text = `\n\n${text}`;
        }
        context.lastTextPartId = part.id;
        mapped.push({ type: 'narration', text });
      }
    }
    if (part.type === 'tool') {
      mapped.push({
        type: 'tool',
        id: part.id,
        name: part.tool,
        detail: part.state,
      });
    }
  }

  if (event.type === 'file.edited') {
    const file = normalizeWorkspacePath(
      event.properties.file,
      context.workspaceDir,
    );
    if (file) {
      emittedFiles.add(file);
      mapped.push({ type: 'file-changed', path: file, kind: 'modified' });
    }
  }

  if (event.type === 'file.watcher.updated') {
    const file = normalizeWorkspacePath(
      event.properties.file,
      context.workspaceDir,
    );
    if (file) {
      const kind =
        event.properties.event === 'add'
          ? 'created'
          : event.properties.event === 'unlink'
            ? 'deleted'
            : 'modified';
      emittedFiles.add(file);
      mapped.push({ type: 'file-changed', path: file, kind });
    }
  }

  if (event.type === 'command.executed') {
    mapped.push({
      type: 'tool',
      name: event.properties.name,
      detail: event.properties.arguments,
    });
  }

  return mapped;
}

function parseModel(model: string): {
  model: { providerID: string; modelID: string };
} {
  const slash = model.indexOf('/');
  if (slash === -1) {
    return { model: { providerID: 'openai', modelID: model } };
  }
  return {
    model: {
      providerID: model.slice(0, slash),
      modelID: model.slice(slash + 1),
    },
  };
}

async function gitPorcelain(workspaceDir: string): Promise<Map<string, string>> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', workspaceDir, 'status', '--porcelain'],
    { maxBuffer: 1024 * 1024 },
  );
  const map = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const status = line.slice(0, 2);
    const file = line.slice(3).trim();
    map.set(file, status);
  }
  return map;
}

function diffPorcelain(
  before: Map<string, string>,
  after: Map<string, string>,
): OrchestratorEvent[] {
  const events: OrchestratorEvent[] = [];
  for (const [file] of after) {
    if (!before.has(file)) {
      events.push({ type: 'file-changed', path: file, kind: 'created' });
    } else if (before.get(file) !== after.get(file)) {
      events.push({ type: 'file-changed', path: file, kind: 'modified' });
    }
  }
  for (const [file] of before) {
    if (!after.has(file)) {
      events.push({ type: 'file-changed', path: file, kind: 'deleted' });
    }
  }
  return events;
}

function stringifyError(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  if ('data' in error && error.data && typeof error.data === 'object') {
    const data = error.data as { message?: string };
    if (data.message) {
      return data.message;
    }
  }
  if ('message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return JSON.stringify(error);
}

async function waitForSessionIdle(
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await client.session.status();
    const sessions = status.data ?? {};
    const current = sessions[sessionId];
    if (!current || current.type === 'idle') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
