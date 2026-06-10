import { Component, effect, inject, signal } from '@angular/core';

import { Api } from '../core/api.service';
import { AppEntry } from '../core/models';
import { Poll } from '../core/poll.service';
import { Glyph, Icon } from '../kit/kit';
import { AdminShell } from './admin-shell';

interface EvtPrefs { inApp: boolean; email: boolean; digest: boolean }

/** C8 — Settings: three event classes × three channels; Tier-1 in-app is locked on. */
@Component({
  selector: 'sf-settings-page',
  imports: [AdminShell, Glyph, Icon],
  template: `
    <admin-shell active="settings" title="Settings">
      <span headerRight class="row" style="gap:6px;font-size:12.5px;color:var(--green)">
        <sf-glyph type="check" [size]="14" color="var(--green)" /> Saved
      </span>
      <div class="settings-col scroll">
        <div class="settings-inner">
          <h2 style="font-size:20px">Notifications</h2>
          <p style="font-size:13.5px;color:var(--muted);margin:4px 0 18px">Three classes of event, three ways to reach you. Tier-1 events always reach you in-app — you can only route the copies.</p>
          <div class="evt-grid" style="padding-bottom:8px;border-bottom:1px solid var(--border)">
            <span></span><span class="evt-head">In-app</span><span class="evt-head">Email</span><span class="evt-head">Digest</span>
          </div>
          @for (row of rows; track row.key) {
            <div class="evt-row evt-grid">
              <div class="row" style="gap:11px;align-items:flex-start">
                <sf-glyph [type]="row.glyph" [size]="16" [color]="row.color" [fill]="0.5" />
                <div><div class="evt-label">{{ row.label }}</div><div class="evt-sub">{{ row.sub }}</div></div>
              </div>
              <span style="justify-self:center" class="row"><span class="row" style="gap:6px">
                <button class="toggle" [class.on]="prefs[row.key].inApp" [class.locked]="row.locked" (click)="!row.locked && flip(row.key, 'inApp')"><span class="toggle__knob"></span></button>
                @if (row.locked) { <sf-icon name="lock" [size]="13" color="var(--faint)" /> }
              </span></span>
              <span style="justify-self:center"><button class="toggle" [class.on]="prefs[row.key].email" (click)="flip(row.key, 'email')"><span class="toggle__knob"></span></button></span>
              <span style="justify-self:center"><button class="toggle" [class.on]="prefs[row.key].digest" (click)="flip(row.key, 'digest')"><span class="toggle__knob"></span></button></span>
            </div>
          }
          <div class="row" style="padding:15px 0;border-bottom:1px solid var(--hairline)">
            <span style="flex:1;font-size:14px;font-weight:500">Daily digest at</span>
            <button class="btn sm">08:00 PT <sf-icon name="chevDown" [size]="13" /></button>
          </div>

          <div style="font-size:10.5px;font-weight:600;letter-spacing:.11em;text-transform:uppercase;color:var(--faint);margin:22px 0 10px">Per-app follow level</div>
          @for (a of apps(); track a.id) {
            <div class="row" style="gap:9px;padding:10px 0;border-bottom:1px solid var(--hairline)">
              @if (follow[a.key] === 'Muted') { <sf-icon name="mute" [size]="14" color="var(--faint)" /> } @else { <span style="color:var(--faint)">#</span> }
              <span style="flex:1;font-size:14px" [style.color]="follow[a.key] === 'Muted' ? 'var(--muted)' : 'var(--fg1)'">{{ a.name }}</span>
              <div class="seg">
                @for (o of levels; track o) {
                  <button [class.on]="follow[a.key] === o" (click)="follow[a.key] = o">{{ o }}</button>
                }
              </div>
            </div>
          }
        </div>
      </div>
    </admin-shell>
  `,
})
export class Settings {
  private api = inject(Api);
  private poll = inject(Poll);

  apps = signal<AppEntry[]>([]);
  levels = ['All', 'Gate + Needs-human', 'Muted'];
  follow: Record<string, string> = {};

  rows: { key: string; glyph: string; color: string; label: string; sub: string; locked?: boolean }[] = [
    { key: 'gate', glyph: 'ring', color: 'var(--amber)', label: 'Gate events', sub: 'A spec is waiting on your approval.', locked: true },
    { key: 'human', glyph: 'flag', color: 'var(--red)', label: 'Needs-human', sub: 'A build was escalated and needs a person.', locked: true },
    { key: 'progress', glyph: 'dotted', color: 'var(--faint)', label: 'Progress', sub: 'Milestones in apps you follow (Building, Deployed…).' },
  ];
  prefs: Record<string, EvtPrefs> = {
    gate: { inApp: true, email: true, digest: false },
    human: { inApp: true, email: false, digest: false },
    progress: { inApp: false, email: false, digest: true },
  };

  constructor() {
    effect(() => {
      this.poll.version();
      this.api.apps().subscribe((a) => {
        this.apps.set(a);
        for (const app of a) this.follow[app.key] ??= app.muted ? 'Muted' : 'All';
      });
    });
  }

  flip(key: string, ch: keyof EvtPrefs) { this.prefs[key][ch] = !this.prefs[key][ch]; }
}
