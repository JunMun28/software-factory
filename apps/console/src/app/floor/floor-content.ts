import { Component, computed, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FactoryRequest, MissionGate, MissionOut, timeAgo } from '@sf/shared';

import { FloorActionOutcome } from '../shared/action-outcome';
import { FloorGateCard } from './floor-gate-card';
import { FLOOR_STAGES, deriveLane } from './floor-view';

@Component({
  selector: 'sf-floor-content',
  imports: [FloorGateCard, RouterLink],
  template: `
    @if (mission(); as m) {
      <div class="sr-only" role="status" aria-live="polite">
        {{ needsCount() }} things need you. {{ lanes().length }} requests in motion.
      </div>
      <section class="hello reveal" aria-labelledby="floor-title">
        <h1 id="floor-title">{{ greeting() }}. {{ attentionLine() }}</h1>
        <p>Everything else is moving on its own.</p>
        <div class="stats" aria-label="Factory statistics">
          <span class="stat"
            ><i></i><b>{{ lanes().length }}</b> in motion</span
          >
          <span class="stat"
            ><b>{{ shippedThisWeek() }}</b> shipped this week</span
          >
          <span class="stat"><b>—</b> median cycle</span>
          <span class="stat"><b>—</b> wait on human</span>
        </div>
      </section>

      <section aria-labelledby="needs-title" class="reveal delay-1">
        <h2 id="needs-title">Needs you</h2>
        @if (needsCount() === 0) {
          <p class="all-clear">
            Nothing needs you — {{ lanes().length }}
            {{ lanes().length === 1 ? 'request' : 'requests' }} in motion.
          </p>
        } @else {
          <p class="section-note">Decide here — each card shows what the decision needs.</p>
          @for (gate of m.gates; track gate.request.id) {
            <sf-floor-gate-card
              [gate]="gate"
              [actionOutcome]="actionOutcomes()[gate.request.id]"
              (approved)="approved.emit(gate)"
              (sentBack)="sentBack.emit(gate)"
            />
          }
          @for (request of m.stalled; track request.id) {
            <article
              class="triage"
              tabindex="0"
              [attr.aria-label]="request.title + ', needs a human'"
            >
              <div class="triage-meta">
                <span>Needs human</span>{{ request.app_name }} · {{ stageName(request) }}
              </div>
              <h3>{{ request.title }}</h3>
              <div class="last-signal">
                <b>Last signal</b
                ><span>{{
                  request.last_event || request.needs_human_reason || 'No signal recorded'
                }}</span>
              </div>
              <div class="actions">
                <button class="primary" type="button" (click)="retryRequested.emit(request)">
                  Retry this stage
                </button>
                <button type="button" (click)="sendBackToStageRequested.emit(request)">
                  Send back to…
                </button>
                <button type="button" (click)="takeOverRequested.emit(request)">Take over</button>
                <button class="danger" type="button" (click)="cancelled.emit(request)">
                  Cancel
                </button>
              </div>
              @if (actionOutcomes()[request.id]; as outcome) {
                <p
                  class="action-outcome"
                  [class.conflict]="outcome.kind === 'conflict'"
                  role="status"
                >
                  {{ outcome.message }}
                </p>
              }
            </article>
          }
          @for (owned of m.human_owned; track owned.request.id) {
            <article
              class="triage human-owned"
              tabindex="0"
              [attr.aria-label]="owned.request.title + ', human-owned by ' + owned.taken_over_by"
            >
              <div class="triage-meta">
                <span>Human-owned</span>{{ owned.request.app_name }} ·
                {{ stageName(owned.request) }}
              </div>
              <h3>{{ owned.request.title }}</h3>
              <div class="last-signal">
                <b>Automation stopped</b
                ><span>{{ owned.taken_over_by }} is finishing this request by hand in the PR.</span>
              </div>
              <div class="actions">
                <a [routerLink]="['/requests', owned.request.id]">Open dossier</a>
                <button class="danger" type="button" (click)="cancelled.emit(owned.request)">
                  Cancel
                </button>
              </div>
              @if (actionOutcomes()[owned.request.id]; as outcome) {
                <p
                  class="action-outcome"
                  [class.conflict]="outcome.kind === 'conflict'"
                  role="status"
                >
                  {{ outcome.message }}
                </p>
              }
            </article>
          }
        }
      </section>

      <section aria-labelledby="line-title" class="reveal delay-2">
        <h2 id="line-title">On the line</h2>
        <p class="section-note">
          Each request travels spec → plan → build → review → merge → ship.
        </p>
        @for (lane of lanes(); track lane.id) {
          <article
            class="lane"
            [class.quiet]="lane.quiet"
            tabindex="0"
            [attr.aria-label]="
              lane.title +
              ', ' +
              lane.stage +
              ', step ' +
              lane.step +
              ' of ' +
              lane.of +
              ', ' +
              lane.healthLabel
            "
          >
            <div class="lane-top">
              <h3>
                <a [routerLink]="['/requests', lane.id]">{{ lane.title }}</a>
              </h3>
              <span class="app">{{ lane.app }}</span
              ><span class="spacer"></span><span class="health">{{ lane.healthLabel }}</span>
            </div>
            <div class="track" aria-hidden="true">
              <div class="rail"><span class="fill" [style.width.%]="lane.progress"></span></div>
              <div class="marks">
                @for (stage of stages; track stage) {
                  <i
                    ><span>{{ stage }}</span></i
                  >
                }
              </div>
              <span class="bead" [style.left.%]="lane.progress"></span>
            </div>
            <div class="now">
              <span class="mono">{{ lane.stage }} · step {{ lane.step }} of {{ lane.of }}</span
              ><span>{{ lane.label }}</span>
            </div>
            <div class="steer-bar">
              <button
                class="steer-toggle"
                type="button"
                [attr.aria-expanded]="steeringId() === lane.id"
                [attr.aria-controls]="'steer-' + lane.id"
                (click)="openSteer(lane.id)"
              >
                Steer next step
              </button>
              @if (lane.steer; as steer) {
                <span class="steer-state" [class.heard]="steer.state === 'heard'">
                  {{ steer.state === 'heard' ? 'heard ✓ at step ' + steer.at_step : 'queued' }}
                </span>
              }
            </div>
            @if (steeringId() === lane.id) {
              <div class="steer-form" [id]="'steer-' + lane.id">
                <label [for]="'steer-note-' + lane.id">Note for the next stage boundary</label>
                <div class="steer-fields">
                  <input
                    [id]="'steer-note-' + lane.id"
                    type="text"
                    placeholder="Add a constraint the next step must honor…"
                    [value]="steerText()"
                    (input)="steerText.set($any($event.target).value)"
                    (keydown.enter)="sendSteer(lane.id)"
                    (keydown.escape)="steeringId.set(null)"
                  />
                  <button
                    type="button"
                    (click)="sendSteer(lane.id)"
                    [disabled]="!steerText().trim()"
                  >
                    Send
                  </button>
                </div>
              </div>
            }
            @if (actionOutcomes()[lane.id]; as outcome) {
              <p
                class="action-outcome"
                [class.conflict]="outcome.kind === 'conflict'"
                role="status"
              >
                {{ outcome.message }}
              </p>
            }
          </article>
        } @empty {
          <div class="empty-line">
            <span class="resting-track" aria-hidden="true"></span>
            <p>
              The line is resting.
              <a [href]="intakeUrl()">Invite the next request through Intake →</a>
            </p>
          </div>
        }
      </section>

      <section aria-labelledby="recent-title" class="reveal delay-3">
        <h2 id="recent-title">Recently</h2>
        <p class="section-note">The latest outcomes, in factory order.</p>
        <ul class="recent">
          @for (recent of m.recent; track recent.request.id) {
            <li>
              <span class="outcome" [class.shipped]="recent.outcome === 'approved_merge'">{{
                outcome(recent.outcome)
              }}</span
              ><a [routerLink]="['/requests', recent.request.id]">{{ recent.request.title }}</a
              ><span class="spacer"></span><span class="signed">by {{ recent.decided_by }} · </span
              ><time [attr.datetime]="recent.decided_at">{{ timeAgo(recent.decided_at) }}</time>
            </li>
          } @empty {
            <li class="muted">No recent outcomes yet.</li>
          }
        </ul>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .hello {
      padding: 44px 0 0;
    }
    h1 {
      font-size: clamp(27px, 3.6vw, 36px);
      letter-spacing: -0.02em;
    }
    .hello > p,
    .section-note {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 14px;
    }
    .stats {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 20px;
    }
    .stat {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 10px 16px;
      color: var(--muted);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      font-size: 13px;
    }
    .stat b {
      color: var(--fg1);
      font: 600 15px var(--mono);
    }
    .stat i {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      animation: breathe 2.6s ease-in-out infinite;
    }
    h2 {
      margin: 46px 0 4px;
      font-size: 24px;
    }
    .all-clear {
      margin: 14px 0 0;
      padding: 12px 16px;
      color: var(--green-tx);
      background: var(--green-bg);
      border: 1px solid var(--green-line);
      border-radius: var(--r-lg);
    }
    .triage {
      padding: 22px 24px;
      margin: 14px 0;
      background: var(--surface);
      border: 1px solid var(--red-line);
      border-radius: var(--r-lg);
      outline: none;
    }
    .triage:focus-visible {
      box-shadow: 0 0 0 2px var(--red-line);
    }
    .triage-meta {
      display: flex;
      gap: 10px;
      align-items: center;
      color: var(--muted);
      font-size: 12.5px;
    }
    .triage-meta span {
      color: var(--red-tx);
      background: var(--red-bg);
      border: 1px solid var(--red-line);
      border-radius: var(--r-pill);
      padding: 4px 12px;
      font-weight: 700;
    }
    .human-owned {
      border-color: var(--border-strong);
    }
    .human-owned .triage-meta span {
      color: var(--accent-tx);
      background: var(--accent-tint);
      border-color: var(--accent);
    }
    .triage h3 {
      margin: 10px 0 14px;
      font-size: 19px;
    }
    .last-signal {
      display: flex;
      flex-direction: column;
      padding: 10px 14px;
      background: var(--surface-2);
      border-radius: var(--r);
      color: var(--fg2);
      font-size: 13px;
    }
    .last-signal b {
      color: var(--faint);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 11px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }
    .actions button,
    .actions a {
      border: 1px solid var(--border-strong);
      border-radius: var(--r-pill);
      padding: 8px 16px;
      background: var(--surface);
      color: var(--fg1);
      font: 600 13px var(--body);
      text-decoration: none;
      cursor: pointer;
    }
    .actions .primary {
      color: white;
      background: var(--accent);
      border-color: var(--accent);
    }
    .actions .danger {
      color: var(--red);
      border-color: var(--red-line);
    }
    .action-outcome {
      margin: 12px 0 0;
      padding: 8px 12px;
      color: var(--muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r);
      font-size: 12.5px;
    }
    .action-outcome.conflict {
      color: var(--amber-tx);
      background: var(--amber-bg);
      border-color: var(--amber-line);
    }
    .lane {
      display: block;
      padding: 18px 24px 20px;
      margin: 12px 0;
      color: inherit;
      text-decoration: none;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    .lane:hover,
    .lane:focus-visible {
      border-color: var(--accent);
      outline: none;
    }
    .lane-top,
    .now {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 6px 14px;
    }
    .lane h3 {
      font-size: 16px;
    }
    .lane h3 a {
      color: inherit;
      text-decoration: none;
    }
    .app {
      color: var(--accent-tx);
      background: var(--accent-tint);
      border-radius: var(--r-pill);
      padding: 3px 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .spacer {
      flex: 1;
    }
    .health {
      color: var(--muted);
      font-size: 12.5px;
    }
    .quiet .health {
      color: var(--red-tx);
    }
    .track {
      position: relative;
      height: 30px;
      margin-top: 8px;
    }
    .rail {
      position: absolute;
      inset: 13px 0 auto;
      height: 4px;
      background: var(--surface-3);
      border-radius: var(--r-pill);
      overflow: hidden;
    }
    .fill {
      display: block;
      height: 100%;
      background: var(--accent);
    }
    .quiet .fill {
      background: var(--border-strong);
    }
    .marks {
      position: absolute;
      inset: 0;
      display: flex;
      justify-content: space-between;
    }
    .marks i {
      position: relative;
      width: 4px;
      height: 4px;
      margin-top: 13px;
      border-radius: 50%;
      background: var(--border-strong);
    }
    .marks span {
      position: absolute;
      top: 11px;
      left: 50%;
      transform: translateX(-50%);
      color: var(--faint);
      font: 600 10.5px var(--body);
      font-style: normal;
    }
    .bead {
      position: absolute;
      top: 9px;
      width: 12px;
      height: 12px;
      transform: translateX(-50%);
      border: 2px solid var(--surface);
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .bead:after {
      content: '';
      position: absolute;
      inset: -6px;
      border: 1px solid var(--accent);
      border-radius: 50%;
      animation: ping 2.8s ease-out infinite;
    }
    .quiet .bead {
      background: var(--faint);
      box-shadow: 0 0 0 1px var(--faint);
    }
    .quiet .bead:after {
      display: none;
    }
    .now {
      margin-top: 22px;
      color: var(--muted);
      font-size: 13px;
    }
    .now .mono {
      color: var(--fg2);
      font-size: 12px;
    }
    .steer-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-top: 14px;
    }
    .steer-toggle,
    .steer-form button {
      padding: 7px 13px;
      color: var(--fg2);
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      border-radius: var(--r-pill);
      font: 600 12px var(--body);
      cursor: pointer;
    }
    .steer-state {
      padding: 4px 10px;
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px dashed var(--amber-line);
      border-radius: var(--r-pill);
      font: 700 11.5px var(--body);
    }
    .steer-state.heard {
      color: var(--green-tx);
      background: var(--green-bg);
      border-style: solid;
      border-color: var(--green-line);
    }
    .steer-form {
      margin-top: 10px;
      padding: 12px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r);
    }
    .steer-form label {
      display: block;
      margin-bottom: 7px;
      color: var(--muted);
      font-size: 12px;
    }
    .steer-fields {
      display: flex;
      gap: 8px;
    }
    .steer-fields input {
      min-width: 0;
      flex: 1;
      padding: 9px 12px;
      color: var(--fg1);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--r);
      font: 13px var(--body);
    }
    .steer-fields button {
      color: white;
      background: var(--accent);
      border-color: var(--accent);
    }
    .steer-fields button:disabled {
      opacity: 0.55;
      cursor: default;
    }
    .empty-line {
      padding: 24px;
      margin-top: 12px;
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      background: var(--surface);
    }
    .resting-track {
      display: block;
      height: 4px;
      background: var(--surface-3);
      border-radius: var(--r-pill);
    }
    .empty-line p {
      color: var(--muted);
      margin: 16px 0 0;
    }
    .empty-line a {
      color: var(--accent-link);
    }
    .recent {
      list-style: none;
      margin: 14px 0 80px;
      padding: 0;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      background: var(--surface);
    }
    .recent li {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      align-items: baseline;
      padding: 13px 20px;
      border-bottom: 1px solid var(--hairline);
    }
    .recent li:last-child {
      border: 0;
    }
    .recent a {
      color: var(--fg1);
      text-decoration: none;
    }
    .recent time,
    .signed,
    .muted {
      color: var(--muted);
      font-size: 12.5px;
    }
    .outcome {
      padding: 4px 12px;
      color: var(--amber-tx);
      background: var(--amber-bg);
      border-radius: var(--r-pill);
      font-size: 11.5px;
      font-weight: 700;
    }
    .outcome.shipped {
      color: var(--green-tx);
      background: var(--green-bg);
    }
    .reveal {
      animation: reveal 0.5s var(--ease-out) both;
    }
    .delay-1 {
      animation-delay: 0.08s;
    }
    .delay-2 {
      animation-delay: 0.16s;
    }
    .delay-3 {
      animation-delay: 0.24s;
    }
    @keyframes breathe {
      50% {
        opacity: 0.35;
      }
    }
    @keyframes ping {
      0% {
        transform: scale(0.55);
        opacity: 0.55;
      }
      70%,
      100% {
        transform: scale(1.5);
        opacity: 0;
      }
    }
    @keyframes reveal {
      from {
        opacity: 0;
        transform: translateY(8px);
      }
    }
    @media (max-width: 640px) {
      .marks span {
        display: none;
      }
      .marks i:first-child span,
      .marks i:last-child span {
        display: block;
      }
      .lane,
      .triage {
        padding: 18px;
      }
      .steer-fields {
        align-items: stretch;
        flex-direction: column;
      }
      .hello {
        padding-top: 32px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      *,
      *:before,
      *:after {
        animation: none !important;
        transition: none !important;
      }
    }
  `,
})
export class FloorContent {
  mission = input.required<MissionOut>();
  intakeUrl = input('http://localhost:4201/submit/new');
  actionOutcomes = input<Record<number, FloorActionOutcome>>({});
  approved = output<MissionGate>();
  sentBack = output<MissionGate>();
  retryRequested = output<FactoryRequest>();
  sendBackToStageRequested = output<FactoryRequest>();
  takeOverRequested = output<FactoryRequest>();
  cancelled = output<FactoryRequest>();
  steered = output<{ request: FactoryRequest; note: string }>();
  steeringId = signal<number | null>(null);
  steerText = signal('');
  stages = FLOOR_STAGES;
  timeAgo = timeAgo;

