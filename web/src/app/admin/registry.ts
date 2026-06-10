import { Component, HostListener, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Api } from '../core/api.service';
import { AppEntry } from '../core/models';
import { Poll } from '../core/poll.service';
import { Glyph, Icon } from '../kit/kit';
import { AdminShell } from './admin-shell';

/** C7 — App registry: name → repo → owner, with the slide-in edit + blast-radius note. */
@Component({
  selector: 'sf-registry-page',
  imports: [AdminShell, Glyph, Icon, FormsModule],
  template: `
    <admin-shell active="registry" title="App registry">
      <span headerRight>
        <button class="btn primary sm" (click)="startNew()"><sf-icon name="plus" [size]="14" /> New</button>
      </span>
      <div class="regtable scroll">
        <div class="reghead"><span>App / channel</span><span>Owner</span><span>Repo</span><span>Source</span><span></span></div>
        <div [style.opacity]="editing() != null ? 0.55 : 1">
          @for (a of apps(); track a.id) {
            <div class="regrow focusable" tabindex="0" role="button" [class.focus]="editing()?.id === a.id"
              (click)="edit(a)" (keydown.enter)="edit(a)">
              <span class="row" style="gap:7px"><span style="color:var(--faint)">#</span><span style="font-size:13.5px;font-weight:600">{{ a.name }}</span>
                @if (a.unread) { <span style="width:6px;height:6px;border-radius:50%;background:var(--a500)"></span> }</span>
              <span style="font-size:12.5px;color:var(--muted)">{{ a.owner }}</span>
              <span class="reflink">{{ a.repo }}</span>
              <span class="regprov">{{ a.provisioning }}</span>
              <span style="color:var(--faint);text-align:right"><sf-icon name="chevRight" [size]="15" /></span>
            </div>
          }
        </div>
      </div>
      @if (editing(); as e) {
        <div class="scrim" (click)="close()"></div>
        <div class="sidepanel fade-in" style="width:360px">
          <div class="sp-head row" style="gap:7px">
            <span style="color:var(--faint)">#</span>
            @if (isNew()) {
              <input class="input" placeholder="App name" [(ngModel)]="form.name" style="min-height:34px;padding:5px 10px;font-weight:700" />
            } @else {
              <span style="font:700 18px/1 var(--display)">{{ e.name }}</span>
            }
            <button class="btn ghost sm" style="margin-left:auto" (click)="close()"><kbd class="kbd">Esc</kbd></button>
          </div>
          <div class="sp-body scroll" style="display:flex;flex-direction:column;gap:14px">
            <div><label class="field-label">Owner</label><input class="input" [(ngModel)]="form.owner" placeholder="team-name" /></div>
            <div>
              <label class="field-label">Repo mapping</label>
              <div class="input focus">
                <input style="border:none;outline:none;background:none;font-family:var(--mono);font-size:12.5px;color:var(--a700);flex:1" [(ngModel)]="form.repo" placeholder="micron/repo-name" />
                <span class="row" style="margin-left:auto;gap:5px;color:var(--green);font-size:12px"><sf-glyph type="check" [size]="14" color="var(--green)" /> verified</span>
              </div>
            </div>
            @if (!isNew() && e.open_requests > 0) {
              <div style="border:1px dashed var(--border-strong);border-radius:8px;padding:11px 13px;font-size:12.5px;color:var(--muted)">
                Changing this feeds <b style="color:var(--fg1)">1 channel</b>, linked to <b style="color:var(--fg1)">{{ e.open_requests }} request{{ e.open_requests > 1 ? 's' : '' }}</b>.
              </div>
            }
          </div>
          <div class="sp-foot">
            <button class="btn primary" [disabled]="!form.name.trim()" (click)="save()">Save</button>
            <button class="btn" (click)="close()">Cancel</button>
          </div>
        </div>
      }
    </admin-shell>
  `,
})
export class Registry {
  private api = inject(Api);
  private poll = inject(Poll);

  apps = signal<AppEntry[]>([]);
  editing = signal<AppEntry | null>(null);
  isNew = signal(false);
  form = { name: '', owner: '', repo: '', provisioning: 'Manual', muted: false };

  constructor() {
    effect(() => {
      this.poll.version();
      this.api.apps().subscribe((a) => this.apps.set(a));
    });
  }

  edit(a: AppEntry) {
    this.isNew.set(false);
    this.editing.set(a);
    this.form = { name: a.name, owner: a.owner, repo: a.repo, provisioning: a.provisioning, muted: a.muted };
  }
  startNew() {
    this.isNew.set(true);
    this.form = { name: '', owner: '', repo: '', provisioning: 'Manual', muted: false };
    this.editing.set({ id: -1, key: '', name: '', owner: '', repo: '', provisioning: 'Manual', muted: false, open_requests: 0, unread: false });
  }
  save() {
    const done = () => { this.close(); this.poll.nudge(); };
    if (this.isNew()) this.api.createApp(this.form).subscribe(done);
    else this.api.updateApp(this.editing()!.id, this.form).subscribe(done);
  }
  close() { this.editing.set(null); }

  @HostListener('window:keydown.escape')
  onEsc() { if (this.editing()) this.close(); }
}
