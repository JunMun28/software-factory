import { describe, expect, it } from 'vitest';

import { errorMessage } from './http-error';

describe('errorMessage', () => {
  it('returns the orchestrator error message', async () => {
    const response = new Response(JSON.stringify({ error: 'Project name already exists' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(errorMessage(response, 'Failed to create project')).resolves.toBe(
      'Project name already exists',
    );
  });

  it('falls back with the response status for a plain-text body', async () => {
    const response = new Response('Internal Server Error', { status: 500 });

    await expect(errorMessage(response, 'Failed to load projects')).resolves.toBe(
      'Failed to load projects (500)',
    );
  });

  it('falls back when JSON has no error field', async () => {
    const response = new Response(JSON.stringify({ detail: 'Unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(errorMessage(response, 'Failed to load models')).resolves.toBe(
      'Failed to load models (503)',
    );
  });
});
