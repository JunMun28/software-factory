import { Injectable, signal } from '@angular/core';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'sf-theme';

/** Single source of truth for the color theme (spec §7). The choice persists to
 *  localStorage; 'system' follows prefers-color-scheme live. The resolved value
 *  is written to <html data-theme>, matching the index.html pre-paint script. */
@Injectable({ providedIn: 'root' })
export class Theme {
  choice = signal<ThemeChoice>(this.read());
  private mq = matchMedia('(prefers-color-scheme: dark)');

  constructor() {
    this.mq.addEventListener('change', () => {
      if (this.choice() === 'system') this.apply();
    });
    this.apply();
  }

  set(choice: ThemeChoice) {
    this.choice.set(choice);
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      /* private mode — in-memory only */
    }
    this.apply();
  }

  /** The resolved light|dark actually in effect. */
  resolved(): 'light' | 'dark' {
    const c = this.choice();
    return c === 'dark' || (c === 'system' && this.mq.matches) ? 'dark' : 'light';
  }

  private apply() {
    document.documentElement.dataset['theme'] = this.resolved();
  }
  private read(): ThemeChoice {
    try {
      const v = localStorage.getItem(KEY);
      if (v === 'light' || v === 'dark' || v === 'system') return v;
    } catch {
      /* ignore */
    }
    return 'system';
  }
}
