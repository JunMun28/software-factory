import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Autofocus, Evidence, FactoryRequest, Icon, confirmSteps } from '@sf/shared';

/* ---- gate UI — the irreversible-action modals (floor/dossier consume these).
   Moved verbatim out of @sf/shared (deepening candidate 2, D9): the console is
   their only consumer, so they no longer belong on the shared contract. ---- */

/** The "Approve this merge/spec?" confirmation — the one intentional friction point. */
@Component({
  selector: 'sf-approve-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div
      class="palette-scrim"
      style="align-items:center;padding-top:0;z-index:50"
      (click)="cancelled.emit()"
    >
      <div
        class="palette"
        style="width:460px;padding:22px 24px;align-self:center"
        (click)="$event.stopPropagation()"
      >
        <h3 style="font-size:19px;margin-bottom:8px">
          {{
            r().gate === 'approve_merge'
              ? 'Approve this merge?'
              : r().gate === 'approve_deploy'
                ? 'Approve this deploy?'
                : r().gate === 'approve_architecture'
                  ? 'Approve this architecture?'
                  : 'Approve this spec?'
          }}
        </h3>
        <p style="font-size:14px;color:var(--muted);margin:0 0 4px">
          Approving <b style="color:var(--fg1)">{{ r().title }}</b> is irreversible. It will:
        </p>
        @if (r().gate === 'approve_architecture' && evidence()?.plan_excerpt) {
          <div
            class="mono"
            style="max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.5;white-space:pre-wrap;margin:10px 0 2px"
            aria-label="Architecture plan excerpt"
          >
            {{ evidence()?.plan_excerpt }}
          </div>
          @if (evidence()?.refine_rounds) {
            <p style="font-size:12px;color:var(--muted);margin:6px 0 0">
              Revised {{ evidence()?.refine_rounds }}× after admin feedback.
            </p>
          }
        }
        <ul
          style="margin:12px 0 16px;padding:0;list-style:none;display:flex;flex-direction:column;gap:9px"
        >
          @for (step of steps(); track $index) {
            <li class="row" style="gap:10px;font-size:13.5px">
              <span
                style="width:20px;height:20px;border-radius:50%;background:var(--a50);display:flex;align-items:center;justify-content:center;flex:0 0 auto"
                ><sf-icon name="check" [size]="12" color="var(--a600)"
              /></span>
              <span
                ><b style="font-weight:600">{{ step[0] }}</b>
                <span class="mono" style="font-size:12px;color:var(--muted);margin-left:6px">{{
                  step[1]
                }}</span></span
              >
            </li>
          }
        </ul>
        @if (blind()) {
          <p
            class="sig red"
            role="alert"
            style="display:flex;margin:0 0 14px;font-size:12.5px;line-height:1.45;white-space:normal"
          >
            No evidence is recorded for this gate — nothing here proves tests ran or a review
            happened. Read the dossier before approving.
          </p>
        }
        <div class="row" style="gap:9px;justify-content:flex-end">
          <button class="btn" (click)="cancelled.emit()">Cancel</button>
          <button class="btn primary" (click)="approved.emit()">
            {{
              blind()
                ? 'Approve without evidence'
                : r().gate === 'approve_merge' || r().gate === 'approve_deploy'
                  ? 'Approve & deploy'
                  : r().gate === 'approve_architecture'
                    ? 'Approve & continue build'
                    : 'Approve & start build'
            }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class ApproveModal {
  r = input.required<FactoryRequest>();
  /** null on a merge/deploy gate = approving blind; the modal says so out loud. */
  evidence = input<Evidence | null>(null);
  cancelled = output<void>();
  approved = output<void>();
  steps = computed(() => confirmSteps(this.r()));
  blind = computed(
    () =>
      this.evidence() === null &&
      (this.r().gate === 'approve_merge' || this.r().gate === 'approve_deploy'),
  );
}

/** The "Send back to {reporter}?" modal — emits the blocking question. */
@Component({
  selector: 'sf-send-back-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Autofocus],
  template: `
    <div
      class="palette-scrim"
      style="align-items:center;padding-top:0;z-index:50"
      (click)="cancelled.emit()"
    >
      <div
        class="palette"
        style="width:460px;padding:22px 24px;align-self:center"
        (click)="$event.stopPropagation()"
      >
        <h3 style="font-size:19px;margin-bottom:8px">Send back to {{ reporter() }}?</h3>
        @if (hint()) {
          <p style="font-size:14px;color:var(--muted);margin:0 0 10px">{{ hint() }}</p>
        }
        <textarea
          sfAutofocus
          class="input area"
          [placeholder]="placeholder()"
          [(ngModel)]="note"
          style="margin-bottom:14px"
        ></textarea>
        <div class="row" style="gap:9px;justify-content:flex-end">
          <button class="btn" (click)="cancelled.emit()">Cancel</button>
          <button class="btn primary" [disabled]="!note.trim()" (click)="sent.emit(note.trim())">
            Send back
          </button>
        </div>
      </div>
    </div>
  `,
})
export class SendBackModal {
  reporter = input.required<string>();
  hint = input<string | null>(null);
  placeholder = input<string>("What's the one question blocking the spec?");
  cancelled = output<void>();
  sent = output<string>();
  note = '';
}

/** Confirmation for a recovery action whose blast radius must be read first. */
@Component({
  selector: 'sf-recovery-confirm',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="palette-scrim"
      style="align-items:center;padding-top:0;z-index:50"
      (click)="kept.emit()"
    >
      <div
        class="palette"
        style="width:430px;padding:22px 24px;align-self:center"
        (click)="$event.stopPropagation()"
      >
        <h3 style="font-size:19px;margin-bottom:8px">{{ title() }}</h3>
        <p style="font-size:14px;color:var(--muted);margin:0 0 16px">{{ consequence() }}</p>
        <div class="row" style="gap:9px;justify-content:flex-end">
          <button class="btn" (click)="kept.emit()">Keep it stopped</button>
          <button class="btn primary" (click)="confirmed.emit()">{{ confirmLabel() }}</button>
        </div>
      </div>
    </div>
  `,
})
export class RecoveryConfirm {
  title = input.required<string>();
  consequence = input.required<string>();
  confirmLabel = input.required<string>();
  kept = output<void>();
  confirmed = output<void>();
}

/** Pick a valid earlier runner stage, explain discarded work, then require a reason. */
@Component({
  selector: 'sf-send-back-stage-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Autofocus],
  template: `
    <div
      class="palette-scrim"
      style="align-items:center;padding-top:0;z-index:50"
      (click)="cancelled.emit()"
    >
      <div
        class="palette"
        style="width:460px;padding:22px 24px;align-self:center"
        (click)="$event.stopPropagation()"
      >
        <h3 style="font-size:19px;margin-bottom:8px">Send back to…</h3>
        @if (stages().length) {
          <div class="row" style="gap:8px;margin:12px 0">
            @for (stage of stages(); track stage) {
              <button
                class="btn stage-choice"
                [class.primary]="target === stage"
                (click)="target = stage"
              >
                {{ label(stage) }}
              </button>
            }
          </div>
        } @else {
          <p style="font-size:14px;color:var(--muted);margin:12px 0">
            This is already the earliest stage — there's nothing earlier to send it back to. Use
            Retry or Take over instead.
          </p>
        }
        @if (target) {
          <p style="font-size:14px;color:var(--muted);margin:0 0 12px">
            Discards the work after {{ label(target) }} and redoes that stage.
          </p>
          <textarea
            sfAutofocus
            class="input area"
            placeholder="Why does this stage need redoing?"
            [(ngModel)]="reason"
            style="margin-bottom:14px"
          ></textarea>
        }
        <div class="row" style="gap:9px;justify-content:flex-end">
          <button class="btn" (click)="cancelled.emit()">Cancel</button>
          <button class="btn primary" [disabled]="!target || !reason.trim()" (click)="send()">
            Send back
          </button>
        </div>
      </div>
    </div>
  `,
})
export class SendBackStageModal {
  currentStage = input.required<FactoryRequest['stage']>();
  cancelled = output<void>();
  sent = output<{ stage: 'architecture' | 'build' | 'review'; reason: string }>();
  target: 'architecture' | 'build' | 'review' | null = null;
  reason = '';
  stages = computed(() => {
    const stages = ['architecture', 'build', 'review'] as const;
    const here = stages.indexOf(this.currentStage() as (typeof stages)[number]);
    // Only strictly-earlier pipeline stages are valid targets. A request stalled
    // before the pipeline (indexOf === -1, e.g. at 'spec') has none.
    return here <= 0 ? [] : stages.slice(0, here);
  });
  label(stage: string) {
    return stage === 'architecture' ? 'Architecture' : stage[0].toUpperCase() + stage.slice(1);
  }
  send() {
    if (this.target && this.reason.trim())
      this.sent.emit({ stage: this.target, reason: this.reason.trim() });
  }
}

/** Cancel is irreversible too — every surface confirms through this one modal. */
@Component({
  selector: 'sf-cancel-confirm',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="palette-scrim"
      style="align-items:center;padding-top:0;z-index:50"
      (click)="kept.emit()"
    >
      <div
        class="palette"
        style="width:420px;padding:22px 24px;align-self:center"
        (click)="$event.stopPropagation()"
      >
        <h3 style="font-size:19px;margin-bottom:8px">Cancel this request?</h3>
        <p style="font-size:14px;color:var(--muted);margin:0 0 16px">
          Abandons the request and closes its PR.
          <b style="color:var(--fg1)">{{ r().title }}</b> will be closed as won't-do and
          {{ r().reporter }} will be notified.
        </p>
        <div class="row" style="gap:9px;justify-content:flex-end">
          <button class="btn" (click)="kept.emit()">Keep it</button>
          <button class="btn danger" (click)="confirmed.emit()">Cancel request</button>
        </div>
      </div>
    </div>
  `,
})
export class CancelConfirm {
  r = input.required<FactoryRequest>();
  kept = output<void>();
  confirmed = output<void>();
}

/** The architecture refine loop (E2E-3): a structured "not yet" that goes to
 *  the AGENT, not the submitter — the reason becomes feedback for the next
 *  architecture attempt and a revised plan returns to this gate. */
@Component({
  selector: 'sf-refine-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Autofocus],
  template: `
    <div
      class="palette-scrim"
      style="align-items:center;padding-top:0;z-index:50"
      (click)="cancelled.emit()"
    >
      <div
        class="palette"
        style="width:480px;padding:22px 24px;align-self:center"
        (click)="$event.stopPropagation()"
      >
        <h3 style="font-size:19px;margin-bottom:8px">Ask the agent to revise</h3>
        <p style="font-size:14px;color:var(--muted);margin:0 0 14px">
          Your note goes straight to the architecture agent. It reworks the plan for
          <b style="color:var(--fg1)">{{ r().title }}</b> and brings a revised version back to this
          gate.
        </p>
        <label style="display:block;font-size:12.5px;color:var(--muted);margin-bottom:4px"
          >What kind of problem?</label
        >
        <select
          [(ngModel)]="code"
          style="width:100%;margin-bottom:10px"
          aria-label="Rejection category"
        >
          <option value="wrong_behavior">Wrong approach / behavior</option>
          <option value="spec_mismatch">Doesn't match the spec</option>
          <option value="quality">Quality concern</option>
          <option value="security">Security concern</option>
          <option value="other">Something else</option>
        </select>
        <textarea
          sfAutofocus
          [(ngModel)]="reason"
          rows="4"
          placeholder="Tell the agent what to change…"
          style="width:100%;resize:vertical"
          aria-label="Refinement instructions for the agent"
        ></textarea>
        <div class="row" style="gap:9px;justify-content:flex-end;margin-top:14px">
          <button class="btn" (click)="cancelled.emit()">Cancel</button>
          <button class="btn primary" [disabled]="!reason.trim()" (click)="send()">
            Send to agent
          </button>
        </div>
      </div>
    </div>
  `,
})
export class RefineModal {
  r = input.required<FactoryRequest>();
  cancelled = output<void>();
  sent = output<{ code: string; reason: string }>();
  code = 'wrong_behavior';
  reason = '';
  send() {
    if (this.reason.trim()) this.sent.emit({ code: this.code, reason: this.reason.trim() });
  }
}
