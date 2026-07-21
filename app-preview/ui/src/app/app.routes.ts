import { Routes } from '@angular/router';

import { AppShell } from './layout/app-shell/app-shell';

export const routes: Routes = [
  {
    path: '',
    component: AppShell,
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () =>
          import('./chats/chat-empty/chat-empty').then((m) => m.ChatEmpty),
      },
      {
        path: 'projects',
        loadComponent: () =>
          import('./pages/projects-page/projects-page').then((m) => m.ProjectsPage),
      },
      {
        path: 'projects/local',
        pathMatch: 'full',
        redirectTo: 'projects/local-workspace',
      },
      {
        path: 'projects/:projectId',
        loadComponent: () =>
          import('./pages/project-detail-page/project-detail-page').then(
            (m) => m.ProjectDetailPage,
          ),
      },
      {
        path: 'chats',
        loadComponent: () =>
          import('./pages/chats-page/chats-page').then((m) => m.ChatsPage),
      },
      {
        path: 'design-systems',
        loadComponent: () =>
          import('./pages/design-systems-page/design-systems-page').then(
            (m) => m.DesignSystemsPage,
          ),
      },
    ],
  },
  {
    // ng-v0 bridge landing — must precede 'chats/:id' so 'new' is not read as an id.
    path: 'chats/new',
    loadComponent: () =>
      import('./pages/chat-new-page/chat-new-page').then((m) => m.ChatNewPage),
  },
  {
    path: 'chats/:id',
    loadComponent: () =>
      import('./layout/chat-workspace/chat-workspace').then((m) => m.ChatWorkspace),
  },
  {
    path: 'templates',
    loadComponent: () =>
      import('./pages/templates-page/templates-page').then((m) => m.TemplatesPage),
  },
  { path: '**', redirectTo: '' },
];
