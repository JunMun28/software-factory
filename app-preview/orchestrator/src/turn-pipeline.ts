import {
  gitCommit,
  gitHasChanges,
  tailOutput,
  truncatePrompt,
} from './git.js';
import type {
  GateRunner,
  HarnessSession,
  OrchestratorEvent,
} from './types.js';

export async function* runTurnPipeline(options: {
  chatId: string;
  turnId: string;
  prompt: string;
  model?: string;
  session: HarnessSession;
  workspaceDir: string;
  gateRunner: GateRunner;
}): AsyncGenerator<OrchestratorEvent> {
  const { turnId, prompt, model, session, workspaceDir, gateRunner } = options;

  try {
    for await (const event of session.sendTurn(prompt, model)) {
      yield event;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    yield { type: 'gate-status', status: 'red', output: message };
    yield { type: 'turn-finished', turnId, result: 'red' };
    return;
  }

  try {
    // The gate certifies a new Version; with no changes there is nothing to
    // certify. Skipping it also avoids racing the preview's npm install in a
    // fresh workspace (observed: instant no-op turn → ng build red on rxjs).
    const hasChanges = await gitHasChanges(workspaceDir);
    if (!hasChanges) {
      yield { type: 'turn-finished', turnId, result: 'no-change' };
      return;
    }

    yield { type: 'gate-status', status: 'pending' };

    const gate = await gateRunner.run(workspaceDir);
    if (!gate.green) {
      yield {
        type: 'gate-status',
        status: 'red',
        output: tailOutput(gate.output),
      };
      yield { type: 'turn-finished', turnId, result: 'red' };
      return;
    }

    yield { type: 'gate-status', status: 'green' };

    const message = truncatePrompt(prompt);
    const commit = await gitCommit(workspaceDir, message);
    yield { type: 'version-created', commit, message };
    yield { type: 'turn-finished', turnId, result: 'green' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    yield { type: 'gate-status', status: 'red', output: message };
    yield { type: 'turn-finished', turnId, result: 'red' };
  }
}
