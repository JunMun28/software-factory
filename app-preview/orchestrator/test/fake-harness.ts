import { randomUUID } from 'node:crypto';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Harness, HarnessSession, OrchestratorEvent } from '../src/types.js';

type HarnessEvent = Extract<
  OrchestratorEvent,
  { type: 'narration' } | { type: 'tool' } | { type: 'file-changed' }
>;

export interface FakeTurnScript {
  events?: HarnessEvent[];
  mutate?: (workspaceDir: string) => Promise<void>;
  throwError?: Error | string;
  delayMs?: number;
}

export class FakeHarness implements Harness {
  readonly receivedModels: Array<string | undefined> = [];
  readonly receivedPrompts: string[] = [];

  private readonly sessions = new Map<
    string,
    { workspaceDir: string; turnIndex: number; scripts: FakeTurnScript[] }
  >();

  constructor(private readonly scriptsByWorkspace: Map<string, FakeTurnScript[]>) {}

  static fromScripts(scripts: FakeTurnScript[]): FakeHarness {
    const map = new Map<string, FakeTurnScript[]>();
    return new FakeHarness(map).withDefaultScripts(scripts);
  }

  withDefaultScripts(scripts: FakeTurnScript[]): this {
    this.defaultScripts = scripts;
    return this;
  }

  private defaultScripts: FakeTurnScript[] = [];

  async listModels() {
    return {
      models: [
        { id: 'openai/gpt-5.4', provider: 'openai', name: 'gpt-5.4' },
        {
          id: 'google/gemini-2.5-pro',
          provider: 'google',
          name: 'gemini-2.5-pro',
        },
      ],
    };
  }

  async startSession(workspaceDir: string): Promise<HarnessSession> {
    const sessionId = randomUUID();
    const scripts =
      this.scriptsByWorkspace.get(workspaceDir) ?? [...this.defaultScripts];
    this.sessions.set(sessionId, { workspaceDir, turnIndex: 0, scripts });
    return new FakeHarnessSession(this, sessionId);
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }
}

class FakeHarnessSession implements HarnessSession {
  constructor(
    private readonly harness: FakeHarness,
    private readonly sessionId: string,
  ) {}

  async *sendTurn(
    prompt: string,
    model?: string,
  ): AsyncIterable<OrchestratorEvent> {
    this.harness.receivedModels.push(model);
    this.harness.receivedPrompts.push(prompt);
    const session = this.harness.getSession(this.sessionId);
    if (!session) {
      throw new Error('Fake session not found');
    }

    const script = session.scripts[session.turnIndex];
    session.turnIndex += 1;
    if (!script) {
      return;
    }

    if (script.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, script.delayMs));
    }

    if (script.mutate) {
      await script.mutate(session.workspaceDir);
    }

    for (const event of script.events ?? []) {
      yield event;
    }

    if (script.throwError) {
      throw script.throwError instanceof Error
        ? script.throwError
        : new Error(script.throwError);
    }
  }

  async dispose(): Promise<void> {
    this.harness.getSession(this.sessionId);
  }
}

export async function writeTrackedFile(
  workspaceDir: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const fullPath = path.join(workspaceDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents, 'utf8');
}

export async function writeIgnoredFile(
  workspaceDir: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const fullPath = path.join(workspaceDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents, 'utf8');
}

export async function deleteTrackedFile(
  workspaceDir: string,
  relativePath: string,
): Promise<void> {
  await unlink(path.join(workspaceDir, relativePath));
}

export async function setGateFail(
  workspaceDir: string,
  failing: boolean,
): Promise<void> {
  const marker = path.join(workspaceDir, '.gate-fail');
  if (failing) {
    await writeFile(marker, 'fail\n', 'utf8');
  } else {
    try {
      await unlink(marker);
    } catch {
      // ignore missing marker
    }
  }
}
