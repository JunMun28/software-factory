import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { DashboardBlueprint } from './blueprints/types.js';
import { validateBlueprint, type ValidationError } from './blueprints/validate.js';
import {
  sanitizeConnectionName,
  singleConnectionEnv,
} from './connection-env.js';
import {
  ConnectionTester,
  type ConnectionTestResult,
} from './connection-tester.js';
import {
  gitBundleRange,
  gitCommit,
  gitImportCommitTree,
  gitResetHardAndClean,
  gitRestoreToCommit,
  gitRootCommit,
  listCommitRange,
  listVersions as listGitVersions,
  tailOutput,
} from './git.js';
import type {
  BlueprintRevisionRow,
  ConnectionKind,
  ConnectionSummary,
  PlatformDb,
  ProjectRow,
  TurnEventRow,
  TurnHistoryRow,
  VersionRow,
} from './platform-db.js';
import {
  DEFAULT_PROJECT_ID,
  FOUNDER_USER_ID,
} from './platform-db.js';
import { runTurnPipeline } from './turn-pipeline.js';
import type {
  BlueprintRevisionDetails,
  ChatSummary,
  GateRunner,
  Harness,
  HarnessSession,
  ModelCatalog,
  OrchestratorEvent,
  ProjectDetails,
  ProjectSummary,
  VersionDetails,
  WorkspaceProvider,
  WorkspaceSeed,
} from './types.js';
import {
  getVersionDiffStat,
  getVersionFileDiffs,
  type VersionFileDiff,
} from './workspace-files.js';
import type { VersionDiffStat, VersionFileChange } from './types.js';

interface ChatRecord {
  chatId: string;
  projectId: string;
  workspaceDir: string;
  status: 'idle' | 'running';
  runningGenerationId: string | null;
  session: HarnessSession | null;
}

type TurnEventSubscriber = (event: TurnEventRow) => void;

export class ChatStore {
  private readonly chats = new Map<string, ChatRecord>();
  private readonly turnEventSubscribers = new Map<
    string,
    Set<TurnEventSubscriber>
  >();

  constructor(
    private readonly workspaceProvider: WorkspaceProvider,
    private readonly harness: Harness,
    private readonly gateRunner: GateRunner,
    private readonly db: PlatformDb,
    private readonly connectionTester: ConnectionTester = new ConnectionTester(),
  ) {}

  // Wired by the factory to PreviewManager.resync: a green turn writes a new
  // Version, so a live sandbox should fast-forward to it. Optional so tests and
  // the local flow (dev server watches the workspace directly) need no wiring.
  onVersionCreated?: (chatId: string, sha: string) => void;

