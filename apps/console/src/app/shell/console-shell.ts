import { Component, HostListener, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { Api, Autofocus, Poll, Theme } from '@sf/shared';

import { INTAKE_URL, intakeNewRequestUrl } from '../core/intake-url';
import { Session } from '../core/session.service';

@Component({
  selector: 'sf-console-shell',
  imports: [RouterLink, RouterLinkActive, Autofocus],
  template: `
    <div class="wrap">
      <header class="bar">
        <a class="mark" routerLink="/" aria-label="Software Factory, The Floor"
          ><i></i><span class="mark-name">Software Factory</span></a
        >
        <nav aria-label="Primary navigation">
          <a routerLink="/" [routerLinkActiveOptions]="{ exact: true }" routerLinkActive="active"
            >Floor</a
          >
          <a routerLink="/library" routerLinkActive="active">Library</a>
          <a routerLink="/studio" routerLinkActive="active">Studio</a>
        </nav>
        <span class="spacer"></span>
        <button
          class="theme"
          type="button"
          (click)="toggleTheme()"
          [attr.aria-label]="
            theme.resolved() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
          "
        >
          {{ theme.resolved() === 'dark' ? '☀' : '◐' }}
        </button>
        <button
          class="cmd"
          type="button"
          (click)="paletteOpen.set(true)"
          aria-label="Open command palette"
        >
          ⌘K
        </button>
        <span class="operator" [title]="session.user().name">{{ session.user().initials }}</span>
      </header>
      <main><ng-content /></main>
    </div>
    @if (paletteOpen()) {
      <div class="backdrop" role="presentation" (click)="paletteOpen.set(false)">
        <section
          class="palette"
          role="dialog"
          aria-modal="true"
          aria-labelledby="palette-title"
          (click)="$event.stopPropagation()"
        >
          <h2 id="palette-title">Go somewhere</h2>
          <input
            sfAutofocus
            class="palette-input"
            type="text"
            placeholder="Type a command…"
            aria-label="Filter commands"
            [value]="query()"
            (input)="query.set($any($event.target).value); paletteIndex.set(0)"
          />
          @for (action of filteredActions(); track action.label; let i = $index) {
            <button type="button" [class.selected]="i === paletteIndex()" (click)="run(action)">
              <span>{{ action.label }}</span
              ><kbd>{{ action.hint }}</kbd>
            </button>
          } @empty {
            <p class="no-match">Nothing matches. Try Floor, Library, or Studio.</p>
          }
        </section>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      min-height: 100%;
    }
    .wrap {
      max-width: 1060px;
      margin: 0 auto;
      padding: 0 clamp(18px, 4vw, 48px);
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 24px;
      min-height: 63px;
      border-bottom: 1px solid var(--hairline);
    }
    .mark {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--fg1);
      font: 700 15.5px var(--display);
      text-decoration: none;
    }
    .mark i {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      background: var(--accent);
    }
    nav {
      display: flex;
      gap: 4px;
    }
    nav a {
      padding: 6px 12px;
      color: var(--muted);
      border-radius: var(--r-pill);
      font-size: 13.5px;
      font-weight: 600;
      text-decoration: none;
    }
    nav a:hover {
      color: var(--fg1);
      background: var(--surface-2);
    }
    nav a.active {
      color: var(--accent-tx);
      background: var(--accent-tint);
    }
    .spacer {
      flex: 1;
    }
    .cmd,
    .theme {
      color: var(--muted);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r);
      cursor: pointer;
    }
    .cmd {
      padding: 4px 9px;
      font: 500 11.5px var(--mono);
    }
    .theme {
      width: 30px;
      height: 30px;
      font-size: 15px;
    }
    .operator {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      color: var(--accent-tx);
      background: var(--accent-tint);
      border: 1px solid var(--accent-tint-bd);
      border-radius: 50%;
      font-size: 11px;
      font-weight: 700;
    }
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: start center;
      padding-top: min(18vh, 150px);
      background: rgba(15, 12, 20, 0.4);
    }
    .palette {
      width: min(520px, calc(100vw - 32px));
      padding: 12px;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--r-lg);
      box-shadow: var(--shadow-overlay);
    }
    .palette h2 {
      padding: 8px 10px 12px;
      font-size: 15px;
    }
    .palette-input {
      width: 100%;
      margin-bottom: 8px;
      padding: 9px 12px;
      color: var(--fg1);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r);
      font: 400 13.5px var(--body);
      outline: none;
    }
    .palette-input:focus-visible {
      border-color: var(--accent);
    }
    .no-match {
      padding: 10px 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .palette button {
      display: flex;
      width: 100%;
      justify-content: space-between;
      padding: 10px 12px;
      color: var(--fg2);
      background: transparent;
      border: 0;
      border-radius: var(--r);
      text-align: left;
      cursor: pointer;
    }
    .palette button:hover,
    .palette button.selected {
      color: var(--fg1);
      background: var(--surface-2);
    }
    kbd {
      color: var(--faint);
      font: 500 11px var(--mono);
    }
    @media (max-width: 640px) {
      .bar {
        gap: 10px;
      }
      .mark-name {
        display: none;
      }
      nav a {
        padding: 6px 9px;
        font-size: 13px;
      }
      .theme {
        display: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      * {
        transition: none !important;
      }
    }
  `,
})
export class ConsoleShell {
  active = input('floor');
  private router = inject(Router);
  private api = inject(Api);
  private poll = inject(Poll);
  private intakeUrl = inject(INTAKE_URL);
  session = inject(Session);
  theme = inject(Theme);
  paletteOpen = signal(false);
  paletteIndex = signal(0);
  query = signal('');
  private gPending = false;
  private gTimer: ReturnType<typeof setTimeout> | null = null;

  newRequestUrl = computed(() => intakeNewRequestUrl(this.intakeUrl));
  actions = [
    { label: 'Go to The Floor', hint: 'G F', path: '/' },
    { label: 'Go to Library', hint: 'G L', path: '/library' },
    { label: 'Go to Studio', hint: 'G S', path: '/studio' },
    { label: 'New request', hint: 'C', path: 'intake' },
    { label: 'Run factory tick', hint: '', path: 'tick' },
  ];
  filteredActions = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.actions.filter((action) => !q || action.label.toLowerCase().includes(q));
  });

  constructor() {
    this.poll.start();
  }

  toggleTheme() {
    this.theme.set(this.theme.resolved() === 'dark' ? 'light' : 'dark');
  }
  run(action: (typeof this.actions)[number]) {
    this.closePalette();
    if (action.path === 'intake') window.location.assign(this.newRequestUrl());
    else if (action.path === 'tick') this.api.tick().subscribe(() => this.poll.nudge());
    else this.router.navigateByUrl(action.path);
  }
  private closePalette() {
    this.paletteOpen.set(false);
    this.query.set('');
    this.paletteIndex.set(0);
  }

  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent) {
    const tag = (event.target as HTMLElement)?.tagName?.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (this.paletteOpen()) this.closePalette();
      else this.paletteOpen.set(true);
      return;
    }
    if (event.key === 'Escape') {
      this.closePalette();
      return;
    }
    if (this.paletteOpen()) {
      const shown = this.filteredActions();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.paletteIndex.update((i) => Math.min(shown.length - 1, i + 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.paletteIndex.update((i) => Math.max(0, i - 1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const action = shown[this.paletteIndex()];
        if (action) this.run(action);
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (tag === 'input' || tag === 'textarea' || tag === 'button') return;
    if (this.gPending) {
      const target = {
        f: '/',
        m: '/',
        o: '/',
        t: '/',
        i: '/',
        l: '/library',
        s: '/studio',
        r: '/studio',
      }[event.key.toLowerCase()];
      this.gPending = false;
      if (this.gTimer) clearTimeout(this.gTimer);
      if (target) {
        event.preventDefault();
        this.router.navigateByUrl(target);
      }
      return;
    }
    if (event.key.toLowerCase() === 'g') {
      this.gPending = true;
      this.gTimer = setTimeout(() => (this.gPending = false), 900);
    } else if (event.key.toLowerCase() === 'c') {
      event.preventDefault();
      window.location.assign(this.newRequestUrl());
    } else if (event.key === '?') {
      // Discoverability: `?` opens the palette, which lists every chord.
      this.paletteOpen.set(true);
    }
  }
}
