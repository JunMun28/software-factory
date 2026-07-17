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
import { Api, FactoryRequest, MissionGate, MissionOut, Poll } from '@sf/shared';

import { INTAKE_URL, intakeNewRequestUrl } from '../core/intake-url';
import { Session } from '../core/session.service';
import { Store } from '../core/store.service';
import {
  ApproveModal,
  CancelConfirm,
  RecoveryConfirm,
  SendBackModal,
  SendBackStageModal,
} from '../shared/gate-modals';
import { ConsoleShell } from '../shell/console-shell';
import {
  FloorActionError,
  FloorActionOutcome,
  FloorActionVerb,
  floorActionOutcome,
} from '../shared/action-outcome';
import { FloorContent } from './floor-content';
import { deriveQueue } from './floor-view';

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
    <sf-console-shell active="floor" [wide]="true">
      @if (mission(); as m) {
        <sf-floor-content
          [mission]="m"
          [requests]="store.requests()"
          [queue]="visibleQueue()"
          [appOptions]="appOptions()"
          [activeFilter]="appFilter()"
          (filterChanged)="appFilter.set($event)"
          [intakeUrl]="intakeUrl"
          [actionOutcomes]="actionOutcomes()"
          (approved)="confirming.set($event)"
          (sentBack)="sendingBack.set($event)"
          (retryRequested)="retrying.set($event)"
          (sendBackToStageRequested)="sendingStageBack.set($event)"
          (takeOverRequested)="takingOver.set($event)"
          (cancelled)="cancelling.set($event)"
        />
      } @else {
        <p class="loading" role="status">Bringing the line into view…</p>
      }
    </sf-console-shell>
    @if (confirming(); as gate) {
      <sf-approve-modal
        [r]="gate.request"
        [evidence]="gate.evidence"
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
  store = inject(Store);
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
  appFilter = signal('all');
  /** One derivation feeds both the rendered rows and the keyboard order. */
  fullQueue = computed(() => {
    const m = this.mission();
    return m ? deriveQueue(m) : [];
  });
  appOptions = computed(() => {
    const queue = this.fullQueue();
    if (queue.length <= 6) return [];
    const counts = new Map<string, number>();
    for (const item of queue) {
      const app = item.request.app_name || 'No app yet';
      counts.set(app, (counts.get(app) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ key: label, label, count }));
  });
  visibleQueue = computed(() => {
    const filter = this.appFilter();
    const queue = this.fullQueue();
    if (filter === 'all') return queue;
    return queue.filter((item) => (item.request.app_name || 'No app yet') === filter);
  });
  /** Keyboard rows mirror the visible queue exactly (sorted + filtered). */
  focusables = computed(() =>
    this.visibleQueue().map((item) =>
      item.kind === 'gate'
        ? {
            kind: 'gate' as const,
            gate: { request: item.request, evidence: item.evidence },
            request: item.request,
          }
        : { kind: item.kind, request: item.request },
    ),
  );

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
  private runAction(request: FactoryRequest, verb: FloorActionVerb, action: Observable<unknown>) {
    action.subscribe({
      next: () => {
        this.clearOutcome(request.id);
        this.poll.nudge();
      },
      error: (error: FloorActionError) => {
        this.actionOutcomes.update((current) => ({
          ...current,
          [request.id]: floorActionOutcome(verb, error),
        }));
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
  stageLabel(request: FactoryRequest) {
    return request.stage;
  }
  private focusRow() {
    const rows = this.host.nativeElement.querySelectorAll<HTMLElement>('article.q-row');
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
