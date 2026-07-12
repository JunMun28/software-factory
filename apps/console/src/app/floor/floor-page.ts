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
import {
  Api,
  ApproveModal,
  CancelConfirm,
  FactoryRequest,
  MissionGate,
  MissionOut,
  Poll,
  SendBackModal,
} from '@sf/shared';

import { INTAKE_URL, intakeNewRequestUrl } from '../core/intake-url';
import { Session } from '../core/session.service';
import { ConsoleShell } from '../shell/console-shell';
import { FloorContent } from './floor-content';

@Component({
  selector: 'sf-floor-page',
  imports: [ConsoleShell, FloorContent, ApproveModal, SendBackModal, CancelConfirm],
  template: `
    <sf-console-shell active="floor">
      @if (mission(); as m) {
        <sf-floor-content
          [mission]="m"
          [intakeUrl]="intakeUrl"
          (approved)="confirming.set($event)"
          (sentBack)="sendingBack.set($event)"
          (retried)="retry($event)"
          (cancelled)="cancelling.set($event)"
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
    this.api.approve(request.id, this.session.user().name).subscribe(() => this.poll.nudge());
  }
  sendBack(request: FactoryRequest, note: string) {
    this.sendingBack.set(null);
    this.api
      .sendBack(request.id, note, this.session.user().name)
      .subscribe(() => this.poll.nudge());
  }
  retry(request: FactoryRequest) {
    this.api.retry(request.id, this.session.user().name).subscribe(() => this.poll.nudge());
  }
  cancel(request: FactoryRequest) {
    this.cancelling.set(null);
    this.api.cancel(request.id, this.session.user().name).subscribe(() => this.poll.nudge());
  }
  private focusRow() {
    const rows = this.host.nativeElement.querySelectorAll<HTMLElement>(
      'sf-floor-gate-card article, article.triage, a.lane',
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
