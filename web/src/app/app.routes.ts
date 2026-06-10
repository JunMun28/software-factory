import { Routes } from '@angular/router';

import { adminGuard } from './core/guards';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },
  { path: 'login', loadComponent: () => import('./submitter/login').then((m) => m.Login) },
  { path: 'submit/new', loadComponent: () => import('./submitter/new-request').then((m) => m.NewRequest) },
  { path: 'submit/:id/interview', loadComponent: () => import('./submitter/interview').then((m) => m.Interview) },
  { path: 'submit/:id/review', loadComponent: () => import('./submitter/review').then((m) => m.Review) },
  { path: 'submit/:id/done', loadComponent: () => import('./submitter/confirm').then((m) => m.Confirm) },
  { path: 'requests', loadComponent: () => import('./submitter/my-requests').then((m) => m.MyRequests) },
  { path: 'requests/:id', loadComponent: () => import('./submitter/request-detail').then((m) => m.SubRequestDetail) },

  { path: 'admin', pathMatch: 'full', redirectTo: 'admin/pipeline' },
  { path: 'admin/pipeline', canActivate: [adminGuard], loadComponent: () => import('./admin/pipeline').then((m) => m.Pipeline) },
  { path: 'admin/board', canActivate: [adminGuard], loadComponent: () => import('./admin/board').then((m) => m.Board) },
  { path: 'admin/list', canActivate: [adminGuard], loadComponent: () => import('./admin/list').then((m) => m.ListView) },
  { path: 'admin/queue', canActivate: [adminGuard], loadComponent: () => import('./admin/queue').then((m) => m.ApprovalQueue) },
  { path: 'admin/issue/:id', canActivate: [adminGuard], loadComponent: () => import('./admin/issue').then((m) => m.IssueDetail) },
  { path: 'admin/apps/:key', canActivate: [adminGuard], loadComponent: () => import('./admin/feed').then((m) => m.Feed) },
  { path: 'admin/inbox', canActivate: [adminGuard], loadComponent: () => import('./admin/inbox').then((m) => m.NeedsMe) },
  { path: 'admin/registry', canActivate: [adminGuard], loadComponent: () => import('./admin/registry').then((m) => m.Registry) },
  { path: 'admin/settings', canActivate: [adminGuard], loadComponent: () => import('./admin/settings').then((m) => m.Settings) },

  { path: '**', redirectTo: 'login' },
];