  // Chats must survive an orchestrator restart (issue 0025): reload the
  // registry from the metadata store, skipping rows whose workspace is gone.
  async rehydrate(): Promise<number> {
    const interrupted = await this.db.reconcileInterruptedGenerations();
    if (interrupted > 0) {
      console.warn(`Marked ${interrupted} interrupted generation(s) as error`);
    }
    let restored = 0;
    for (const row of await this.db.listChats()) {
      if (this.chats.has(row.id) || !existsSync(row.workspace_ref)) {
        continue;
      }
      if (gitResetHardAndClean(row.workspace_ref)) {
        console.warn(`Reset interrupted dirty workspace for chat ${row.id}`);
      }
      this.chats.set(row.id, {
        chatId: row.id,
        projectId: row.project_id,
        workspaceDir: row.workspace_ref,
        status: 'idle',
        runningGenerationId: null,
        session: null,
      });
      if ((await this.db.listVersions(row.id)).length === 0) {
        let gitVersions: ChatSummary['versions'] = [];
        try {
          gitVersions = await listGitVersions(row.workspace_ref);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`Skipped version backfill for chat ${row.id}: ${detail}`);
        }
        for (const version of gitVersions) {
          await this.db.insertVersion(
            row.id,
            null,
            version.commit,
            version.message,
            null,
            null,
            null,
          );
        }
      }
      restored += 1;
    }
    return restored;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return (await this.db.listProjects(FOUNDER_USER_ID)).map((project) =>
      toProjectSummary(project),
    );
  }

  async createProject(name: string): Promise<ProjectSummary> {
    return toProjectSummary(await this.db.createProject(FOUNDER_USER_ID, name));
  }

  async getProject(projectId: string): Promise<ProjectDetails | null> {
    const project = await this.db.getProject(FOUNDER_USER_ID, projectId);
    if (!project) {
      return null;
    }
    const chats: ChatSummary[] = [];
    for (const record of this.chats.values()) {
      if (record.projectId !== projectId) {
        continue;
      }
      const chat = await this.getChat(record.chatId);
      if (chat) {
        chats.push(chat);
      }
    }
    return {
      ...toProjectSummary(project),
      chats,
    };
  }

  async createChat(options: {
    projectId?: string;
    title?: string;
    seed?: WorkspaceSeed;
  } = {}): Promise<string> {
    const projectId = options.projectId ?? this.db.defaultProjectId;
    if (!(await this.db.getProject(FOUNDER_USER_ID, projectId))) {
      throw new ProjectNotFoundError(projectId);
    }
    const chatId = randomUUID();
    const workspaceDir = await this.workspaceProvider.create(
      chatId,
      options.seed,
    );
    // A seeded workspace carries code the factory's gate has not vouched for.
    // Prove it green before the chat is usable — never start a conversation on
    // a broken app. A red gate aborts creation loudly and cleans up the
    // workspace; nothing is persisted (the DB insert happens only past here),
    // so there are no rows to unwind.
    if (options.seed) {
      const gate = await this.gateRunner.run(workspaceDir);
      if (!gate.green) {
        await rm(workspaceDir, { recursive: true, force: true });
        throw new SeedGateFailedError(tailOutput(gate.output));
      }
    }
    const title = options.title?.trim() || undefined;
    await this.db.insertChat(chatId, workspaceDir, projectId, title, options.seed);
    this.chats.set(chatId, {
      chatId,
      projectId,
      workspaceDir,
      status: 'idle',
      runningGenerationId: null,
      session: null,
    });
    return chatId;
  }

  listModels(): Promise<ModelCatalog> {
    return this.harness.listModels();
  }

  hasChat(chatId: string): boolean {
    return this.chats.has(chatId);
  }

  getWorkspaceDir(chatId: string): string | null {
    return this.chats.get(chatId)?.workspaceDir ?? null;
  }

  async getChat(chatId: string): Promise<ChatSummary | null> {
    const chat = this.chats.get(chatId);
    if (!chat) {
      return null;
    }
    const versions = (await this.db.listVersions(chatId)).map((version) => ({
      commit: version.manifestRef,
      message: version.message ?? '',
    }));
    const runningGeneration = await this.db.getRunningGeneration(chatId);
    const runningGenerationId =
      runningGeneration?.id ?? chat.runningGenerationId;
    const turnRunning = chat.status === 'running' || runningGenerationId !== null;
    const seed = await this.db.getChatSeed(chat.chatId);
    return {
      chatId: chat.chatId,
      projectId: chat.projectId,
      title: await this.db.getChatTitle(chat.chatId),
      status: turnRunning ? 'running' : 'idle',
      turnRunning,
      runningGenerationId,
      versions,
      seedUrl: seed?.url ?? null,
      seedRef: seed?.ref ?? null,
    };
  }

  async listTurnHistory(chatId: string): Promise<TurnHistoryRow[] | null> {
    if (!this.chats.has(chatId)) {
      return null;
    }
    return this.db.listTurns(chatId);
  }

  async listBlueprintRevisions(
    chatId: string,
  ): Promise<BlueprintRevisionDetails[] | null> {
    if (!this.chats.has(chatId)) {
      return null;
    }
    return (await this.db.listBlueprintRevisions(chatId)).map(
      toBlueprintRevisionDetails,
    );
  }

  // Validates untrusted JSON into a `DashboardBlueprint` before persisting a
  // new immutable revision. Returns the field errors instead of throwing so
  // the route can answer 422 without a 500.
  async createBlueprintRevision(
    chatId: string,
    input: unknown,
  ): Promise<
    | { ok: true; revision: BlueprintRevisionDetails }
    | { ok: false; errors: ValidationError[] }
  > {
    const validation = validateBlueprintInput(input);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    const row = await this.db.insertBlueprintRevision(
      chatId,
      validation.blueprint,
    );
    await this.db.touchChat(chatId);
    return { ok: true, revision: toBlueprintRevisionDetails(row) };
  }

  async approveBlueprintRevision(
    chatId: string,
    revisionId: string,
  ): Promise<BlueprintRevisionDetails | null> {
    if (!this.chats.has(chatId)) {
      return null;
    }
    const row = await this.db.approveBlueprintRevision(chatId, revisionId);
    return row ? toBlueprintRevisionDetails(row) : null;
  }

  async listConnections(chatId: string): Promise<ConnectionSummary[] | null> {
    if (!this.chats.has(chatId)) {
      return null;
    }
    return this.db.listConnections(chatId);
  }

  async createConnection(
    chatId: string,
    input: unknown,
  ): Promise<
    | { ok: true; connection: ConnectionSummary }
    | { ok: false; errors: ValidationError[] }
  > {
    const validation = validateConnectionInput(input);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }

    const duplicate = findConnectionByName(
      await this.db.listConnections(chatId),
      validation.connection.name,
    );
    if (duplicate) {
      return {
        ok: false,
        errors: [
          {
            path: 'name',
            message: `Connection name "${validation.connection.name}" already exists`,
          },
        ],
      };
    }

    const connection = await this.db.createConnection(
      chatId,
      validation.connection.name,
      validation.connection.kind,
      validation.connection.config,
      validation.connection.secret,
    );
    await this.db.touchChat(chatId);
    return { ok: true, connection };
  }

  async deleteConnection(
    chatId: string,
    name: string,
  ): Promise<boolean | null> {
    if (!this.chats.has(chatId)) {
      return null;
    }
    const connection = findConnectionByName(
      await this.db.listConnections(chatId),
      name,
    );
    return connection
      ? this.db.deleteConnection(chatId, connection.name)
      : false;
  }

  async testConnection(
    chatId: string,
    name: string,
  ): Promise<ConnectionTestResult | null> {
    const chat = this.chats.get(chatId);
    if (!chat) {
      return null;
    }

    const connection = findConnectionByName(
      await this.db.listConnectionsWithSecrets(chatId),
      name,
    );
    if (!connection) {
      return null;
    }

    const env = await singleConnectionEnv(this.db, chatId, connection.name);
    if (!env) {
      return null;
    }

    const secretsToRedact = Object.values(connection.secret);
    if (connection.kind !== 'rest') {
      const url = env[`DATASOURCE_${env.DATASOURCE_NAMES}_URL`];
      if (url !== undefined) {
        secretsToRedact.push(url);
      }
    }

    return await this.connectionTester.test({
      workspaceDir: chat.workspaceDir,
      env,
      name,
      secretsToRedact,
    });
  }

  async listChats(): Promise<ChatSummary[]> {
    const summaries: ChatSummary[] = [];
    for (const chat of this.chats.values()) {
      const summary = await this.getChat(chat.chatId);
      if (summary) {
        summaries.push(summary);
      }
    }
    return summaries;
  }

  async listVersions(chatId: string): Promise<VersionDetails[] | null> {
    if (!this.chats.has(chatId)) {
      return null;
    }
    return (await this.db.listVersions(chatId)).map(toVersionDetails);
  }

  async restoreVersion(
    chatId: string,
    versionId: string,
  ): Promise<VersionDetails> {
    const chat = await this.requireIdleChat(chatId);
    const source = await this.db.getVersion(chatId, versionId);
    if (!source) {
      throw new VersionNotFoundError(versionId);
    }

    await gitRestoreToCommit(chat.workspaceDir, source.manifestRef);
    const message = `Restore v${source.seq}`;
    const commit = await gitCommit(chat.workspaceDir, message, {
      allowEmpty: true,
    });
    const { diffStat, files } = await this.computeVersionDiff(
      chat.workspaceDir,
      commit,
    );
    const version = await this.db.insertVersion(
      chatId,
      null,
      commit,
      message,
      source.id,
      diffStat,
      files,
    );
    await this.db.touchChat(chatId);
    await chat.session?.dispose();
    chat.session = null;
    return toVersionDetails(version);
  }

  async forkVersion(chatId: string, versionId: string): Promise<string> {
    const sourceChat = this.chats.get(chatId);
    if (!sourceChat) {
      throw new ChatNotFoundError(chatId);
    }
    const source = await this.db.getVersion(chatId, versionId);
    if (!source) {
      throw new VersionNotFoundError(versionId);
    }

    const forkChatId = randomUUID();
    let workspaceDir: string | null = null;
    try {
      workspaceDir = await this.workspaceProvider.create(forkChatId);
      const message = `Fork from v${source.seq}`;
      const commit = await gitImportCommitTree(
        workspaceDir,
        sourceChat.workspaceDir,
        source.manifestRef,
        message,
      );
      const sourceTitle = (await this.db.getChatTitle(chatId)) ?? 'Untitled chat';
      await this.db.insertChat(
        forkChatId,
        workspaceDir,
        sourceChat.projectId,
        `Fork of ${sourceTitle}`,
      );
      const { diffStat, files } = await this.computeVersionDiff(
        workspaceDir,
        commit,
      );
      await this.db.insertVersion(
        forkChatId,
        null,
        commit,
        message,
        null,
        diffStat,
        files,
      );
      this.chats.set(forkChatId, {
        chatId: forkChatId,
        projectId: sourceChat.projectId,
        workspaceDir,
        status: 'idle',
        runningGenerationId: null,
        session: null,
      });
      return forkChatId;
    } catch (error) {
      await this.db.deleteChat(forkChatId);
      if (workspaceDir) {
        await rm(workspaceDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async getVersionDiff(
    chatId: string,
    versionId: string,
  ): Promise<VersionFileDiff[]> {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new ChatNotFoundError(chatId);
    }
    const version = await this.db.getVersion(chatId, versionId);
    if (!version) {
      throw new VersionNotFoundError(versionId);
    }
    return getVersionFileDiffs(chat.workspaceDir, version.manifestRef);
  }

  // Export a version's commit chain as a git bundle, against the chat's seed
  // ref (ng-v0 bridge piece 3). The factory imports this to replay every
  // sandbox checkpoint 1:1. `seedRef` is the commit the chain is anchored at —
  // the seed commit for a seeded chat, the baseline commit otherwise — and
  // `versions` lists every commit after it up to and including the exported one.
  async exportVersion(
    chatId: string,
    versionId: string,
  ): Promise<{
    bundle: string;
    seedRef: string;
    versions: Array<{ sha: string; message: string }>;
  }> {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new ChatNotFoundError(chatId);
    }
    const version = await this.db.getVersion(chatId, versionId);
    if (!version) {
      throw new VersionNotFoundError(versionId);
    }
    const versionSha = version.manifestRef;
    const seedRef = await gitRootCommit(chat.workspaceDir, versionSha);
    const versions = await listCommitRange(
      chat.workspaceDir,
      seedRef,
      versionSha,
    );
    const bundle = await gitBundleRange(chat.workspaceDir, seedRef, versionSha);
    return { bundle, seedRef, versions };
  }

  async renameChat(chatId: string, title: string): Promise<ChatSummary> {
    if (
      !this.chats.has(chatId) ||
      !(await this.db.updateChatTitle(chatId, title))
    ) {
      throw new ChatNotFoundError(chatId);
    }
    const chat = await this.getChat(chatId);
    if (!chat) {
      throw new ChatNotFoundError(chatId);
    }
    return chat;
  }

  async deleteChat(chatId: string): Promise<void> {
    const chat = await this.requireIdleChat(chatId);
    await chat.session?.dispose();
    await rm(chat.workspaceDir, { recursive: true, force: true });
    await this.db.deleteChat(chatId);
    this.chats.delete(chatId);
  }

  async assertIdle(chatId: string): Promise<void> {
    await this.requireIdleChat(chatId);
  }

  isRunning(chatId: string): boolean {
    return this.chats.get(chatId)?.status === 'running';
  }

  private async requireIdleChat(chatId: string): Promise<ChatRecord> {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new ChatNotFoundError(chatId);
    }
    if (
      chat.status === 'running' ||
      (await this.db.getRunningGeneration(chatId))
    ) {
      throw new ChatBusyError(chatId);
    }
    return chat;
  }

  async hasGeneration(chatId: string, generationId: string): Promise<boolean> {
    return (await this.db.getGeneration(generationId))?.chatId === chatId;
  }

  async *observeTurnEvents(
    chatId: string,
    generationId: string,
    sinceSeq = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnEventRow> {
    if (!(await this.hasGeneration(chatId, generationId))) {
      throw new ChatNotFoundError(chatId);
    }

    const queue: TurnEventRow[] = [];
    let resolveNext: ((event: TurnEventRow | null) => void) | null = null;
    let closed = false;
    const close = () => {
      closed = true;
      resolveNext?.(null);
      resolveNext = null;
    };
    const push = (event: TurnEventRow) => {
      if (closed) {
        return;
      }
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve(event);
        return;
      }
      queue.push(event);
    };
    const next = (): Promise<TurnEventRow | null> => {
      const event = queue.shift();
      if (event) {
        return Promise.resolve(event);
      }
      if (closed) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    };

    const unsubscribe = this.subscribeToTurnEvents(generationId, push);
    signal?.addEventListener('abort', close, { once: true });

    try {
      let lastSeq = sinceSeq;
      let terminalReplayed = false;
      for (const event of await this.db.listTurnEvents(generationId, sinceSeq)) {
        if (event.seq <= lastSeq) {
          continue;
        }
        lastSeq = event.seq;
        yield event;
        if (event.event.type === 'turn-finished') {
          terminalReplayed = true;
        }
      }

      if (terminalReplayed) {
        return;
      }

      while (queue.length > 0) {
        const event = queue.shift();
        if (!event || event.seq <= lastSeq) {
          continue;
        }
        lastSeq = event.seq;
        yield event;
        if (event.event.type === 'turn-finished') {
          return;
        }
      }

      if ((await this.db.getGeneration(generationId))?.result !== 'running') {
        return;
      }

      while (!signal?.aborted) {
        const event = await next();
        if (!event) {
          return;
        }
        if (event.seq <= lastSeq) {
          continue;
        }
        lastSeq = event.seq;
        yield event;
        if (event.event.type === 'turn-finished') {
          return;
        }
      }
    } finally {
      close();
      signal?.removeEventListener('abort', close);
      unsubscribe();
    }
  }

  beginTurn(chatId: string): void {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new ChatNotFoundError(chatId);
    }
    if (chat.status === 'running') {
      throw new ChatBusyError(chatId);
    }
    chat.status = 'running';
  }

  async *runTurn(
    chatId: string,
    prompt: string,
    model?: string,
  ): AsyncGenerator<TurnEventRow> {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new ChatNotFoundError(chatId);
    }

    const turnId = randomUUID();
    const generationId = await this.db.beginGeneration(chatId, prompt, null);
    chat.runningGenerationId = generationId;
    await this.db.setChatTitleIfEmpty(chatId, deriveChatTitle(prompt));
    let result: 'green' | 'red' | 'no-change' | 'error' = 'error';
    let gateOutputTail: string | undefined;

    try {
      yield await this.persistAndPublish(generationId, {
        type: 'turn-started',
        chatId,
        turnId,
      });

      if (!chat.session) {
        chat.session = await this.harness.startSession(chat.workspaceDir);
      }

      for await (const event of runTurnPipeline({
        chatId,
        turnId,
        prompt,
        model,
        session: chat.session,
        workspaceDir: chat.workspaceDir,
        gateRunner: this.gateRunner,
      })) {
        if (event.type === 'gate-status' && event.status === 'red') {
          gateOutputTail = event.output;
        }
        if (event.type === 'version-created') {
          const { diffStat, files } = await this.computeVersionDiff(
            chat.workspaceDir,
            event.commit,
          );
          await this.db.insertVersion(
            chatId,
            generationId,
            event.commit,
            event.message,
            null,
            diffStat,
            files,
          );
          // A live sandbox tracks the work branch: poke it to the new commit so
          // the preview reflects this turn. Fire-and-forget; never fail the turn.
          this.onVersionCreated?.(chatId, event.commit);
        }
        if (event.type === 'turn-finished') {
          result = event.result;
        }
        yield await this.persistAndPublish(generationId, event);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      gateOutputTail = message;
      result = 'red';
      yield await this.persistAndPublish(generationId, {
        type: 'gate-status',
        status: 'red',
        output: message,
      });
      yield await this.persistAndPublish(generationId, {
        type: 'turn-finished',
        turnId,
        result: 'red',
      });
    } finally {
      await this.db.finishGeneration(generationId, result, gateOutputTail);
      await this.db.touchChat(chatId);
      chat.status = 'idle';
      chat.runningGenerationId = null;
    }
  }

  // Diffstat is a UI nicety, never a gate: a failure here must not fail the
  // version cut, so it degrades to null (the UI treats null as "unavailable").
  private async computeVersionDiff(
    workspaceDir: string,
    commit: string,
  ): Promise<{
    diffStat: VersionDiffStat | null;
    files: VersionFileChange[] | null;
  }> {
    try {
      return await getVersionDiffStat(workspaceDir, commit);
    } catch (error) {
      console.warn(`Failed to compute diffstat for ${commit}:`, error);
      return { diffStat: null, files: null };
    }
  }

  private async persistAndPublish(
    generationId: string,
    event: OrchestratorEvent,
  ): Promise<TurnEventRow> {
    const persisted = await this.db.appendTurnEvent(generationId, event);
    for (const subscriber of this.turnEventSubscribers.get(generationId) ?? []) {
      subscriber(persisted);
    }
    return persisted;
  }

  private subscribeToTurnEvents(
    generationId: string,
    subscriber: TurnEventSubscriber,
  ): () => void {
    const subscribers =
      this.turnEventSubscribers.get(generationId) ?? new Set<TurnEventSubscriber>();
    subscribers.add(subscriber);
    this.turnEventSubscribers.set(generationId, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        this.turnEventSubscribers.delete(generationId);
      }
    };
  }
}

