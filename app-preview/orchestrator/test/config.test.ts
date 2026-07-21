import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const originalHostname = process.env.ORCHESTRATOR_HOSTNAME;

  afterEach(() => {
    if (originalHostname === undefined) {
      delete process.env.ORCHESTRATOR_HOSTNAME;
    } else {
      process.env.ORCHESTRATOR_HOSTNAME = originalHostname;
    }
  });

  it('binds the orchestrator to loopback by default', () => {
    delete process.env.ORCHESTRATOR_HOSTNAME;

    expect(loadConfig().hostname).toBe('127.0.0.1');
  });

  it('allows the listener hostname to be overridden by env or config', () => {
    process.env.ORCHESTRATOR_HOSTNAME = '192.0.2.10';
    expect(loadConfig().hostname).toBe('192.0.2.10');
    expect(loadConfig({ hostname: '127.0.0.2' }).hostname).toBe('127.0.0.2');
  });
});
