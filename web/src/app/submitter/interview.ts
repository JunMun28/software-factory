import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { Api } from '../core/api.service';
import { InterviewState, RequestDetail } from '../core/models';
import { Icon, Mark, TypeChip } from '../kit/kit';
import { SubShell } from './sub-shell';

/** S2 — the adaptive AI interview: open questions answered in chat, options when natural. */
@Component({
  selector: 'sf-interview',
  imports: [SubShell, Mark, Icon, TypeChip, FormsModule],
  template: `
    <sub-shell active="new" [step]="1" [reqId]="id">
      <div style="max-width:720px;margin:0 auto;display:flex;flex-direction:column;height:100%">
        <!-- context + progress -->
        <div style="padding:14px 26px 12px;border-bottom:1px solid var(--border)">
          <div class="row" style="gap:9px;margin-bottom:12px">
            @if (req(); as r) { <sf-type-chip [t]="r.type" /><span style="font-size:14px;font-weight:600">{{ r.title }}</span> }
          </div>
          <div class="qprog">
            <span class="qprog__lbl">{{ progressLabel() }}</span>
            <span class="qprog__track"><span class="qprog__fill" [style.width.%]="progress()"></span></span>
          </div>
        </div>

        <!-- thread — chat history -->
        <div class="scroll" style="flex:1;overflow-y:auto;padding:22px 26px;display:flex;flex-direction:column;gap:22px">
          @for (t of st()?.turns ?? []; track t.order) {
            <div class="ai-q"><span class="ai-q__mark"><sf-mark [size]="17" color="#9A9AA6" /></span>
              <div><div class="ai-q__text">{{ t.question }}</div>
                @if (t.sub) { <div class="ai-q__sub">{{ t.sub }}</div> }
              </div>
            </div>
            <div class="user-reply">
              <div class="user-reply__b">
                @if (t.skipped) { <span class="chip">Skipped</span> } @else if (t.options) { <span class="chip">{{ t.answer }}</span> } @else { {{ t.answer }} }
              </div>
            </div>
          }
          @if (st(); as s) {
            @if (!s.done && s.question) {
              <div class="ai-q fade-in"><span class="ai-q__mark"><sf-mark [size]="17" color="#9A9AA6" /></span>
                <div><div class="ai-q__text" [class.lg]="s.final">{{ s.question }}</div>
                  @if (s.sub) { <div class="ai-q__sub">{{ s.sub }}</div> }
                </div>
              </div>
            }
            @if (s.done) {
              <div class="ai-q fade-in"><span class="ai-q__mark"><sf-mark [size]="17" color="#9A9AA6" /></span>
                <div><div class="ai-q__text">Thanks — that's everything I need.</div>
                  <div class="ai-q__sub">Next, check the summary before it goes to a reviewer.</div></div>
              </div>
            }
          }
        </div>

        <!-- Questions panel + the optional-details composer -->
        <div style="padding:12px 26px 18px;display:flex;flex-direction:column;gap:10px">
          @if (st(); as s) {
            @if (!s.done && s.options) {
              <div class="qpanel fade-in">
                <div class="qpanel__label">Questions</div>
                <div class="qpanel__q">{{ s.question }}</div>
                <div class="qpanel__opts">
                  @for (o of s.options; track o.t; let i = $index) {
                    <button class="opt focusable" [class.on]="picked() === o.t" style="width:100%;text-align:left;cursor:pointer;font-family:inherit"
                      (click)="picked.set(o.t)">
                      <span class="opt__key">{{ letters[i] }}</span>
                      <div style="flex:1;min-width:0"><div class="opt__t">{{ o.t }}</div>@if (o.d) { <div class="opt__d">{{ o.d }}</div> }</div>
                    </button>
                  }
                </div>
                <div class="qpanel__foot">
                  <button class="qpanel__skip" (click)="skip()">Skip</button>
                  <button class="btn primary sm" [disabled]="!picked() && !msg().trim()" (click)="sendPicked()">Continue <kbd class="kbd">↵</kbd></button>
                </div>
              </div>
            }
            <div class="dcomposer fade-in">
              <button class="dcomposer__add" aria-label="Add detail"><sf-icon name="plus" [size]="16" /></button>
              <input class="dcomposer__field" [ngModel]="msg()" (ngModelChange)="msg.set($event)"
                [placeholder]="composerPlaceholder()" (keydown.enter)="enter()" />
              @if (msg().trim()) {
                <button class="btn primary sm" (click)="enter()">Send <sf-icon name="arrowRight" [size]="16" /></button>
              } @else if (s.done) {
                <button class="btn primary sm" (click)="toReview()">That's everything <sf-icon name="arrowRight" [size]="16" /></button>
              } @else if (!s.options) {
                <button class="qpanel__skip" style="flex:0 0 auto" (click)="skip()">Skip</button>
              }
            </div>
          }
        </div>
      </div>
    </sub-shell>
  `,
})
export class Interview {
  private api = inject(Api);
  private router = inject(Router);
  id = Number(inject(ActivatedRoute).snapshot.paramMap.get('id'));

  st = signal<InterviewState | null>(null);
  req = signal<RequestDetail | null>(null);
  picked = signal<string | null>(null);
  msg = signal('');
  letters = ['A', 'B', 'C', 'D', 'E'];

  progress = computed(() => {
    const s = this.st();
    if (!s) return 10;
    if (s.done) return 100;
    return [38, 62, 90][Math.min(s.asked, 2)];
  });
  progressLabel = computed(() => {
    const s = this.st();
    if (!s) return 'A few quick questions';
    if (s.done) return 'All done';
    return s.final ? 'Last question' : 'A few quick questions';
  });

  constructor() {
    this.api.request(this.id).subscribe((r) => this.req.set(r));
    this.api.interview(this.id).subscribe((s) => this.st.set(s));
  }

  composerPlaceholder() {
    const s = this.st();
    if (!s || s.done) return 'Anything else to add? (optional)';
    return s.options ? 'Pick an option above, or type your own…' : 'Type your answer…';
  }

  private push(body: { answer?: string; skip?: boolean }) {
    this.api.answer(this.id, body).subscribe((s) => {
      this.st.set(s);
      this.picked.set(null);
      this.msg.set('');
    });
  }

  sendPicked() {
    const ans = this.msg().trim() || this.picked();
    if (ans) this.push({ answer: ans });
  }
  skip() { this.push({ skip: true }); }
  enter() {
    const s = this.st();
    if (!s) return;
    const text = this.msg().trim();
    if (s.done) {
      if (text) { /* extra detail rides along to review */ }
      this.toReview();
      return;
    }
    if (text) this.push({ answer: text });
    else if (this.picked()) this.sendPicked();
  }
  toReview() {
    const extra = this.msg().trim();
    this.router.navigate(['/submit', this.id, 'review'], { state: { extra } });
  }
}