// v0-style short titles: "Build a pomodoro timer app: a big countdown…"
// becomes "Pomodoro timer app", not a truncated prompt dump.
function deriveChatTitle(prompt: string): string {
  let title = prompt.split('\n')[0]?.trim() ?? '';
  const cut = title.search(/[:.!?]/);
  if (cut > 0) {
    title = title.slice(0, cut);
  }
  const withoutVerb = title.replace(
    /^(please\s+)?(build|create|make|add|implement|design|generate)\s+(me\s+)?(a|an|the)?\s*/i,
    '',
  );
  if (withoutVerb.length > 0) {
    title = withoutVerb;
  }
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}

export class ChatNotFoundError extends Error {
  constructor(chatId: string) {
    super(`Chat not found: ${chatId}`);
    this.name = 'ChatNotFoundError';
  }
}

export class ChatBusyError extends Error {
  constructor(chatId: string) {
    super(`Chat is busy: ${chatId}`);
    this.name = 'ChatBusyError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project not found: ${projectId}`);
    this.name = 'ProjectNotFoundError';
  }
}

export class VersionNotFoundError extends Error {
  constructor(versionId: string) {
    super(`Version not found: ${versionId}`);
    this.name = 'VersionNotFoundError';
  }
}

// A seeded chat whose workspace failed the factory's gate. Carries the gate
// output tail so the route can hand it back (HTTP 422) — the requester fixes
// the app in the sandbox where they were already working.
export class SeedGateFailedError extends Error {
  constructor(readonly output: string) {
    super('Seed gate failed');
    this.name = 'SeedGateFailedError';
  }
}

