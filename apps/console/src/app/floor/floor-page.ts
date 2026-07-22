import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
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
import { OverviewContent } from './overview-content';
import { RequestModal } from './request-modal';
import { OverviewRow, OverviewView, RowAction } from './floor-view';

/* Tab order, and therefore the ←/→ cycling order. Keep in step with the
   `views` array in floor-content, and keep the default first. */
const VIEWS: readonly OverviewView[] = ['progress', 'list', 'board'];
const DEFAULT_VIEW: OverviewView = 'progress';

/** Pre-rename query values, so a bookmarked ?view= still lands where it meant. */
const LEGACY_VIEWS: Readonly<Record<string, OverviewView>> = { stack: 'list', line: 'board' };

@Component({
  selector: 'sf-floor-page',
  imports: [
    ConsoleShell,
    FloorContent,
    OverviewContent,
    RequestModal,
    ApproveModal,
    SendBackModal,
    SendBackStageModal,
    RecoveryConfirm,
    CancelConfirm,
  ],
  template: `
    <sf-console-shell active="floor" [wide]="true">
      @if (mission(); as m) {
        @if (classic()) {
          <sf-floor-content
            [mission]="m"
            [requests]="store.requests()"
            [view]="view()"
            [intakeUrl]="intakeUrl"
            [actionOutcomes]="actionOutcomes()"
            (viewChange)="setView($event)"
            (act)="handleAction($event)"
          />
        } @else {
          <sf-overview-content
            [mission]="m"
            [requests]="store.requests()"
            [actionOutcomes]="actionOutcomes()"
            (opened)="inspecting.set($event)"
          />
        }
      } @else {
        <p class="loading" role="status">Bringing the line into view…</p>
      }
    </sf-console-shell>
    @if (inspecting(); as row) {
      <sf-request-modal
        [row]="row"
        (dismissed)="inspecting.set(null)"
        (act)="inspecting.set(null); handleAction($event)"
      />
    }
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
  private route = inject(ActivatedRoute);
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
  /** the request whose sheet is open on the new Overview */
  inspecting = signal<OverviewRow | null>(null);

  /** The previous tabbed Overview (List | Board | Progress), kept at
   *  /overview-classic while the new one settles. Route data, so the two share
   *  every bit of action plumbing below rather than duplicating a page. */
  classic = toSignal(this.route.data.pipe(map((d) => !!d['classic'])), {
    initialValue: !!this.route.snapshot.data['classic'],
  });

  /** The chosen view lives in the URL (?view=stack|line|progress) so it is
   *  shareable and survives a reload; default stack. */
  private queryView = toSignal(
    this.route.queryParamMap.pipe(map((params) => this.parseView(params.get('view')))),
    { initialValue: this.parseView(this.route.snapshot.queryParamMap.get('view')) },
  );
  view = computed(() => this.queryView());

  private anyModalOpen = computed(
    () =>
      !!this.confirming() ||
      !!this.sendingBack() ||
      !!this.retrying() ||
      !!this.takingOver() ||
      !!this.sendingStageBack() ||
      !!this.cancelling() ||
      !!this.inspecting(),
  );

  constructor() {
    effect(() => {
      this.poll.version();
      this.api.mission().subscribe((mission) => this.mission.set(mission));
    });
  }

  private parseView(value: string | null): OverviewView {
    if (VIEWS.includes(value as OverviewView)) return value as OverviewView;
    return (value && LEGACY_VIEWS[value]) || DEFAULT_VIEW;
  }

  setView(view: OverviewView) {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view: view === DEFAULT_VIEW ? null : view },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private cycleView(direction: 1 | -1) {
    const index = VIEWS.indexOf(this.view());
    this.setView(VIEWS[(index + direction + VIEWS.length) % VIEWS.length]);
  }

  /** Every view routes its inline actions here; the confirm modals + api calls
   *  stay owned by the page. Gate actions rebuild the MissionGate (with evidence)
   *  from the current mission so the Approve modal shows the evidence strip. */
  handleAction(action: RowAction) {
    switch (action.verb) {
      case 'approve':
        this.confirming.set(this.gateFor(action.request));
        break;
      case 'sendBack':
        this.sendingBack.set(this.gateFor(action.request));
        break;
      case 'retry':
        this.retrying.set(action.request);
        break;
      case 'sendBackToStage':
        this.sendingStageBack.set(action.request);
        break;
      case 'takeOver':
        this.takingOver.set(action.request);
        break;
      case 'cancel':
        this.cancelling.set(action.request);
        break;
    }
  }

  private gateFor(request: FactoryRequest): MissionGate {
    const found = this.mission()?.gates.find((g) => g.request.id === request.id);
    return found ?? { request, evidence: null };
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

  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent) {
    const tag = (event.target as HTMLElement)?.tagName?.toLowerCase();
    if (
      ['input', 'textarea', 'button'].includes(tag) ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      this.anyModalOpen()
    )
      return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.cycleView(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.cycleView(-1);
    }
  }
}
