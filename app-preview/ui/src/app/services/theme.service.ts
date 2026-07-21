import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'ng-v0-theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  // index.html applies the initial class pre-boot; mirror it here.
  readonly theme = signal<'light' | 'dark'>(
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  );

  toggle(): void {
    const next = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    localStorage.setItem(STORAGE_KEY, next);
  }
}