function toVersionDetails(version: VersionRow): VersionDetails {
  return {
    id: version.id,
    seq: version.seq,
    commit: version.manifestRef,
    message: version.message ?? '',
    restoredFromVersionId: version.restoredFromVersionId,
    createdAt: version.createdAt,
    diffStat: version.diffStat,
    files: version.files,
  };
}

function toBlueprintRevisionDetails(
  row: BlueprintRevisionRow,
): BlueprintRevisionDetails {
  return {
    id: row.id,
    revision: row.revision,
    blueprint: row.blueprint,
    approved: row.approved,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
  };
}

// `validateBlueprint` assumes an already-shaped blueprint and reads fields
// defensively, but a raw request body can be any JSON value (including a
// non-object or a shape that trips its field access). Guard both so callers
// always get structured errors rather than a thrown 500.
function validateBlueprintInput(
  input: unknown,
):
  | { ok: true; blueprint: DashboardBlueprint }
  | { ok: false; errors: ValidationError[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ path: '', message: 'Blueprint must be a JSON object' }],
    };
  }
  try {
    return validateBlueprint(input as DashboardBlueprint);
  } catch {
    return {
      ok: false,
      errors: [{ path: '', message: 'Blueprint is structurally invalid' }],
    };
  }
}

interface ValidatedConnectionInput {
  name: string;
  kind: ConnectionKind;
  config: Record<string, string>;
  secret: Record<string, string>;
}

