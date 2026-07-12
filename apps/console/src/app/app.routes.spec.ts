import { describe, expect, it } from 'vitest';

import { legacyRedirects, routes } from './app.routes';

describe('legacy console routes', () => {
  it('keeps the root route exact so Library, Studio, and Dossiers remain reachable', () => {
    expect(routes.find((route) => route.path === '')?.pathMatch).toBe('full');
  });

  it.each([
    ['admin', ''],
    ['admin/mission', ''],
    ['admin/map', ''],
    ['admin/queue', ''],
    ['admin/inbox', ''],
    ['admin/list', 'library'],
    ['admin/registry', 'studio'],
    ['admin/settings', 'studio'],
    ['admin/requests/:id', 'requests/:id'],
  ])('redirects /%s to /%s', (path, redirectTo) => {
    expect(legacyRedirects.find((route) => route.path === path)?.redirectTo).toBe(redirectTo);
  });
});
