import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Autofocus, FactoryRequest, Icon, confirmSteps } from '@sf/shared';

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
                : 'Approve this spec?'
          }}
        </h3>
        <p style="font-size:14px;color:var(--muted);margin:0 0 4px">
          Approving <b style="color:var(--fg1)">{{ r().title }}</b> is irreversible. It will:
        </p>
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
        <div class="row" style="gap:9px;justify-content:flex-end">
          <button class="btn" (click)="cancelled.emit()">Cancel</button>
          <button class="btn primary" (click)="approved.emit()">
            {{
              r().gate === 'approve_merge'
                ? 'Approve & deploy'
                : r().gate === 'approve_deploy'
                  ? 'Approve & deploy'
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
  cancelled = output<void>();
  approved = output<void>();
  steps = computed(() => confirmSteps(this.r()));
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
