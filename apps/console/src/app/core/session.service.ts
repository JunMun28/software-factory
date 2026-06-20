import { Injectable, signal } from '@angular/core';

import { User, loadStoredUser } from '@sf/shared';

export const ADMIN: User = {
  name: 'Kim P.',
  initials: 'KP',
  color: 'var(--avatar)',
  email: 'kim.park@micron.com',
  role: 'admin',
};

/**
 * Console-local session (ADR 0017 Phase 2). Each app authenticates on its own —
 * the console is the Control center, so its mock session defaults to the ADMIN
 * user/context and the admin guard passes. Real Entra auth (separate app
 * registration) replaces this mock in a later decision. The submitter session
 * lives in apps/intake; there is no cross-app session.
 */
@Injectable({ providedIn: 'root' })
export class Session {
  user = signal<User>(loadStoredUser('sf-console-user', ADMIN));

  signIn(role: 'submitter' | 'admin') {
    const u: User = role === 'admin' ? ADMIN : { ...ADMIN, role: 'submitter' };
    this.user.set(u);
    localStorage.setItem('sf-console-user', JSON.stringify(u));
  }
}
