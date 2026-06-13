import { Component, inject } from '@angular/core';

import { Theme } from '../core/theme.service';
import { Glyph, Icon, PopMenu } from '../kit/kit';
import { AdminShell } from './admin-shell';

interface EvtPrefs {
  inApp: boolean;
  email: boolean;
  digest: boolean;
}

/** C8 — Settings: three event classes × three channels; Tier-1 in-app is locked on.
 *  Demo-only preview: the notification prefs persist nothing — the live per-channel
 *  follow level lives on each app feed (feed.ts). */
@Component({
  selector: 'sf-settings-page',
  imports: [AdminShell, Glyph, Icon, PopMenu],
  template: `
    <admin-shell active="settings" title="Settings">
      <span headerRight class="row" style="gap:8px">
        <span class="chip">Preview</span>
        <span class="row" style="gap:6px;font-size:12.5px;color:var(--green)">
          <sf-glyph type="check" [size]="14" color="var(--green)" /> Saved
        </span>
      </span>
      <div class="settings-col scroll">
        <div class="settings-inner">
          <h2 style="font-size:20px">Notifications</h2>
          <p style="font-size:13.5px;color:var(--muted);margin:4px 0 18px">
            Three classes of event, three ways to reach you. Tier-1 events always reach you in-app —
            you can only route the copies.
          </p>
          <div class="evt-grid" style="padding-bottom:8px;border-bottom:1px solid var(--border)">
            <span></span><span class="evt-head">In-app</span><span class="evt-head">Email</span
            ><span class="evt-head">Digest</span>
          </div>
          @for (row of rows; track row.key) {
            <div class="evt-row evt-grid">
              <div class="row" style="gap:11px;align-items:flex-start">
                <sf-glyph [type]="row.glyph" [size]="16" [color]="row.color" [fill]="0.5" />
                <div>
                  <div class="evt-label">{{ row.label }}</div>
                  <div class="evt-sub">{{ row.sub }}</div>
                </div>
              </div>
              <span style="justify-self:center" class="row"
                ><span class="row" style="gap:6px">
                  <button
                    class="toggle"
                    [class.on]="prefs[row.key].inApp"
                    [class.locked]="row.locked"
                    (click)="!row.locked && flip(row.key, 'inApp')"
                  >
                    <span class="toggle__knob"></span>
                  </button>
                  @if (row.locked) {
                    <sf-icon name="lock" [size]="13" color="var(--faint)" />
                  }</span
              ></span>
              <span style="justify-self:center"
                ><button
                  class="toggle"
                  [class.on]="prefs[row.key].email"
                  (click)="flip(row.key, 'email')"
                >
                  <span class="toggle__knob"></span></button
              ></span>
              <span style="justify-self:center"
                ><button
                  class="toggle"
                  [class.on]="prefs[row.key].digest"
                  (click)="flip(row.key, 'digest')"
                >
                  <span class="toggle__knob"></span></button
              ></span>
            </div>
          }
          <div class="row" style="padding:15px 0;border-bottom:1px solid var(--hairline)">
            <span style="flex:1;font-size:14px;font-weight:500">Daily digest at</span>
            <span style="position:relative">
              <button class="btn sm" (click)="digestOpen = !digestOpen">
                {{ digest }} <sf-icon name="chevDown" [size]="13" />
              </button>
              <sf-pop-menu [open]="digestOpen" [width]="140" (closed)="digestOpen = false">
                @for (t of digestTimes; track t) {
                  <button
                    class="pop__opt"
                    [class.on]="digest === t"
                    (click)="digest = t; digestOpen = false"
                  >
                    {{ t }}
                  </button>
                }
              </sf-pop-menu>
            </span>
          </div>
          <div class="card" style="margin-top:18px;padding:18px 20px">
            <h2 style="font-size:20px">Appearance</h2>
            <div class="row" style="margin-top:14px;gap:8px">
              <div class="seg">
                <button [class.on]="theme.choice() === 'light'" (click)="theme.set('light')">
                  Light
                </button>
                <button [class.on]="theme.choice() === 'dark'" (click)="theme.set('dark')">
                  Dark
                </button>
                <button [class.on]="theme.choice() === 'system'" (click)="theme.set('system')">
                  System
                </button>
              </div>
              <span style="font-size:12.5px;color:var(--muted)"
                >Follows your device when set to System.</span
              >
            </div>
          </div>
        </div>
      </div>
    </admin-shell>
  `,
})
export class Settings {
  protected theme = inject(Theme);
  digest = '08:00 PT';
  digestOpen = false;
  digestTimes = ['07:00 PT', '08:00 PT', '09:00 PT', '17:00 PT'];

  rows: {
    key: string;
    glyph: string;
    color: string;
    label: string;
    sub: string;
    locked?: boolean;
  }[] = [
    {
      key: 'gate',
      glyph: 'ring',
      color: 'var(--amber)',
      label: 'Gate events',
      sub: 'A spec is waiting on your approval.',
      locked: true,
    },
    {
      key: 'human',
      glyph: 'flag',
      color: 'var(--red)',
      label: 'Needs-human',
      sub: 'A build was escalated and needs a person.',
      locked: true,
    },
    {
      key: 'progress',
      glyph: 'dotted',
      color: 'var(--faint)',
      label: 'Progress',
      sub: 'Milestones in apps you follow (Building, Deployed…).',
    },
  ];
  prefs: Record<string, EvtPrefs> = {
    gate: { inApp: true, email: true, digest: false },
    human: { inApp: true, email: false, digest: false },
    progress: { inApp: false, email: false, digest: true },
  };

  flip(key: string, ch: keyof EvtPrefs) {
    this.prefs[key][ch] = !this.prefs[key][ch];
  }
}
