import { Injectable, signal } from '@angular/core';

export interface User {
  name: string;
  initials: string;
  color: string;
  email: string;
  role: 'submitter' | 'admin';
}

export const SUBMITTER: User = { name: 'Jordan D.', initials: 'JD', color: '#7A6E9A', email: 'jordan.diaz@micron.com', role: 'submitter' };
export const ADMIN: User = { name: 'Kim P.', initials: 'KP', color: '#6E5A8A', email: 'kim.park@micron.com', role: 'admin' };

@Injectable({ providedIn: 'root' })
export class Session {
  user = signal<User>(this.load());

  private load(): User {
    try {
      const raw = localStorage.getItem('sf-user');
      if (raw) return JSON.parse(raw);
    } catch { /* fresh session */ }
    return SUBMITTER;
  }

  signIn(role: 'submitter' | 'admin') {
    const u = role === 'admin' ? ADMIN : SUBMITTER;
    this.user.set(u);
    localStorage.setItem('sf-user', JSON.stringify(u));
  }
}
