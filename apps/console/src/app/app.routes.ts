import { Routes } from '@angular/router';

import { adminGuard } from './core/guards';

export const legacyRedirects: Routes = [
  { path: 'admin', pathMatch: 'full', redirectTo: '' },
  { path: 'admin/mission', pathMatch: 'full', redirectTo: '' },
  { path: 'admin/map', pathMatch: 'full', redirectTo: '' },
  { path: 'admin/queue', pathMatch: 'full', redirectTo: '' },
  { path: 'admin/inbox', pathMatch: 'full', redirectTo: '' },
  { path: 'admin/list', pathMatch: 'full', redirectTo: 'library' },
  { path: 'admin/registry', pathMatch: 'full', redirectTo: 'studio' },
  { path: 'admin/settings', pathMatch: 'full', redirectTo: 'studio' },
  { path: 'admin/requests/:id', redirectTo: 'requests/:id' },
  { path: 'admin/apps/:key', redirectTo: 'library' },
];

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    canActivate: [adminGuard],
    loadComponent: () => import('./floor/floor-page').then((m) => m.FloorPage),
  },
  /* The previous tabbed Overview, kept reachable while the new one settles.
     Same page component and the same action plumbing — only the body differs. */
  {
    path: 'overview-classic',
    canActivate: [adminGuard],
    data: { classic: true },
    loadComponent: () => import('./floor/floor-page').then((m) => m.FloorPage),
  },
  {
    path: 'library',
    canActivate: [adminGuard],
    loadComponent: () => import('./library/library-page').then((m) => m.LibraryPage),
  },
  {
    path: 'studio',
    loadComponent: () => import('./studio/studio-page').then((m) => m.StudioPage),
  },
  {
    path: 'requests/:id',
    canActivate: [adminGuard],
    loadComponent: () => import('./dossier/dossier-page').then((m) => m.DossierPage),
  },
  ...legacyRedirects,
  { path: '**', redirectTo: '' },
];
