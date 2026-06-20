import { Routes } from '@angular/router';

import { adminGuard } from './core/guards';

/**
 * Console routes (ADR 0017 Phase 2). The Control center owns the admin world —
 * mission control is the default landing. The /admin path prefix is kept so the
 * shell's nav, command palette, and keyboard shortcuts resolve unchanged after
 * the move from apps/intake.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'admin/mission' },
  { path: 'admin', pathMatch: 'full', redirectTo: 'admin/mission' },
  {
    path: 'admin/map',
    canActivate: [adminGuard],
    loadComponent: () => import('./admin/map').then((m) => m.FactoryMap),
  },
  {
    path: 'admin/mission',
    canActivate: [adminGuard],
    loadComponent: () => import('./admin/mission').then((m) => m.Mission),
  },
  {
    path: 'admin/list',
    canActivate: [adminGuard],
    loadComponent: () => import('./admin/list').then((m) => m.ListView),
  },
  {
    path: 'admin/queue',
    canActivate: [adminGuard],
    loadComponent: () => import('./admin/queue').then((m) => m.ApprovalQueue),
  },
  {
    path: 'admin/requests/:id',
    canActivate: [adminGuard],
    loadComponent: () => import('./admin/request-detail').then((m) => m.RequestDetailPage),
  },
  {
    path: 'admin/apps/:key',
    canActivate: [adminGuard],
    loadComponent: () => import('./admin/feed').then((m) => m.Feed),
  },
  {
    path: 'admin/inbox',
    canActivate: [adminGuard],
    loadComponent: () => import('./admin/inbox').then((m) => m.NeedsMe),
  },
  {
    path: 'admin/registry',
    canActivate: [adminGuard],
    loadComponent: () => import('./admin/registry').then((m) => m.Registry),
  },
  {
    path: 'admin/settings',
    canActivate: [adminGuard],
    loadComponent: () => import('./admin/settings').then((m) => m.Settings),
  },

  { path: '**', redirectTo: 'admin/mission' },
];