interface OptionalConnectionString {
  valid: boolean;
  value?: string;
}

function validateConnectionInput(
  input: unknown,
):
  | { ok: true; connection: ValidatedConnectionInput }
  | { ok: false; errors: ValidationError[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ path: '', message: 'Connection must be a JSON object' }],
    };
  }

  const body = input as Record<string, unknown>;
  const errors: ValidationError[] = [];
  let name: string | null = null;
  let kind: ConnectionKind | null = null;

  if (typeof body.name !== 'string') {
    errors.push({
      path: 'name',
      message:
        body.name === undefined || body.name === null
          ? 'Connection name is required'
          : 'Connection name must be a string',
    });
  } else {
    try {
      sanitizeConnectionName(body.name);
      name = body.name;
    } catch (error) {
      errors.push({
        path: 'name',
        message:
          error instanceof Error
            ? error.message
            : 'Connection name is invalid',
      });
    }
  }

  if (body.kind === undefined || body.kind === null || body.kind === '') {
    errors.push({ path: 'kind', message: 'Connection kind is required' });
  } else if (!isConnectionKind(body.kind)) {
    errors.push({
      path: 'kind',
      message: 'Connection kind must be one of mssql, snowflake, or rest',
    });
  } else {
    kind = body.kind;
  }

  const config: Record<string, string> = {};
  const secret: Record<string, string> = {};
  if (kind === 'mssql') {
    copyRequiredConnectionString(body, 'host', config, errors);
    copyRequiredConnectionString(body, 'database', config, errors);
    copyRequiredConnectionString(body, 'user', config, errors);
    const port = readOptionalConnectionString(body, 'port', errors);
    if (port.value !== undefined) {
      if (/^\d+$/.test(port.value)) {
        config.port = port.value;
      } else {
        errors.push({
          path: 'port',
          message: 'port must contain digits only',
        });
      }
    }
    copyRequiredConnectionString(body, 'password', secret, errors);
  } else if (kind === 'snowflake') {
    copyRequiredConnectionString(body, 'account', config, errors);
    copyRequiredConnectionString(body, 'database', config, errors);
    copyRequiredConnectionString(body, 'user', config, errors);
    copyOptionalConnectionString(body, 'schema', config, errors);
    copyOptionalConnectionString(body, 'warehouse', config, errors);
    copyRequiredConnectionString(body, 'password', secret, errors);
  } else if (kind === 'rest') {
    const baseUrl = readRequiredConnectionString(body, 'base_url', errors);
    if (baseUrl !== null) {
      if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
        config.base_url = baseUrl;
      } else {
        errors.push({
          path: 'base_url',
          message: 'base_url must start with http:// or https://',
        });
      }
    }

    const authHeader = readOptionalConnectionString(
      body,
      'auth_header',
      errors,
    );
    const authValue = readOptionalConnectionString(
      body,
      'auth_value',
      errors,
    );
    if (authHeader.value !== undefined) {
      config.auth_header = authHeader.value;
    }
    if (authValue.value !== undefined) {
      secret.auth_value = authValue.value;
    }
    if (authHeader.valid && authValue.valid) {
      if (authHeader.value !== undefined && authValue.value === undefined) {
        errors.push({
          path: 'auth_value',
          message: 'auth_value is required when auth_header is provided',
        });
      } else if (
        authHeader.value === undefined &&
        authValue.value !== undefined
      ) {
        errors.push({
          path: 'auth_header',
          message: 'auth_header is required when auth_value is provided',
        });
      }
    }
  }

  if (errors.length > 0 || name === null || kind === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    connection: { name, kind, config, secret },
  };
}

