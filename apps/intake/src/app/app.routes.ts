import { Routes } from '@angular/router';

/**
 * Intake routes (ADR 0017 Phase 2). Submitter-only since the app split — the
 * admin world (mission/list/queue/...) and its guard moved to apps/console.
 * No login front door: the session defaults to the submitter, so the app opens
 * straight onto the submit/* intake flow.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'submit/new' },
  {
    path: 'submit/new',
    loadComponent: () => import('./submitter/new-request').then((m) => m.NewRequest),
  },
  {
    path: 'submit/:id/interview',
    loadComponent: () => import('./submitter/interview').then((m) => m.Interview),
  },
  {
    path: 'submit/:id/prototype',
    loadComponent: () => import('./submitter/prototype').then((m) => m.Prototype),
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

  { path: '**', redirectTo: 'submit/new' },
];
