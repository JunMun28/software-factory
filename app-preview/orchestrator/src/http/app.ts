import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  ChatBusyError,
  ChatNotFoundError,
  ProjectNotFoundError,
  SeedGateFailedError,
  VersionNotFoundError,
  type ChatStore,
} from '../chat-store.js';
import type { PreviewManager } from '../preview-manager.js';
import type {
  ChatLevelEvent,
  OrchestratorEvent,
  WorkspaceSeed,
} from '../types.js';
import { inspectWorkspaceDatabase } from '../workspace-database.js';
import {
  WorkspacePathError,
  getWorkspaceFileDiff,
  listWorkspaceFiles,
  readWorkspaceFileContent,
} from '../workspace-files.js';

export interface AppDeps {
  chatStore: ChatStore;
  previewManager: PreviewManager;
}

export function createApp({ chatStore, previewManager }: AppDeps): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    const mapped = mapDomainError(error);
    if (mapped) {
      return c.json({ error: mapped.message }, mapped.status);
    }
    console.error(error);
    return c.text('Internal Server Error', 500);
  });

  app.get('/models', async (c) => {
    try {
      return c.json(await chatStore.listModels());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model catalog unavailable';
      return c.json({ error: message }, 503);
    }
  });

  app.get('/projects', async (c) => {
    return c.json(await chatStore.listProjects());
  });

  app.post('/projects', async (c) => {
    let body: { name?: unknown };
    try {
      body = await c.req.json<{ name?: unknown }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return c.json({ error: 'name is required' }, 400);
    }
    return c.json(await chatStore.createProject(name), 201);
  });

  app.get('/projects/:projectId', async (c) => {
    const project = await chatStore.getProject(c.req.param('projectId'));
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }
    return c.json(project);
  });

  app.post('/chats', async (c) => {
    let body: { projectId?: unknown; title?: unknown; seed?: unknown } = {};
    if (c.req.header('Content-Type')?.includes('application/json')) {
      try {
        body = await c.req.json<{
          projectId?: unknown;
          title?: unknown;
          seed?: unknown;
        }>();
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
    }
    if (body.projectId !== undefined && typeof body.projectId !== 'string') {
      return c.json({ error: 'projectId must be a string' }, 400);
    }
    if (body.title !== undefined && typeof body.title !== 'string') {
      return c.json({ error: 'title must be a string' }, 400);
    }
    const projectId = body.projectId?.trim();
    if (body.projectId !== undefined && !projectId) {
      return c.json({ error: 'projectId must not be empty' }, 400);
    }
    let seed: WorkspaceSeed | undefined;
    if (body.seed !== undefined) {
      const parsed = parseSeed(body.seed);
      if ('error' in parsed) {
        return c.json({ error: parsed.error }, 400);
      }
      seed = parsed.seed;
    }
    try {
      const chatId = await chatStore.createChat({
        projectId,
        title: body.title?.trim() || undefined,
        seed,
      });
      return c.json({ chatId }, 201);
    } catch (error) {
      // A red seed gate is a client-fixable condition, not a server fault:
      // answer 422 with the gate tail so the requester can repair the app.
      if (error instanceof SeedGateFailedError) {
        return c.json({ error: 'Seed gate failed', gateOutput: error.output }, 422);
      }
      throw error;
    }
  });

  app.get('/chats', async (c) => {
    const chats = await chatStore.listChats();
    return c.json(chats);
  });

  app.get('/chats/:chatId', async (c) => {
    const chatId = c.req.param('chatId');
    const chat = await chatStore.getChat(chatId);
    if (!chat) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    return c.json(chat);
  });

  app.patch('/chats/:chatId', async (c) => {
    let body: { title?: unknown };
    try {
      body = await c.req.json<{ title?: unknown }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return c.json({ error: 'title is required' }, 400);
    }
    return c.json(
      await chatStore.renameChat(c.req.param('chatId'), body.title.trim()),
    );
  });

  app.delete('/chats/:chatId', async (c) => {
    const chatId = c.req.param('chatId');
    await chatStore.assertIdle(chatId);
    await previewManager.remove(chatId);
    await chatStore.deleteChat(chatId);
    return c.body(null, 204);
  });

  app.get('/chats/:chatId/versions', async (c) => {
    const versions = await chatStore.listVersions(c.req.param('chatId'));
    if (!versions) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    return c.json(versions);
  });

  app.post('/chats/:chatId/versions/:versionId/restore', async (c) => {
    const version = await chatStore.restoreVersion(
      c.req.param('chatId'),
      c.req.param('versionId'),
    );
    return c.json(version, 201);
  });

  app.post('/chats/:chatId/versions/:versionId/fork', async (c) => {
    const chatId = await chatStore.forkVersion(
      c.req.param('chatId'),
      c.req.param('versionId'),
    );
    return c.json({ chatId }, 201);
  });

  app.get('/chats/:chatId/versions/:versionId/diff', async (c) => {
    const files = await chatStore.getVersionDiff(
      c.req.param('chatId'),
      c.req.param('versionId'),
    );
    return c.json({ files });
  });

  app.post('/chats/:chatId/versions/:versionId/export', async (c) => {
    // 404s (unknown chat / version not in chat) flow through onError.
    const result = await chatStore.exportVersion(
      c.req.param('chatId'),
      c.req.param('versionId'),
    );
    return c.json(result);
  });

  app.get('/chats/:chatId/turns', async (c) => {
    const chatId = c.req.param('chatId');
    const turns = await chatStore.listTurnHistory(chatId);
    if (!turns) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    return c.json({ turns });
  });

  app.get('/chats/:chatId/blueprints', async (c) => {
    const revisions = await chatStore.listBlueprintRevisions(
      c.req.param('chatId'),
    );
    if (!revisions) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    return c.json({ revisions });
  });

  app.post('/chats/:chatId/blueprints', async (c) => {
    const chatId = c.req.param('chatId');
    if (!chatStore.hasChat(chatId)) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const result = await chatStore.createBlueprintRevision(chatId, body);
    if (!result.ok) {
      return c.json({ errors: result.errors }, 422);
    }
    return c.json(result.revision, 201);
  });

  app.post('/chats/:chatId/blueprints/:revisionId/approve', async (c) => {
    const chatId = c.req.param('chatId');
    if (!chatStore.hasChat(chatId)) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    const revision = await chatStore.approveBlueprintRevision(
      chatId,
      c.req.param('revisionId'),
    );
    if (!revision) {
      return c.json({ error: 'Blueprint revision not found' }, 404);
    }
    return c.json(revision, 200);
  });

  app.get('/chats/:chatId/connections', async (c) => {
    const connections = await chatStore.listConnections(c.req.param('chatId'));
    if (connections === null) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    return c.json({ connections });
  });

  app.post('/chats/:chatId/connections', async (c) => {
    const chatId = c.req.param('chatId');
    if (!chatStore.hasChat(chatId)) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const result = await chatStore.createConnection(chatId, body);
    if (!result.ok) {
      return c.json({ errors: result.errors }, 422);
    }
    if (previewManager.status(chatId).status !== 'stopped') {
      void previewManager.restart(chatId);
    }
    return c.json(result.connection, 201);
  });

  app.delete('/chats/:chatId/connections/:name', async (c) => {
    const chatId = c.req.param('chatId');
    const result = await chatStore.deleteConnection(
      chatId,
      c.req.param('name'),
    );
    if (result === null) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    if (!result) {
      return c.json({ error: 'Connection not found' }, 404);
    }
    if (previewManager.status(chatId).status !== 'stopped') {
      void previewManager.restart(chatId);
    }
    return c.body(null, 204);
  });

  app.post('/chats/:chatId/connections/:name/test', async (c) => {
    const chatId = c.req.param('chatId');
    if (!chatStore.hasChat(chatId)) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    const result = await chatStore.testConnection(
      chatId,
      c.req.param('name'),
    );
    if (result === null) {
      return c.json({ error: 'Connection not found' }, 404);
    }
    return c.json(result);
  });

  app.get('/chats/:chatId/generations/:generationId/events', async (c) => {
    const chatId = c.req.param('chatId');
    const generationId = c.req.param('generationId');
    if (!chatStore.hasChat(chatId)) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    if (!(await chatStore.hasGeneration(chatId, generationId))) {
      return c.json({ error: 'Generation not found' }, 404);
    }

    const sinceValue = c.req.query('since') ?? '0';
    if (!/^\d+$/.test(sinceValue)) {
      return c.json({ error: 'since must be a non-negative integer' }, 400);
    }
    const since = Number(sinceValue);
    if (!Number.isSafeInteger(since)) {
      return c.json({ error: 'since must be a non-negative integer' }, 400);
    }

    return streamSSE(c, async (stream) => {
      const abortController = new AbortController();
      stream.onAbort(() => abortController.abort());
      const heartbeat = setInterval(async () => {
        await stream.write(': heartbeat\n\n');
      }, 15_000);
      try {
        for await (const persisted of chatStore.observeTurnEvents(
          chatId,
          generationId,
          since,
          abortController.signal,
        )) {
          await stream.writeSSE({
            event: persisted.event.type,
            data: JSON.stringify(persisted.event),
            id: String(persisted.seq),
          });
        }
      } finally {
        clearInterval(heartbeat);
        abortController.abort();
      }
    });
  });

  app.get('/chats/:chatId/preview', (c) => {
    const chatId = c.req.param('chatId');
    if (!chatStore.hasChat(chatId)) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    return c.json(previewManager.status(chatId));
  });

  app.post('/chats/:chatId/preview', async (c) => {
    const chatId = c.req.param('chatId');
    if (!chatStore.hasChat(chatId)) {
      return c.json({ error: 'Chat not found' }, 404);
    }

    const current = previewManager.status(chatId);
    if (current.status === 'failed') {
      void previewManager.restart(chatId);
    } else {
      void previewManager.ensure(chatId);
    }

    return c.json(previewManager.status(chatId), 202);
  });

  app.get('/chats/:chatId/events', (c) => {
    const chatId = c.req.param('chatId');
    if (!chatStore.hasChat(chatId)) {
      return c.json({ error: 'Chat not found' }, 404);
    }

    return streamSSE(c, async (stream) => {
      let currentStatus = previewManager.status(chatId);
      await stream.writeSSE({
        event: 'preview-status',
        data: JSON.stringify(toPreviewStatusEvent(currentStatus)),
      });

      const unsubscribe = previewManager.subscribe(chatId, async (status) => {
        if (
          status.status === currentStatus.status &&
          status.url === currentStatus.url &&
          status.error === currentStatus.error
        ) {
          return;
        }
        currentStatus = status;
        await stream.writeSSE({
          event: 'preview-status',
          data: JSON.stringify(toPreviewStatusEvent(status)),
        });
      });

      const heartbeat = setInterval(async () => {
        await stream.write(': heartbeat\n\n');
      }, 15_000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        });
      });
    });
  });

  app.get('/chats/:chatId/files', async (c) => {
    const chatId = c.req.param('chatId');
    const workspaceDir = chatStore.getWorkspaceDir(chatId);
    if (!workspaceDir) {
      return c.json({ error: 'Chat not found' }, 404);
    }

    const files = await listWorkspaceFiles(workspaceDir);
    return c.json({ files });
  });

  app.get('/chats/:chatId/files/content', async (c) => {
    const chatId = c.req.param('chatId');
    const workspaceDir = chatStore.getWorkspaceDir(chatId);
    if (!workspaceDir) {
      return c.json({ error: 'Chat not found' }, 404);
    }

    const filePath = c.req.query('path');
    if (!filePath) {
      return c.json({ error: 'path is required' }, 400);
    }

    try {
      const content = await readWorkspaceFileContent(workspaceDir, filePath);
      return c.json({ path: filePath.replace(/\\/g, '/'), content });
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  app.get('/chats/:chatId/files/diff', async (c) => {
    const chatId = c.req.param('chatId');
    const workspaceDir = chatStore.getWorkspaceDir(chatId);
    if (!workspaceDir) {
      return c.json({ error: 'Chat not found' }, 404);
    }

    const filePath = c.req.query('path');
    if (!filePath) {
      return c.json({ error: 'path is required' }, 400);
    }

    try {
      const diff = await getWorkspaceFileDiff(workspaceDir, filePath);
      return c.json({ path: filePath.replace(/\\/g, '/'), diff });
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  app.get('/chats/:chatId/database', async (c) => {
    const chatId = c.req.param('chatId');
    const workspaceDir = chatStore.getWorkspaceDir(chatId);
    if (!workspaceDir) {
      return c.json({ error: 'Chat not found' }, 404);
    }

    return c.json(await inspectWorkspaceDatabase(workspaceDir));
  });

  app.post('/chats/:chatId/turns', async (c) => {
    const chatId = c.req.param('chatId');
    const validated = await validateTurnLikeRequest(c, chatStore, chatId);
    if ('response' in validated) {
      return validated.response;
    }
    const { prompt, model } = validated;
    chatStore.beginTurn(chatId);
    const turnId = crypto.randomUUID();

    return streamTurnLike(
      c,
      toTurnFrames(chatStore.runTurn(chatId, prompt, model)),
      (error) => {
        if (error instanceof ChatNotFoundError || error instanceof ChatBusyError) {
          return [errorFrame(error)];
        }
        const message = error instanceof Error ? error.message : String(error);
        const failure: OrchestratorEvent[] = [
          { type: 'turn-started', chatId, turnId },
          { type: 'gate-status', status: 'red', output: message },
          { type: 'turn-finished', turnId, result: 'red' },
        ];
        return failure.map((event) => ({ event: event.type, data: event }));
      },
    );
  });

  return app;
}

interface TurnLikeRequestBody {
  prompt?: unknown;
  model?: unknown;
}

interface TurnLikeInput {
  prompt: string;
  model?: string;
}

interface SseFrame {
  event: string;
  data: unknown;
  id?: string;
}

async function validateTurnLikeRequest(
  c: Context,
  chatStore: ChatStore,
  chatId: string,
): Promise<TurnLikeInput | { response: Response }> {
  let body: TurnLikeRequestBody;
  try {
    body = await c.req.json<TurnLikeRequestBody>();
  } catch {
    return { response: c.json({ error: 'Invalid JSON body' }, 400) };
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return { response: c.json({ error: 'prompt is required' }, 400) };
  }
  if (body.model !== undefined && typeof body.model !== 'string') {
    return { response: c.json({ error: 'model must be a string' }, 400) };
  }

  const model = body.model?.trim() || undefined;
  if (!chatStore.hasChat(chatId)) {
    return { response: c.json({ error: 'Chat not found' }, 404) };
  }

  if (model) {
    try {
      const catalog = await chatStore.listModels();
      if (!catalog.models.some((item) => item.id === model)) {
        return {
          response: c.json({ error: 'Selected model is not available' }, 400),
        };
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Model catalog unavailable';
      return { response: c.json({ error: message }, 503) };
    }
  }

  return { prompt, model };
}

async function* toTurnFrames(
  events: ReturnType<ChatStore['runTurn']>,
): AsyncGenerator<SseFrame> {
  for await (const persisted of events) {
    yield {
      event: persisted.event.type,
      data: persisted.event,
      id: String(persisted.seq),
    };
  }
}

function streamTurnLike(
  c: Context,
  frames: AsyncIterable<SseFrame>,
  onError: (error: unknown) => SseFrame[],
): Response {
  return streamSSE(c, async (stream) => {
    // Model reasoning and long tool runs can leave the stream silent for
    // minutes. SSE comments keep fetch clients alive without creating events.
    const heartbeat = setInterval(async () => {
      await stream.write(': heartbeat\n\n');
    }, 15_000);
    try {
      for await (const frame of frames) {
        await stream.writeSSE({
          event: frame.event,
          data: JSON.stringify(frame.data),
          ...(frame.id === undefined ? {} : { id: frame.id }),
        });
      }
    } catch (error) {
      for (const frame of onError(error)) {
        await stream.writeSSE({
          event: frame.event,
          data: JSON.stringify(frame.data),
          ...(frame.id === undefined ? {} : { id: frame.id }),
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  });
}

// Validate an untrusted `seed` body into a WorkspaceSeed. Only git seeds exist
// today; url and ref are both required and non-empty.
function parseSeed(
  raw: unknown,
): { seed: WorkspaceSeed } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'seed must be an object' };
  }
  const seed = raw as Record<string, unknown>;
  if (seed.kind !== 'git') {
    return { error: "seed.kind must be 'git'" };
  }
  if (typeof seed.url !== 'string' || !seed.url.trim()) {
    return { error: 'seed.url is required' };
  }
  if (typeof seed.ref !== 'string' || !seed.ref.trim()) {
    return { error: 'seed.ref is required' };
  }
  return { seed: { kind: 'git', url: seed.url.trim(), ref: seed.ref.trim() } };
}

function errorFrame(error: unknown): SseFrame {
  const message = error instanceof Error ? error.message : String(error);
  return { event: 'error', data: { error: message } };
}

function mapDomainError(
  error: unknown,
): { message: string; status: 404 | 409 } | null {
  if (error instanceof ChatNotFoundError) {
    return { message: 'Chat not found', status: 404 };
  }
  if (error instanceof ChatBusyError) {
    return { message: 'Turn already in progress', status: 409 };
  }
  if (error instanceof VersionNotFoundError) {
    return { message: 'Version not found', status: 404 };
  }
  if (error instanceof ProjectNotFoundError) {
    return { message: 'Project not found', status: 404 };
  }
  return null;
}

function toPreviewStatusEvent(status: {
  status: ChatLevelEvent['status'];
  url?: string;
  error?: string;
}): ChatLevelEvent {
  return {
    type: 'preview-status',
    status: status.status,
    url: status.url,
    error: status.error,
  };
}
