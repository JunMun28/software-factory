import { Injectable, signal } from '@angular/core';

import { User, loadStoredUser } from '@sf/shared';

export const SUBMITTER: User = {
  name: 'Jordan D.',
  initials: 'JD',
  color: 'var(--avatar)',
  email: 'jordan.diaz@micron.com',
  role: 'submitter',
};
export const ADMIN: User = {
  name: 'Kim P.',
  initials: 'KP',
  color: 'var(--avatar)',
  email: 'kim.park@micron.com',
  role: 'admin',
};

@Injectable({ providedIn: 'root' })
export class Session {
  user = signal<User>(loadStoredUser('sf-user', SUBMITTER));

  signIn(role: 'submitter' | 'admin') {
    const u = role === 'admin' ? ADMIN : SUBMITTER;
    this.user.set(u);
    localStorage.setItem('sf-user', JSON.stringify(u));
  }
}
