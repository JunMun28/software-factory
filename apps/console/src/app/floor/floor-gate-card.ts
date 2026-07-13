import { Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MissionGate } from '@sf/shared';

import { FloorActionOutcome } from './floor-action-outcome';

@Component({
  selector: 'sf-floor-gate-card',
  imports: [RouterLink],
  template: `
    @if (gate(); as item) {
      <article
        class="gate-card"
        tabindex="0"
        [attr.aria-label]="item.request.title + ', approval needed'"
      >
        <div class="meta">
          <span class="gate-chip">{{
            item.request.gate === 'approve_merge' ? 'Merge gate' : 'Spec gate'
          }}</span>
          <span
            >{{ item.request.app_name || item.request.new_app_name }} · requested by
            {{ item.request.reporter }}</span
          >
        </div>
        <h3>{{ item.request.title }}</h3>
        <div class="facts" aria-label="Decision evidence">
          @if (item.evidence?.kind === 'merge') {
            <div class="fact">
              <span>Diff</span
              ><strong class="mono"
                >+{{ item.evidence?.diff_added ?? 0 }} −{{ item.evidence?.diff_removed ?? 0 }} ·
                {{ item.evidence?.files_changed ?? 0 }} files</strong
              >
            </div>
            <div class="fact">
              <span>Tests</span
              ><strong
                class="mono"
                [class.success]="testsFailed() === 0"
                [class.failure]="testsFailed() > 0"
                >{{
                  testsFailed() === 0
                    ? (item.evidence?.tests_passed ?? 0) +
                      ' / ' +
                      (item.evidence?.tests_total ?? 0) +
                      ' passed'
                    : testsFailed() + ' of ' + (item.evidence?.tests_total ?? 0) + ' failed'
                }}</strong
              >
            </div>
            <div class="fact">
              <span>Review</span
              ><strong>{{ item.evidence?.reviewer_verdict || 'No verdict recorded' }}</strong>
            </div>
          } @else if (item.evidence) {
            <div class="fact">
              <span>Grounded spec</span
              ><strong class="mono"
                >{{ item.evidence.grounded_lines ?? 0 }} /
                {{ item.evidence.total_lines ?? 0 }} lines</strong
              >
            </div>
            <div class="fact">
              <span>Interview</span
              ><strong class="mono">{{ item.evidence.interview_count ?? 0 }} answers</strong>
            </div>
            <div class="fact">
              <span>Assumptions</span
              ><strong class="mono" [title]="assumptionTitle()">{{
                (item.evidence.assumptions ?? []).length || 'None'
              }}</strong>
            </div>
          } @else {
            <div class="fact"><span>Evidence</span><strong>No evidence recorded</strong></div>
          }
        </div>
        <p class="consequence">
          Approving will
          <b>{{
            item.request.gate === 'approve_merge'
              ? 'merge the approved work into main and deploy ' +
                (item.request.app_name || 'the app') +
                '.'
              : 'accept the spec and start planning.'
          }}</b>
        </p>
        <div class="actions" aria-label="Gate actions">
          <button class="primary" type="button" (click)="approved.emit()">
            Approve <kbd>A</kbd>
          </button>
          <button type="button" (click)="sentBack.emit()">
            Send back with a note <kbd>S</kbd>
          </button>
          <a [routerLink]="['/requests', item.request.id]"
            >Open dossier <span aria-hidden="true">→</span></a
          >
        </div>
        @if (actionOutcome(); as outcome) {
          <p class="action-outcome" [class.conflict]="outcome.kind === 'conflict'" role="status">
            {{ outcome.message }}
          </p>
        }
      </article>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .gate-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: 22px 24px;
      margin-bottom: 14px;
      outline: none;
    }
    .gate-card:focus-visible {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-tint-bd);
    }
    .meta,
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
      color: var(--muted);
      font-size: 12.5px;
    }
    .gate-chip {
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
      border-radius: var(--r-pill);
      padding: 4px 12px;
      font-weight: 700;
    }
    h3 {
      font-size: 19px;
      margin: 10px 0 14px;
    }
    .facts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
    }
    .fact {
      display: flex;
      flex-direction: column;
      background: var(--surface-2);
      border-radius: var(--r);
      padding: 10px 14px;
    }
    .fact span {
      color: var(--faint);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .fact strong {
      color: var(--fg2);
      font-size: 13px;
      font-weight: 500;
    }
    .fact .success {
      color: var(--green-tx);
    }
    .fact .failure {
      color: var(--red-tx);
    }
    .consequence {
      color: var(--fg2);
      background: var(--accent-tint);
      border: 1px solid var(--accent-tint-bd);
      border-radius: var(--r);
      padding: 9px 14px;
      margin: 14px 0 16px;
      font-size: 13.5px;
    }
    .consequence b {
      color: var(--accent-tx);
    }
    button,
    a {
      border: 1px solid var(--border-strong);
      border-radius: var(--r-pill);
      background: var(--surface);
      color: var(--fg1);
      padding: 8px 16px;
      font: 600 13px var(--body);
      text-decoration: none;
      cursor: pointer;
    }
    button:hover,
    a:hover {
      background: var(--surface-2);
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    button.primary:hover {
      background: var(--accent-hover);
    }
    a {
      color: var(--accent-link);
      border-color: transparent;
    }
    kbd {
      font: 500 10px var(--mono);
      margin-left: 6px;
      border: 1px solid currentColor;
      border-radius: var(--r-sm);
      padding: 1px 4px;
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
    @media (max-width: 640px) {
      .gate-card {
        padding: 18px;
      }
      .facts {
        grid-template-columns: 1fr 1fr;
      }
    }
  `,
})
export class FloorGateCard {
  gate = input.required<MissionGate>();
  actionOutcome = input<FloorActionOutcome>();
  approved = output<void>();
  sentBack = output<void>();
  testsFailed = computed(() => {
    const ev = this.gate().evidence;
    return (ev?.tests_total ?? 0) - (ev?.tests_passed ?? 0);
  });
  assumptionTitle = computed(() => (this.gate().evidence?.assumptions ?? []).join(' · '));
}
