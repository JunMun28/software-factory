import { Injectable, computed, signal } from '@angular/core';

import { FactoryAuth, User, loadStoredUser } from '@sf/shared';

export const SUBMITTER: User = {
  name: 'Jordan Diaz',
  initials: 'JD',
  color: 'var(--avatar)',
  email: 'jordan.diaz@example.com',
  role: 'submitter',
};
export const ADMIN: User = {
  name: 'Kim P.',
  initials: 'KP',
  color: 'var(--avatar)',
  email: 'kim.park@example.com',
  role: 'admin',
};

/** SEC-01: map the signed-in Entra account onto the app's User shape. Pure —
 *  exported for the spec. Role: the Entra `admin` app role wins; everyone else
 *  is a submitter here (the intake app has no viewer concept). */
export function userFromAccount(name: string, email: string, roles: string[]): User {
  const clean = (name || email.split('@')[0] || 'Unknown').trim();
  const initials =
    clean
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || email.slice(0, 2).toUpperCase();
  return {
    name: clean,
    initials,
    color: 'var(--avatar)',
    email,
    role: roles.includes('admin') ? 'admin' : 'submitter',
  };
}

@Injectable({ providedIn: 'root' })
export class Session {
  /** Demo identity — only meaningful while FACTORY_AUTH=off. */
  private stored = signal<User>(loadStoredUser('sf-user', SUBMITTER));

  // Constructor default keeps `new Session()` working in specs (a bare
  // FactoryAuth is mode 'unknown' -> the stored/demo path); inject() would
  // require an injection context the specs don't have.
  // eslint-disable-next-line @angular-eslint/prefer-inject
  constructor(private auth: FactoryAuth = new FactoryAuth()) {}

  /** The acting user: the Entra account when the auth wall is on (server
   *  re-stamps identity anyway — this keeps the UI honest), else the stored
   *  demo user exactly as before. */
  user = computed<User>(() => {
    const account = this.auth.account();
    if (!this.auth.active || !account) return this.stored();
    return userFromAccount(account.name ?? '', account.username, this.auth.roles());
  });

  signIn(role: 'submitter' | 'admin') {
    const u = role === 'admin' ? ADMIN : SUBMITTER;
    this.stored.set(u);
    localStorage.setItem('sf-user', JSON.stringify(u));
  }
}
