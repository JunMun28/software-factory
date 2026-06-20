import { Routes } from '@angular/router';

/**
 * Console routes (ADR 0017 Phase 2). One placeholder route for now; the admin
 * world (mission/list/queue/...) moves in during the next slice.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./home').then((m) => m.ConsoleHome),
  },
  { path: '**', redirectTo: '' },
];