function isConnectionKind(value: unknown): value is ConnectionKind {
  return value === 'mssql' || value === 'snowflake' || value === 'rest';
}

function copyRequiredConnectionString(
  input: Record<string, unknown>,
  field: string,
  target: Record<string, string>,
  errors: ValidationError[],
): void {
  const value = readRequiredConnectionString(input, field, errors);
  if (value !== null) {
    target[field] = value;
  }
}

function readRequiredConnectionString(
  input: Record<string, unknown>,
  field: string,
  errors: ValidationError[],
): string | null {
  const value = input[field];
  if (value === undefined || value === null) {
    errors.push({ path: field, message: `${field} is required` });
    return null;
  }
  if (typeof value !== 'string') {
    errors.push({ path: field, message: `${field} must be a string` });
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push({ path: field, message: `${field} is required` });
    return null;
  }
  return trimmed;
}

function copyOptionalConnectionString(
  input: Record<string, unknown>,
  field: string,
  target: Record<string, string>,
  errors: ValidationError[],
): void {
  const result = readOptionalConnectionString(input, field, errors);
  if (result.value !== undefined) {
    target[field] = result.value;
  }
}

function readOptionalConnectionString(
  input: Record<string, unknown>,
  field: string,
  errors: ValidationError[],
): OptionalConnectionString {
  const value = input[field];
  if (value === undefined) {
    return { valid: true };
  }
  if (typeof value !== 'string') {
    errors.push({ path: field, message: `${field} must be a string` });
    return { valid: false };
  }
  const trimmed = value.trim();
  return trimmed.length > 0
    ? { valid: true, value: trimmed }
    : { valid: true };
}

function findConnectionByName<T extends { name: string }>(
  connections: T[],
  name: string,
): T | null {
  const exactMatch = connections.find((connection) => connection.name === name);
  if (exactMatch) {
    return exactMatch;
  }

  const sanitizedName = trySanitizeConnectionName(name);
  if (sanitizedName === null) {
    return null;
  }
  return (
    connections.find(
      (connection) =>
        trySanitizeConnectionName(connection.name) === sanitizedName,
    ) ?? null
  );
}

function trySanitizeConnectionName(name: string): string | null {
  try {
    return sanitizeConnectionName(name);
  } catch {
    return null;
  }
}

function toProjectSummary(project: ProjectRow): ProjectSummary {
  return {
    ...project,
    isDefault: project.id === DEFAULT_PROJECT_ID,
  };
}
