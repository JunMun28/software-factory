import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { Api } from '../core/api.service';
import { AppEntry } from '../core/models';
import { Icon } from '../kit/kit';
import { IntakeDraft } from './intake-draft.service';
import { SubShell } from './sub-shell';

/** S1 — New Request: type-first progressive disclosure. */
@Component({
  selector: 'sf-new-request',
  imports: [SubShell, Icon, FormsModule],
  template: `
    <sub-shell active="new" [step]="0" [reqId]="draft.requestId">
      <div class="sub-col fade-in">
        <h1 style="font-size:30px">What do you need?</h1>
        <p style="color:var(--muted);margin:6px 0 22px;font-size:16px">Pick a type to get started — the right questions appear next.</p>
        <div class="typecards">
          @for (t of types; track t.t) {
            <button class="typecard focusable" [class.on]="draft.type === t.t" (click)="draft.type = $any(t.t)">
              <sf-icon [name]="t.icon" [size]="24" [color]="draft.type === t.t ? 'var(--a600)' : 'var(--muted)'" />
              <span class="typecard__t">{{ t.title }}</span>
              <span class="typecard__h">{{ t.help }}</span>
            </button>
          }
        </div>

        @if (!draft.type) {
          <div style="margin-top:24px;padding:30px 20px;border:1.5px dashed var(--border-strong);border-radius:10px;text-align:center;color:var(--faint);font-size:14px">
            Choose a type above to continue.
          </div>
        } @else {
          <div class="fade-in" style="margin-top:26px;display:flex;flex-direction:column;gap:18px">
            @if (draft.type === 'bug' || draft.type === 'enh') {
              <div>
                <label class="field-label">Which app?</label>
                <div style="position:relative">
                  <button class="input" style="cursor:pointer;text-align:left" (click)="appsOpen.set(!appsOpen())">
                    @if (selectedApp(); as a) { <span>{{ a.name }}</span> } @else { <span class="ph">Pick an app</span> }
                    <sf-icon name="chevDown" [size]="16" style="margin-left:auto" color="var(--faint)" />
                  </button>
                  @if (appsOpen()) {
                    <div style="position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:9;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow-pop);overflow:hidden;padding:5px">
                      @for (a of apps(); track a.id) {
                        <button style="display:flex;width:100%;text-align:left;padding:8px 11px;border:none;border-radius:6px;background:none;cursor:pointer;font-family:var(--body);font-size:14px;gap:8px;align-items:center"
                          (click)="draft.appId = a.id; appsOpen.set(false)"
                          [style.background]="draft.appId === a.id ? 'var(--a50)' : ''">
                          <span style="color:var(--faint)">#</span>{{ a.name }}
                        </button>
                      } @empty {
                        <div style="padding:12px;font-size:13px;color:var(--muted)">No apps registered yet. Choose New app instead, or ask an admin to add one.</div>
                      }
                    </div>
                  }
                </div>
              </div>
            }
            @if (draft.type === 'other') {
              <div>
                <label class="field-label">Related app <span style="font-weight:400;color:var(--faint)">(optional)</span></label>
                <button class="input" style="cursor:pointer;text-align:left" (click)="appsOpen.set(!appsOpen())">
                  @if (selectedApp(); as a) { <span>{{ a.name }}</span> } @else { <span class="ph">Pick an app, or leave blank</span> }
                  <sf-icon name="chevDown" [size]="16" style="margin-left:auto" color="var(--faint)" />
                </button>
                @if (appsOpen()) {
                  <div style="position:relative">
                    <div style="position:absolute;top:4px;left:0;right:0;z-index:9;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow-pop);padding:5px">
                      @for (a of apps(); track a.id) {
                        <button style="display:flex;width:100%;text-align:left;padding:8px 11px;border:none;border-radius:6px;background:none;cursor:pointer;font-family:var(--body);font-size:14px;gap:8px"
                          (click)="draft.appId = a.id; appsOpen.set(false)"><span style="color:var(--faint)">#</span>{{ a.name }}</button>
                      }
                    </div>
                  </div>
                }
              </div>
            }
            @if (draft.type === 'new') {
              <div>
                <label class="field-label">What should we call it?</label>
                <input class="input" placeholder="e.g. Quarterly headcount dashboard" [(ngModel)]="draft.newName" />
              </div>
            }
            <div>
              <label class="field-label">{{ descLabel() }}</label>
              <span class="field-help">A sentence or two is plenty — we'll ask follow-ups next.</span>
              <textarea class="input area" placeholder="Describe it in your own words…" [(ngModel)]="draft.desc"></textarea>
            </div>
            @if (draft.type === 'bug') {
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                <div><label class="field-label">Where did you see it?</label><input class="input" placeholder="Page or screen" [(ngModel)]="draft.bugWhere" /></div>
                <div><label class="field-label">How often?</label><div class="input"><span class="ph">Every time</span><sf-icon name="chevDown" [size]="16" style="margin-left:auto" color="var(--faint)" /></div></div>
              </div>
            }
            <div class="row" style="justify-content:flex-end;margin-top:4px">
              <button class="btn primary lg" [disabled]="!canContinue() || saving()" (click)="continue_()">
                {{ saving() ? 'Saving…' : 'Continue to questions' }} <sf-icon name="arrowRight" [size]="16" />
              </button>
            </div>
          </div>
        }
      </div>
    </sub-shell>
  `,
})
export class NewRequest {
  draft = inject(IntakeDraft);
  private api = inject(Api);
  private router = inject(Router);

  apps = signal<AppEntry[]>([]);
  appsOpen = signal(false);
  saving = signal(false);

  types = [
    { t: 'bug', icon: 'bug', title: 'Bug fix', help: "Something's broken" },
    { t: 'enh', icon: 'spark', title: 'Enhancement', help: 'Improve an app you use' },
    { t: 'new', icon: 'app', title: 'New app', help: 'Start something fresh' },
    { t: 'other', icon: 'help', title: 'Other', help: 'Not sure — help me figure it out' },
  ];

  constructor() {
    this.api.apps().subscribe((a) => this.apps.set(a.filter((x) => !x.muted)));
  }

  selectedApp() { return this.apps().find((a) => a.id === this.draft.appId) ?? null; }
  descLabel() {
    return { bug: "What's going wrong?", new: 'What should it do?', other: 'What do you need?', enh: 'What should change?' }[this.draft.type!];
  }
  canContinue() {
    if (!this.draft.desc.trim()) return false;
    if ((this.draft.type === 'bug' || this.draft.type === 'enh') && !this.draft.appId) return false;
    return true;
  }
  async continue_() {
    this.saving.set(true);
    try {
      const id = await this.draft.save();
      this.router.navigateByUrl(`/submit/${id}/interview`);
    } finally {
      this.saving.set(false);
    }
  }
}
