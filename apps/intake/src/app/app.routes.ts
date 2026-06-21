import { Routes } from '@angular/router';

/**
 * Intake routes (ADR 0017 Phase 2). Submitter-only since the app split — the
 * admin world (mission/list/queue/...) and its guard moved to apps/console.
 * Intake keeps just login + the submit/* intake flow + requests/*.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },
  { path: 'login', loadComponent: () => import('./submitter/login').then((m) => m.Login) },
  {
    path: 'submit/new',
    loadComponent: () => import('./submitter/new-request').then((m) => m.NewRequest),
  },
  {
    path: 'submit/:id/interview',
    loadComponent: () => import('./submitter/interview').then((m) => m.Interview),
  },
  {
    path: 'submit/:id/review',
    loadComponent: () => import('./submitter/review').then((m) => m.Review),
  },
  {
    path: 'submit/:id/done',
    loadComponent: () => import('./submitter/confirm').then((m) => m.Confirm),
  },
  {
    path: 'requests',
    loadComponent: () => import('./submitter/my-requests').then((m) => m.MyRequests),
  },
  {
    path: 'requests/:id',
    loadComponent: () => import('./submitter/request-detail').then((m) => m.SubRequestDetail),
  },

  { path: '**', redirectTo: 'login' },
];
