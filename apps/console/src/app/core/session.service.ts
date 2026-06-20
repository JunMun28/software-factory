import { Injectable, signal } from '@angular/core';

export interface User {
  name: string;
  initials: string;
  color: string;
  email: string;
  role: 'submitter' | 'admin';
}

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
  user = signal<User>(this.load());

  private load(): User {
    try {
      const raw = localStorage.getItem('sf-console-user');
      if (raw) {
        const u = JSON.parse(raw);
        // a stale blob from an older User shape silently breaks avatars and the
        // role guard — validate the shape and discard on mismatch
        if (
          u &&
          typeof u.name === 'string' &&
          typeof u.initials === 'string' &&
          typeof u.color === 'string' &&
          (u.role === 'submitter' || u.role === 'admin')
        ) {
          return u as User;
        }
        localStorage.removeItem('sf-console-user');
      }
    } catch {
      /* fresh session */
    }
    return ADMIN;
  }

  signIn(role: 'submitter' | 'admin') {
    const u: User = role === 'admin' ? ADMIN : { ...ADMIN, role: 'submitter' };
    this.user.set(u);
    localStorage.setItem('sf-console-user', JSON.stringify(u));
  }
}
