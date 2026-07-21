import { beforeEach, describe, expect, it, vi } from 'vitest';

// util.promisify looks for this well-known symbol on the function it wraps
// and, if present, calls it directly instead of assuming a (err, ...) node
// callback. Referencing it via Symbol.for keeps this test independent of
// importing 'node:util' inside the hoisted mock factory below.
const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');

const state = vi.hoisted(() => ({
  impl: (async () => ({ stdout: '', stderr: '' })) as (
    file: string,
    args: string[],
    options: unknown,
  ) => Promise<{ stdout: string; stderr: string }>,
  eventStream: (async function* () {
    yield* [];
  })() as AsyncIterable<unknown>,
  promptPromise: () => Promise.resolve({ data: undefined }) as Promise<unknown>,
}));

vi.mock('node:child_process', () => {
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  function execFile(
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error) => void,
  ): void {
    callback(new Error('this mock only supports the promisified call form'));
  }
  Object.defineProperty(execFile, promisifyCustom, {
    value: (file: string, args: string[], options: unknown) =>
      state.impl(file, args, options),
  });
  return { execFile };
});

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeServer: async () => ({
    url: 'http://127.0.0.1:12345',
    close: vi.fn(),
  }),
  createOpencodeClient: () => ({
    event: {
      subscribe: async () => ({ stream: state.eventStream }),
    },
    session: {
      create: async () => ({ data: { id: 'session-1' } }),
      promptAsync: () => state.promptPromise(),
      status: async () => ({ data: { 'session-1': { type: 'idle' } } }),
    },
  }),
}));

import { OpenCodeHarness } from '../src/harness/opencode-harness.js';

describe('OpenCodeHarness.listModels', () => {
  beforeEach(() => {
    state.impl = async () => ({ stdout: '', stderr: '' });
    state.eventStream = (async function* () {
      yield* [];
    })();
    state.promptPromise = () => Promise.resolve({ data: undefined });
  });

  it('retries after a transient failure instead of caching the rejected promise', async () => {
    let calls = 0;
    state.impl = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('opencode not found');
      }
      return { stdout: 'openai/gpt-5\n', stderr: '' };
    };

    const harness = new OpenCodeHarness();

    await expect(harness.listModels()).rejects.toThrow('opencode not found');

    await expect(harness.listModels()).resolves.toEqual({
      models: [{ id: 'openai/gpt-5', provider: 'openai', name: 'gpt-5' }],
    });
    expect(calls).toBe(2);
  });

  it('caches a successful catalog load instead of re-invoking opencode', async () => {
    let calls = 0;
    state.impl = async () => {
      calls += 1;
      return { stdout: 'openai/gpt-5\n', stderr: '' };
    };

    const harness = new OpenCodeHarness();
    await harness.listModels();
    await harness.listModels();

    expect(calls).toBe(1);
  });
});

describe('OpenCodeHarness turn rejection handling', () => {
  beforeEach(() => {
    state.impl = async () => ({ stdout: '', stderr: '' });
  });

  it('handles a rejected prompt promise when the event stream fails first', async () => {
    state.eventStream = (async function* () {
      await Promise.resolve();
      throw new Error('event stream failed');
    })();
    state.promptPromise = () => Promise.reject(new Error('prompt failed'));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const session = await new OpenCodeHarness().startSession('/tmp/workspace');
      const consume = async () => {
        for await (const _event of session.sendTurn('build it')) {
          // The stream fails before emitting an event.
        }
      };

      await expect(consume()).rejects.toThrow('event stream failed');
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        'OpenCode prompt failed:',
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
