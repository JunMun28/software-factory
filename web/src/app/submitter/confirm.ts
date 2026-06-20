import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { Api } from '../core/api.service';
import { RequestDetail } from '@sf/shared';
import { Glyph, TypeChip } from '../kit/kit';
import { SubShell } from './sub-shell';

const STAGES = ['Submitted', 'Spec drafted', 'Approved', 'Building', 'In review', 'Deployed'];

/** S3 — Submission confirmation: receipt stub + primed plain-stage tracker. */
@Component({
  selector: 'sf-confirm',
  imports: [SubShell, Glyph, TypeChip],
  template: `
    <sub-shell active="new" [step]="3">
      <div
        class="sub-col narrow fade-in"
        style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:18px;padding-top:40px"
      >
        <span
          style="width:60px;height:60px;border-radius:50%;background:var(--green-bg);display:flex;align-items:center;justify-content:center"
        >
          <sf-glyph type="check" [size]="34" color="var(--green)" />
        </span>
        <div>
          <h1 style="font-size:30px">Request received</h1>
          <p style="color:var(--muted);margin-top:6px;font-size:16px">
            We'll email you when it's been reviewed.
          </p>
        </div>
        @if (req(); as r) {
          <div
            class="card"
            style="width:100%;padding:15px 18px;display:flex;align-items:center;gap:14px;text-align:left"
          >
            <div style="flex:1">
              <div style="font-size:15px;font-weight:600">{{ r.title }}</div>
              <div class="row" style="gap:8px;margin-top:6px">
                <sf-type-chip [t]="r.type" /><span style="font-size:12.5px;color:var(--muted)">{{
                  r.app_name
                }}</span>
              </div>
            </div>
            <span
              class="mono"
              style="font-size:13px;color:var(--fg2);background:var(--surface-2);padding:4px 10px;border-radius:6px"
              >{{ r.ref }}</span
            >
          </div>
          <div style="width:100%;margin-top:8px">
            <div class="tracker">
              @for (s of stages; track s; let i = $index) {
                <div class="tracker__node" [class.done]="i < at()" [class.cur]="i === at()">
                  <sf-glyph
                    [type]="i === at() ? 'ring' : i < at() ? 'check' : 'dotted'"
                    [size]="i === at() ? 19 : 16"
                    [color]="i <= at() ? 'var(--a500)' : 'var(--border-strong)'"
                    [fill]="0.4"
                  />
                  <span class="tracker__lbl">{{ s }}</span>
                </div>
                @if (i < stages.length - 1) {
                  <span class="tracker__line" [class.done]="i < at()"></span>
                }
              }
            </div>
          </div>
        }
        <div class="row" style="gap:10px;width:100%;margin-top:10px">
          <button class="btn primary lg" style="flex:1" (click)="track()">
            Track this request
          </button>
          <button class="btn ghost lg" (click)="another()">File another</button>
        </div>
        <p style="font-size:13px;color:var(--faint);margin-top:6px;max-width:420px">
          A reviewer will read it and either approve it or send it back with a question. Either way,
          you'll hear from us.
        </p>
      </div>
    </sub-shell>
  `,
})
export class Confirm {
  private api = inject(Api);
  private router = inject(Router);
  id = Number(inject(ActivatedRoute).snapshot.paramMap.get('id'));
  req = signal<RequestDetail | null>(null);
  stages = STAGES;

  constructor() {
    this.api.request(this.id).subscribe((r) => this.req.set(r));
  }

  at() {
    const r = this.req();
    if (!r) return 0;
    if (r.status === 'pending_approval') return 1;
    return 0;
  }
  track() {
    this.router.navigateByUrl(`/requests/${this.id}`);
  }
  another() {
    this.router.navigateByUrl('/submit/new');
  }
}