  openSteer(requestId: number) {
    this.steerText.set('');
    this.steeringId.set(this.steeringId() === requestId ? null : requestId);
  }

  sendSteer(requestId: number) {
    const note = this.steerText().trim();
    const lane = this.lanes().find((item) => item.id === requestId);
    if (!note || !lane) return;
    this.steered.emit({ request: lane.request, note });
    this.steeringId.set(null);
    this.steerText.set('');
  }

  lanes = computed(() => this.mission().runs.map(deriveLane));
  needsCount = computed(
    () =>
      this.mission().gates.length +
      this.mission().stalled.length +
      this.mission().human_owned.length,
  );
  shippedThisWeek = computed(
    () => this.mission().recent.filter((r) => r.outcome === 'approved_merge').length,
  );
  greeting = computed(() => {
    const hour = new Date().getHours();
    return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  });
  attentionLine = computed(() => {
    const count = this.needsCount();
    return count === 0
      ? 'Nothing needs you.'
      : `${count === 1 ? 'One thing' : `${count} things`} need you.`;
  });
  stageName(request: FactoryRequest) {
    return request.stage === 'architecture'
      ? 'Plan stage'
      : `${request.stage[0].toUpperCase()}${request.stage.slice(1)} stage`;
  }
  outcome(outcome: string) {
    return outcome === 'approved_merge'
      ? 'Shipped'
      : outcome === 'approved'
        ? 'Approved'
        : outcome === 'cancelled'
          ? 'Cancelled'
          : 'Sent back';
  }
}
