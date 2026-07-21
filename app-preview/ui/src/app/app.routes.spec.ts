import { describe, expect, it } from 'vitest';

import { routes } from './app.routes';
import { AppShell } from './layout/app-shell/app-shell';

describe('app routes', () => {
  it('keeps index pages in the product shell and the builder workspace separate', () => {
    const productShell = routes.find((route) => route.path === '' && route.component === AppShell);
    const childPaths = productShell?.children?.map((route) => route.path);

    expect(childPaths).toEqual([
      '',
      'projects',
      'projects/local',
      'projects/:projectId',
      'chats',
      'design-systems',
    ]);
    expect(productShell?.children?.find((route) => route.path === '')?.redirectTo).toBeUndefined();
    expect(productShell?.children?.find((route) => route.path === 'projects/local')?.redirectTo).toBe(
      'projects/local-workspace',
    );
    expect(
      productShell?.children?.find((route) => route.path === 'projects/:projectId')?.loadComponent,
    ).toBeTypeOf('function');

    const workspace = routes.find((route) => route.path === 'chats/:id');
    expect(workspace?.loadComponent).toBeTypeOf('function');

    const templates = routes.find((route) => route.path === 'templates');
    expect(templates?.loadComponent).toBeTypeOf('function');
  });
});
