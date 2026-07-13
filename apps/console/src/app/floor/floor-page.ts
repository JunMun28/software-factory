import {
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { Observable } from 'rxjs';
import {
  Api,
  ApproveModal,
  CancelConfirm,
  FactoryRequest,
  MissionGate,
  MissionOut,
  Poll,
  RecoveryConfirm,
  SendBackStageModal,
  SendBackModal,
} from '@sf/shared';

import { INTAKE_URL, intakeNewRequestUrl } from '../core/intake-url';
import { Session } from '../core/session.service';
import { ConsoleShell } from '../shell/console-shell';
import { FloorActionOutcome } from './floor-action-outcome';
import { FloorContent } from './floor-content';

@Component({
  selector: 'sf-floor-page',
  imports: [
    ConsoleShell,
    FloorContent,
    ApproveModal,
    SendBackModal,
    SendBackStageModal,
    RecoveryConfirm,
    CancelConfirm,
  ],
  template: `
    <sf-console-shell active="floor">
      @if (mission(); as m) {
        <sf-floor-content
          [mission]="m"
          [intakeUrl]="intakeUrl"
          [actionOutcomes]="actionOutcomes()"
          (approved)="confirming.set($event)"
          (sentBack)="sendingBack.set($event)"
          (retryRequested)="retrying.set($event)"
          (sendBackToStageRequested)="sendingStageBack.set($event)"
          (takeOverRequested)="takingOver.set($event)"
          (cancelled)="cancelling.set($event)"
          (steered)="steer($event.request, $event.note)"
        />
      } @else {
        <p class="loading" role="status">Bringing the factory floor into view…</p>
      }
    </sf-console-shell>
    @if (confirming(); as gate) {
      <sf-approve-modal
        [r]="gate.request"
        (cancelled)="confirming.set(null)"
        (approved)="approve(gate.request)"
      />
    }
    @if (sendingBack(); as gate) {
      <sf-send-back-modal
        [reporter]="gate.request.reporter"
        hint="Say what must change before this can move forward."
        placeholder="Add a clear note…"
        (cancelled)="sendingBack.set(null)"
        (sent)="sendBack(gate.request, $event)"
      />
    }
    @if (cancelling(); as request) {
      <sf-cancel-confirm
        [r]="request"
        (kept)="cancelling.set(null)"
        (confirmed)="cancel(request)"
      />
    }
    @if (retrying(); as request) {
      <sf-recovery-confirm
        title="Retry this stage?"
        [consequence]="'Re-runs the ' + stageLabel(request) + ' stage from the top.'"
        confirmLabel="Retry stage"
        (kept)="retrying.set(null)"
        (confirmed)="retry(request)"
      />
    }
    @if (takingOver(); as request) {
      <sf-recovery-confirm
        title="Take over this request?"
        consequence="Stops automation. You'll finish this request by hand in the PR."
        confirmLabel="Take over"
        (kept)="takingOver.set(null)"
        (confirmed)="takeOver(request)"
      />
    }
    @if (sendingStageBack(); as request) {
      <sf-send-back-stage-modal
        [currentStage]="request.stage"
        (cancelled)="sendingStageBack.set(null)"
        (sent)="sendBackToStage(request, $event)"
      />
    }
  `,
  styles: `
    .loading {
      padding: 80px 0;
      color: var(--muted);
      text-align: center;
    }
  `,
})
export class FloorPage {
  private api = inject(Api);
  private poll = inject(Poll);
  private session = inject(Session);
  private router = inject(Router);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  mission = signal<MissionOut | null>(null);
  confirming = signal<MissionGate | null>(null);
  sendingBack = signal<MissionGate | null>(null);
  cancelling = signal<FactoryRequest | null>(null);
  retrying = signal<FactoryRequest | null>(null);
  takingOver = signal<FactoryRequest | null>(null);
  sendingStageBack = signal<FactoryRequest | null>(null);
  actionOutcomes = signal<Record<number, FloorActionOutcome>>({});
  intakeUrl = intakeNewRequestUrl(inject(INTAKE_URL));
  /** -1 = nothing focused yet, so the first J lands on the first row. */
  focusIndex = signal(-1);
  focusables = computed(() => {
    const m = this.mission();
    return m
      ? [
          ...m.gates.map((g) => ({ kind: 'gate' as const, gate: g, request: g.request })),
          ...m.stalled.map((request) => ({ kind: 'stalled' as const, request })),
          ...m.runs.map(({ request }) => ({ kind: 'run' as const, request })),
        ]
      : [];
  });

  constructor() {
    effect(() => {
      this.poll.version();
      this.api.mission().subscribe((mission) => this.mission.set(mission));
    });
  }
  approve(request: FactoryRequest) {
    this.confirming.set(null);
    this.runAction(request, 'approve', this.api.approve(request.id, this.session.operatorId()!));
  }
  sendBack(request: FactoryRequest, note: string) {
    this.sendingBack.set(null);
    this.runAction(
      request,
      'send back',
      this.api.sendBack(request.id, note, this.session.operatorId()!),
    );
  }
  retry(request: FactoryRequest) {
    this.retrying.set(null);
    this.runAction(request, 'retry', this.api.retry(request.id, this.session.operatorId()!));
  }
  takeOver(request: FactoryRequest) {
    this.takingOver.set(null);
    this.runAction(request, 'take over', this.api.takeOver(request.id, this.session.operatorId()!));
  }
  sendBackToStage(
    request: FactoryRequest,
    choice: { stage: 'architecture' | 'build' | 'review'; reason: string },
  ) {
    this.sendingStageBack.set(null);
    this.runAction(
      request,
      'send back to stage',
      this.api.sendBackToStage(request.id, choice.stage, choice.reason, this.session.operatorId()!),
    );
  }
  cancel(request: FactoryRequest) {
    this.cancelling.set(null);
    this.runAction(request, 'cancel', this.api.cancel(request.id, this.session.operatorId()!));
  }
  steer(request: FactoryRequest, note: string) {
    this.runAction(request, 'steer', this.api.steer(request.id, note, this.session.operatorId()!));
  }
  private runAction(
    request: FactoryRequest,
    verb:
      | 'approve'
      | 'send back'
      | 'retry'
      | 'take over'
      | 'send back to stage'
      | 'cancel'
      | 'steer',
    action: Observable<unknown>,
  ) {
    action.subscribe({
      next: () => {
        this.clearOutcome(request.id);
        this.poll.nudge();
      },
      error: (error: { status?: number; error?: Partial<ConflictPayload> }) => {
        const conflict = error.status === 409 ? error.error : null;
        const outcome =
          conflict?.acted_by && conflict.acted_at
            ? {
                kind: 'conflict' as const,
                message: `Already ${this.pastTense(verb)} by ${conflict.acted_by} at ${this.shortTime(conflict.acted_at)}`,
              }
            : error.status === 409 && verb === 'steer'
              ? {
                  kind: 'conflict' as const,
                  message: 'Run is no longer in flight — it reached a gate.',
                }
              : { kind: 'error' as const, message: `Couldn’t ${verb}. Try again.` };
        this.actionOutcomes.update((current) => ({ ...current, [request.id]: outcome }));
        this.poll.nudge();
      },
    });
  }
  private clearOutcome(requestId: number) {
    this.actionOutcomes.update((current) => {
      const { [requestId]: _removed, ...rest } = current;
      return rest;
    });
  }
  private pastTense(
    verb:
      | 'approve'
      | 'send back'
      | 'retry'
      | 'take over'
      | 'send back to stage'
      | 'cancel'
      | 'steer',
  ) {
    return {
      approve: 'approved',
      'send back': 'sent back',
      retry: 'retried',
      'take over': 'taken over',
      'send back to stage': 'sent back to stage',
      cancel: 'cancelled',
      steer: 'steered',
    }[verb];
  }
  stageLabel(request: FactoryRequest) {
    // Match the Floor's vocabulary: the backend 'architecture' stage reads as 'plan'.
    return request.stage === 'architecture' ? 'plan' : request.stage;
  }
  private shortTime(iso: string) {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  private focusRow() {
    const rows = this.host.nativeElement.querySelectorAll<HTMLElement>(
      'sf-floor-gate-card article, article.triage, article.lane',
    );
    rows[Math.min(this.focusIndex(), rows.length - 1)]?.focus();
  }
  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent) {
    const tag = (event.target as HTMLElement)?.tagName?.toLowerCase();
    if (
      ['input', 'textarea', 'button'].includes(tag) ||
      event.metaKey ||
      event.ctrlKey ||
      this.confirming() ||
      this.sendingBack() ||
      this.retrying() ||
      this.takingOver() ||
      this.sendingStageBack() ||
      this.cancelling()
    )
      return;
    const items = this.focusables();
    const current = items[this.focusIndex()];
    const key = event.key.toLowerCase();
    if (key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.focusIndex.set(Math.min(items.length - 1, this.focusIndex() + 1));
      this.focusRow();
    } else if (key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.focusIndex.set(Math.max(0, this.focusIndex() - 1));
      this.focusRow();
    } else if (event.key === 'Enter' && current) {
      event.preventDefault();
      this.router.navigateByUrl(`/requests/${current.request.id}`);
    } else if (key === 'a' && current?.kind === 'gate') {
      event.preventDefault();
      this.confirming.set(current.gate);
    } else if (key === 's' && current?.kind === 'gate') {
      event.preventDefault();
      this.sendingBack.set(current.gate);
    }
  }
}

interface ConflictPayload {
  detail: string;
  acted_by: string;
  acted_at: string;
  resulting_state: string;
}
