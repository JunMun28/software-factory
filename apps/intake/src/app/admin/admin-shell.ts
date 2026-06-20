import { Component, HostListener, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { Api, Autofocus, Avatar, Glyph, Icon, Mark, Poll, Theme } from '@sf/shared';
import { Session } from '../core/session.service';
import { Store } from '../core/store.service';
import { WorldSwitch } from '../kit/world-switch';

/** The Admin Control Center shell — inverted-L: sidebar + header + dense canvas.
 *  Owns the keyboard layer: ⌘K palette, `?` cheat-sheet, C new-request, G-nav. */
@Component({
  selector: 'admin-shell',
  imports: [Mark, Icon, Glyph, Avatar, FormsModule, Autofocus, WorldSwitch],
  template: `
    <div class="adm">
      <aside class="adm-side">
        <div class="adm-brand">
          <sf-mark [size]="18" /><span class="adm-brand__name">Factory</span>
        </div>

        <sf-world-switch world="factory" [full]="true" style="display:block;margin-top:12px" />

        <button
          class="btn primary"
          style="width:100%;justify-content:flex-start;margin-top:10px;margin-bottom:4px"
          (click)="go('/submit/new')"
        >
          <sf-icon name="plus" [size]="16" /> New request
          <kbd class="kbd" style="margin-left:auto">C</kbd>
        </button>

        <div class="adm-seclabel">Primary</div>
        <button class="navrow" [class.on]="active() === 'mission'" (click)="go('/admin/mission')">
          <span class="navrow__ic"><sf-icon name="pipeline" [size]="17" /></span
          ><span class="navrow__label">Mission control</span>
          <span class="navrow__tip">Mission <kbd class="kbd">G</kbd><kbd class="kbd">M</kbd></span>
        </button>
        <button class="navrow" [class.on]="active() === 'map'" (click)="go('/admin/map')">
          <span class="navrow__ic"><sf-icon name="pipeline" [size]="17" /></span
          ><span class="navrow__label">Factory map</span>
          <span class="navrow__tip">Map <kbd class="kbd">G</kbd><kbd class="kbd">O</kbd></span>
        </button>
        <button class="navrow" [class.on]="active() === 'list'" (click)="go('/admin/list')">
          <span class="navrow__ic"><sf-icon name="list" [size]="17" /></span
          ><span class="navrow__label">All requests</span>
          <span class="navrow__tip"
            >All requests <kbd class="kbd">G</kbd><kbd class="kbd">L</kbd></span
          >
        </button>
        <button class="navrow" [class.on]="active() === 'needsme'" (click)="go('/admin/inbox')">
          <span class="navrow__ic"><sf-icon name="inbox" [size]="17" /></span
          ><span class="navrow__label">Needs me</span>
          @if (redCount()) {
            <span class="navrow__count red">{{ redCount() }}</span>
          } @else if (gateCount()) {
            <span class="navrow__count amber">{{ gateCount() }}</span>
          }
          <span class="navrow__tip">Inbox <kbd class="kbd">G</kbd><kbd class="kbd">I</kbd></span>
        </button>
        <button class="navrow" [class.on]="active() === 'queue'" (click)="go('/admin/queue')">
          <span class="navrow__ic"><sf-glyph type="ring" [size]="15" [fill]="0.4" /></span
          ><span class="navrow__label">Gates</span>
          <span class="navrow__tip">Gates <kbd class="kbd">G</kbd><kbd class="kbd">T</kbd></span>
        </button>

        <div class="adm-seclabel">Apps</div>
        @for (a of apps(); track a.id) {
          <button
            class="navrow"
            [class.on]="active() === 'feed:' + a.key"
            (click)="go('/admin/apps/' + a.key)"
          >
            <span class="navrow__ic">
              @if (a.muted) {
                <sf-icon name="mute" [size]="14" />
              } @else {
                <sf-icon name="hash" [size]="15" />
              }
            </span>
            <span class="navrow__label" [style.opacity]="a.muted ? 0.55 : 1">{{ a.name }}</span>
            @if (a.unread) {
              <span class="navrow__dot"></span>
            }
          </button>
        }

        <div style="margin-top:auto;padding-top:10px;border-top:1px solid var(--border)">
          <button
            class="navrow"
            [class.on]="active() === 'registry'"
            (click)="go('/admin/registry')"
          >
            <span class="navrow__ic"><sf-icon name="app" [size]="17" /></span
            ><span class="navrow__label">App registry</span>
            <span class="navrow__tip"
              >Registry <kbd class="kbd">G</kbd><kbd class="kbd">R</kbd></span
            >
          </button>
          <button
            class="navrow"
            [class.on]="active() === 'settings'"
            (click)="go('/admin/settings')"
          >
            <span class="navrow__ic"><sf-icon name="settings" [size]="17" /></span
            ><span class="navrow__label">Settings</span>
            <span class="navrow__tip"
              >Settings <kbd class="kbd">G</kbd><kbd class="kbd">S</kbd></span
            >
          </button>
          <div style="position:relative">
            <button class="navrow" (click)="whoOpen.set(!whoOpen())">
              <sf-avatar [sm]="true" [color]="session.user().color">{{
                session.user().initials
              }}</sf-avatar>
              <span class="navrow__label">{{ session.user().name }}</span>
              <span style="font-size:10.5px;color:var(--faint)">Admin</span>
            </button>
            @if (whoOpen()) {
              <div style="position:fixed;inset:0;z-index:29" (click)="whoOpen.set(false)"></div>
              <div
                style="position:absolute;bottom:calc(100% + 6px);left:0;right:0;z-index:30;background:var(--surface);border:1px solid var(--border);border-radius:9px;box-shadow:var(--shadow-pop);padding:5px"
              >
                <button
                  style="display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:7px 9px;border-radius:6px;border:none;cursor:pointer;font-family:var(--body);font-size:13px;background:none;color:var(--fg2)"
                  (click)="switchRole()"
                >
                  <sf-avatar [sm]="true" color="var(--avatar)">JD</sf-avatar> Switch to Jordan D.
                  <span style="margin-left:auto;font-size:10.5px;color:var(--faint)"
                    >Submitter</span
                  >
                </button>
              </div>
            }
          </div>
        </div>
      </aside>

      <div class="adm-main">
        <header class="adm-head">
          <div class="adm-head__l">
            <span class="adm-title">{{ title() }}</span>
            <ng-content select="[headerExtra]" />
          </div>
          <div class="row" style="gap:11px">
            <ng-content select="[headerRight]" />
            @if (runner(); as mode) {
              <span
                class="chip"
                [class.solid]="mode !== 'claude'"
                [style.color]="mode === 'claude' ? 'var(--accent-tx)' : 'var(--muted)'"
                [style.border-color]="mode === 'claude' ? 'var(--accent-tint-bd)' : ''"
                [style.background]="mode === 'claude' ? 'var(--a50)' : ''"
                title="Which agents drive Stages 2–6 (FACTORY_RUNNER)"
              >
                Agents: {{ mode === 'claude' ? 'Claude Code' : 'simulated' }}
              </span>
            }
            <span class="poll"><span class="dot"></span> Updated {{ syncAgo() }}</span>
            <button class="kpill" (click)="paletteOpen.set(true)">
              <sf-icon name="search" [size]="15" /> Search <kbd class="kbd">⌘K</kbd>
            </button>
            <button
              class="adm-iconbtn"
              (click)="toggleTheme()"
              [attr.aria-label]="
                theme.resolved() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
              "
              [title]="theme.resolved() === 'dark' ? 'Light mode' : 'Dark mode'"
            >
              <sf-icon [name]="theme.resolved() === 'dark' ? 'sun' : 'moon'" [size]="16" />
            </button>
          </div>
        </header>
        <div class="adm-canvas">
          <ng-content />

          <!-- command palette -->
          @if (paletteOpen()) {
            <div class="palette-scrim" (click)="paletteOpen.set(false)">
              <div class="palette" (click)="$event.stopPropagation()">
                <div class="palette__input">
                  <sf-icon name="search" [size]="17" color="var(--muted)" />
                  <input
                    sfAutofocus
                    [ngModel]="query()"
                    (ngModelChange)="query.set($event)"
                    placeholder="Type a command or search…"
                    style="flex:1;border:none;outline:none;font:inherit;color:var(--fg1);background:none"
                    (keydown)="paletteKey($event)"
                  />
                </div>
                <div style="padding:6px">
                  <div class="palette__group">Actions</div>
                  @for (a of filteredActions(); track a.lbl; let i = $index) {
                    <div
                      class="palette__row"
                      [class.on]="palSel() === i"
                      (mouseenter)="palSel.set(i)"
                      (click)="runPalette(a)"
                    >
                      <sf-icon [name]="a.icon" [size]="15" color="var(--muted)" />
                      <span class="palette__lbl">{{ a.lbl }}</span>
                      @if (a.hint) {
                        <kbd class="kbd">{{ a.hint }}</kbd>
                      }
                    </div>
                  }
                  <div class="palette__group">Jump to</div>
                  @for (a of filteredJumps(); track a.lbl; let i = $index) {
                    <div
                      class="palette__row"
                      [class.on]="palSel() === i + filteredActions().length"
                      (mouseenter)="palSel.set(i + filteredActions().length)"
                      (click)="runPalette(a)"
                    >
                      <sf-icon [name]="a.icon" [size]="15" color="var(--muted)" />
                      <span class="palette__lbl">{{ a.lbl }}</span>
                    </div>
                  }
                </div>
                <div class="palette__foot">
                  <span>↑↓ navigate</span><span>↵ select</span><span>esc close</span>
                </div>
              </div>
            </div>
          }

          <!-- keyboard cheat-sheet -->
          @if (cheats()) {
            <div
              class="palette-scrim"
              style="align-items:center;padding-top:0"
              (click)="cheats.set(false)"
            >
              <div
                class="palette"
                style="width:540px;padding:20px 24px;align-self:center"
                (click)="$event.stopPropagation()"
              >
                <div class="row" style="justify-content:space-between;margin-bottom:16px">
                  <h3 style="font-size:19px">Keyboard shortcuts</h3>
                  <span style="font-size:12px;color:var(--faint)">esc to close</span>
                </div>
                <div class="row" style="gap:28px;align-items:flex-start">
                  <div style="flex:1;min-width:0">
                    <div class="palette__group" style="padding:0 0 9px">Navigate</div>
                    <div style="display:flex;flex-direction:column;gap:9px">
                      @for (row of cheatNav; track row[0]) {
                        <div class="row" style="gap:8px">
                          <span style="flex:1;font-size:13px;color:var(--fg2)">{{ row[0] }}</span>
                          <span class="row" style="gap:4px">
                            @for (k of row[1].split(' '); track $index) {
                              <kbd class="kbd">{{ k }}</kbd>
                            }
                          </span>
                        </div>
                      }
                    </div>
                  </div>
                  <div style="flex:1;min-width:0">
                    <div class="palette__group" style="padding:0 0 9px">On the focused item</div>
                    <div style="display:flex;flex-direction:column;gap:9px">
                      @for (row of cheatItem; track row[0]) {
                        <div class="row" style="gap:8px">
                          <span style="flex:1;font-size:13px;color:var(--fg2)">{{ row[0] }}</span>
                          <span class="row" style="gap:4px">
                            @for (k of row[1].split(' '); track $index) {
                              <kbd class="kbd">{{ k }}</kbd>
                            }
                          </span>
                        </div>
                      }
                    </div>
                  </div>
                </div>
                <hr class="divider" style="margin:16px 0 13px" />
                <p style="font-size:12px;color:var(--faint);margin:0;line-height:1.45">
                  Every action is reachable by mouse, the palette, or a key — the same three ways,
                  everywhere.
                </p>
              </div>
            </div>
          }
        </div>
      </div>
    </div>
  `,
})
export class AdminShell {
  private api = inject(Api);
  private router = inject(Router);
  private store = inject(Store);
  session = inject(Session);
  poll = inject(Poll);
  theme = inject(Theme);

  toggleTheme() {
    this.theme.set(this.theme.resolved() === 'dark' ? 'light' : 'dark');
  }

  active = input<string>('mission');
  title = input<string>('Mission control');

  apps = this.store.apps;
  inboxItems = this.store.inbox;
  runner = signal<string | null>(null);
  gateCount = computed(() => this.inboxItems().filter((r) => r.gate).length);
  redCount = computed(() => this.inboxItems().filter((r) => r.needs_human).length);

  paletteOpen = signal(false);
  cheats = signal(false);
  whoOpen = signal(false);
  query = signal('');
  palSel = signal(0);

  cheatNav: [string, string][] = [
    ['Command palette', '⌘ K'],
    ['Mission control', 'G M'],
    ['Factory map', 'G O'],
    ['All requests', 'G L'],
    ['Needs-me inbox', 'G I'],
    ['Gates', 'G T'],
    ['New request', 'C'],
    ['This menu', '?'],
  ];
  cheatItem: [string, string][] = [
    ['Move up / down', 'J K'],
    ['Open', '↵'],
    ['Approve (queue)', 'A'],
    ['Send back (queue)', 'S'],
    ['Cancel request (queue)', 'C'],
    ['Close / back', 'esc'],
  ];

  private gPending = false;
  private gTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.poll.start();
    this.api.health().subscribe((h) => this.runner.set(h.runner));
  }

  syncAgo() {
    const s = Math.max(0, Math.round((Date.now() - this.poll.lastSync()) / 1000));
    return s <= 4 ? 'just now' : `${s}s ago`;
  }

  // ---- palette ----
  paletteActions = [
    {
      icon: 'pipeline',
      lbl: 'Go to Mission control',
      hint: 'G M',
      act: () => this.go('/admin/mission'),
    },
    { icon: 'pipeline', lbl: 'Go to Factory map', hint: 'G O', act: () => this.go('/admin/map') },
    { icon: 'check', lbl: 'Go to Gates', hint: 'G T', act: () => this.go('/admin/queue') },
    { icon: 'list', lbl: 'Go to All requests', hint: 'G L', act: () => this.go('/admin/list') },
    { icon: 'plus', lbl: 'New request', hint: 'C', act: () => this.go('/submit/new') },
    { icon: 'inbox', lbl: 'Go to Needs-me inbox', hint: 'G I', act: () => this.go('/admin/inbox') },
    {
      icon: 'refresh',
      lbl: 'Run factory tick (simulate CI)',
      hint: '',
      act: () => this.api.tick().subscribe(() => this.poll.nudge()),
    },
  ];
  filteredActions = computed(() => {
    const q = this.query().toLowerCase();
    return this.paletteActions.filter((a) => !q || a.lbl.toLowerCase().includes(q));
  });
  filteredJumps = computed(() => {
    const q = this.query().toLowerCase();
    return this.apps()
      .filter((a) => !q || a.name.toLowerCase().includes(q))
      .map((a) => ({
        icon: 'hash',
        lbl: a.name,
        hint: '',
        act: () => this.go('/admin/apps/' + a.key),
      }));
  });
  paletteKey(e: KeyboardEvent) {
    const all = [...this.filteredActions(), ...this.filteredJumps()];
    if (e.key === 'Escape') {
      this.paletteOpen.set(false);
      this.query.set('');
      this.palSel.set(0);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.palSel.update((s) => Math.min(all.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.palSel.update((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const a = all[this.palSel()];
      if (a) this.runPalette(a);
    }
  }
  runPalette(a: { act: () => void }) {
    a.act();
    this.paletteOpen.set(false);
    this.query.set('');
    this.palSel.set(0);
  }

  go(url: string) {
    this.router.navigateByUrl(url);
  }

  switchRole() {
    this.whoOpen.set(false);
    this.session.signIn('submitter');
    this.router.navigateByUrl('/requests');
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    const typing = tag === 'input' || tag === 'textarea';
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.paletteOpen.update((o) => !o);
      return;
    }
    // Esc closes overlays even while an input inside them has focus
    if (e.key === 'Escape') {
      this.paletteOpen.set(false);
      this.cheats.set(false);
      return;
    }
    if (typing) return;
    if (this.gPending) {
      const k = e.key.toLowerCase();
      const nav: Record<string, string> = {
        m: '/admin/mission',
        o: '/admin/map',
        l: '/admin/list',
        i: '/admin/inbox',
        t: '/admin/queue',
        r: '/admin/registry',
        s: '/admin/settings',
        a: '/admin/apps/' + (this.apps()[0]?.key ?? 'northwind'),
        f: '/admin/apps/' + (this.apps()[0]?.key ?? 'northwind'),
      };
      if (nav[k]) {
        e.preventDefault();
        this.go(nav[k]);
      }
      this.gPending = false;
      if (this.gTimer) clearTimeout(this.gTimer);
      return;
    }
    if (e.key.toLowerCase() === 'g') {
      this.gPending = true;
      this.gTimer = setTimeout(() => (this.gPending = false), 900);
      return;
    }
    // C = New request everywhere except surfaces that own the C key (queue cancels the
    // focused item; request-detail cancels the request) — there C must not double-fire.
    if (
      e.key === 'c' &&
      !this.paletteOpen() &&
      this.active() !== 'queue' &&
      this.active() !== 'request-detail'
    ) {
      e.preventDefault();
      this.go('/submit/new');
      return;
    }
    if (e.key === '?' && !this.paletteOpen()) {
      this.cheats.update((c) => !c);
    }
  }
}
