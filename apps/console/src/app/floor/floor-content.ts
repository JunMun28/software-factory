import { Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FactoryRequest, Glyph, MissionGate, MissionOut, RunState } from '@sf/shared';

import { FloorActionOutcome } from '../shared/action-outcome';
import { QueueItem, STAGES, TrackRow, deriveLine, deriveTallies, queueChip } from './floor-view';

@Component({
  selector: 'sf-floor-content',
  imports: [RouterLink, Glyph],
  template: `
    @if (mission(); as m) {
      <div class="sr-only" role="status" aria-live="polite">
        {{ queue().length }} decisions waiting. {{ tallies().open }} requests on the line.
      </div>

      <header class="head">
        <h1>Overview</h1>
        <p class="pulse">
          <b class="mono">{{ tallies().open }}</b> on the line
          <span class="sep" aria-hidden="true"></span>
          <b class="mono" [class.hot]="tallies().deciding > 0">{{ tallies().deciding }}</b>
          waiting on your decision
          <span class="sep" aria-hidden="true"></span>
          <b class="mono" [class.bad]="tallies().attention > 0">{{ tallies().attention }}</b>
          need attention
          <span class="sep" aria-hidden="true"></span>
          <b class="mono">{{ tallies().shipped }}</b> shipped this week
          @if (tallies().cycle; as cycle) {
            <span class="sep" aria-hidden="true"></span>
            <span class="quiet-stat"
              >median cycle <b class="mono">{{ cycle }}</b></span
            >
          }
          @if (tallies().gateWait; as wait) {
            <span class="sep" aria-hidden="true"></span>
            <span class="quiet-stat"
              >gates answered in <b class="mono">~{{ wait }}</b></span
            >
          }
        </p>
      </header>

      <div class="cockpit">
        <section class="linezone" aria-labelledby="line-title">
          <div class="zone-head">
            <h2 id="line-title">The line</h2>
            <p class="zone-note">Every request, intake to deploy. ◆ marks a human approval.</p>
          </div>

          <div class="line scroll-x">
            <div class="line-inner">
              <div class="lrow lhead" aria-hidden="true">
                <div class="meta"></div>
                <div class="track">
                  @for (s of stages; track s.key; let i = $index) {
                    @if (i > 0) {
                      <span class="joint" [class.gated]="s.gate !== null">
                        @if (s.gate) {
                          <i class="dia" [class.hot]="line().gateCounts[gateIdx(i)] > 0"></i>
                          <em class="gname" [class.hot]="line().gateCounts[gateIdx(i)] > 0">{{
                            gateLabel(i)
                          }}</em>
                        }
                      </span>
                    }
                    <span class="slab">
                      <span class="sname"
                        >{{ s.label }} <b class="mono">{{ line().counts[i] }}</b></span
                      >
                    </span>
                  }
                </div>
                <div class="rstate"></div>
              </div>

              @for (row of line().rows; track row.id) {
                <a
                  class="lrow live"
                  [class]="'tone-' + row.tone"
                  [routerLink]="['/requests', row.id]"
                  [attr.aria-label]="rowLabel(row)"
                >
                  <div class="meta">
                    <span class="rref mono">{{ row.ref }}</span>
                    <span class="rtitle">{{ row.title }}</span>
                    <span class="rapp">{{ row.app }}</span>
                  </div>
                  <div class="track" aria-hidden="true">
                    @for (s of stages; track s.key; let i = $index) {
                      @if (i > 0) {
                        <span class="joint" [class.gated]="s.gate !== null">
                          @if (s.gate) {
                            <i
                              class="dia"
                              [class.hot]="row.gates[gateIdx(i)] === 'waiting'"
                              [class.passed]="row.gates[gateIdx(i)] === 'passed'"
                            ></i>
                          }
                        </span>
                      }
                      <span class="seg" [class]="row.segs[i]">
                        @if (row.segs[i] === 'current' && row.progress !== null) {
                          <i class="fill" [style.width.%]="row.progress * 100"></i>
                        }
                      </span>
                    }
                  </div>
                  <div class="rstate">
                    @if (row.tone === 'gate') {
                      <i class="sdia" aria-hidden="true">◆</i>
                    } @else if (row.glyph) {
                      <sf-glyph [type]="row.glyph" [size]="12" [fill]="row.progress ?? 0.4" />
                    }
                    <span class="stext" [title]="row.state">{{ row.state }}</span>
                    @if (row.age) {
                      <span class="rage mono" [title]="'time in stage'">{{ row.age }}</span>
                    }
                  </div>
                </a>
              } @empty {
                <p class="line-empty">
                  The line is resting.
                  <a [href]="intakeUrl()">Invite the next request through Intake →</a>
                </p>
              }

              @if (line().shipped.length > 0) {
                <p class="shipped-head">Shipped recently</p>
                @for (row of line().shipped; track row.id) {
                  <a
                    class="lrow tone-done"
                    [routerLink]="['/requests', row.id]"
                    [attr.aria-label]="rowLabel(row)"
                  >
                    <div class="meta">
                      <span class="rref mono">{{ row.ref }}</span>
                      <span class="rtitle">{{ row.title }}</span>
                      <span class="rapp">{{ row.app }}</span>
                    </div>
                    <div class="track" aria-hidden="true">
                      @for (s of stages; track s.key; let i = $index) {
                        @if (i > 0) {
                          <span class="joint" [class.gated]="s.gate !== null">
                            @if (s.gate) {
                              <i class="dia passed"></i>
                            }
                          </span>
                        }
                        <span class="seg done"></span>
                      }
                    </div>
                    <div class="rstate">
                      <sf-glyph type="check" [size]="12" [fill]="1" />
                      <span class="stext">{{ row.state }}</span>
                    </div>
                  </a>
                }
              }
            </div>
          </div>
        </section>

        <aside class="rail" aria-labelledby="rail-title">
          <div class="zone-head">
            <h2 id="rail-title">Needs you</h2>
            @if (queue().length > 0) {
              <span class="zcount mono">{{ queue().length }}</span>
            }
          </div>
          @if (queue().length === 0 && activeFilter() === 'all') {
            <p class="all-clear">
              Nothing is waiting on you — the line runs itself until the next gate.
            </p>
          }
          @if (appOptions().length > 0) {
            <nav class="q-filters" aria-label="Filter the queue by app">
              <button
                type="button"
                [class.on]="activeFilter() === 'all'"
                [attr.aria-pressed]="activeFilter() === 'all'"
                (click)="filterChanged.emit('all')"
              >
                All
              </button>
              @for (option of appOptions(); track option.key) {
                <button
                  type="button"
                  [class.on]="activeFilter() === option.key"
                  [attr.aria-pressed]="activeFilter() === option.key"
                  (click)="filterChanged.emit(option.key)"
                >
                  {{ option.label }} <span class="mono">{{ option.count }}</span>
                </button>
              }
            </nav>
          }
          @for (item of queue(); track item.request.id) {
            <article
              class="need"
              [class.is-gate]="item.kind === 'gate'"
              [class.is-stalled]="item.kind === 'stalled'"
              [class.is-owned]="item.kind === 'owned'"
              tabindex="0"
              [attr.aria-label]="item.request.title + ', ' + chip(item)"
            >
              <div class="n-top">
                <span class="n-chip">{{ chip(item) }}</span>
                @if (item.age) {
                  <span
                    class="n-age mono"
                    [class.aged]="item.aged"
                    [title]="'waiting since ' + (item.request.stage_entered_at ?? '')"
                    >waiting {{ item.age }}</span
                  >
                }
              </div>
              <a class="n-title" [routerLink]="['/requests', item.request.id]">{{
                item.request.title
              }}</a>
              <p class="n-meta mono">{{ item.request.ref }} · {{ item.request.app_name }}</p>
              @if (item.kind === 'gate') {
                @if (item.facts.length > 0) {
                  <p class="n-facts mono">
                    @for (fact of item.facts; track fact.text) {
                      <span [class]="fact.tone">{{ fact.text }}</span>
                    }
                  </p>
                }
              } @else if (item.kind === 'stalled') {
                <p class="n-why">
                  {{
                    item.request.needs_human_reason ||
                      item.request.last_event ||
                      'No signal recorded'
                  }}
                </p>
              } @else {
                <p class="n-why">{{ item.owner }} is finishing this by hand in the PR.</p>
              }
              @if (actionOutcomes()[item.request.id]; as outcome) {
                <p
                  class="action-outcome"
                  [class.conflict]="outcome.kind === 'conflict'"
                  role="status"
                >
                  {{ outcome.message }}
                </p>
              }
              <div class="n-actions">
                @if (item.kind === 'gate') {
                  <button class="act primary" type="button" (click)="approved.emit(asGate(item))">
                    {{ item.headline }} <kbd>A</kbd>
                  </button>
                  <button class="act" type="button" (click)="sentBack.emit(asGate(item))">
                    Send back <kbd>S</kbd>
                  </button>
                  @if (item.request.repo) {
                    <a
                      class="act link"
                      [href]="'https://github.com/' + item.request.repo"
                      target="_blank"
                      rel="noopener"
                      >Repo ↗</a
                    >
                  }
                } @else if (item.kind === 'stalled') {
                  <button
                    class="act primary"
                    type="button"
                    (click)="retryRequested.emit(item.request)"
                  >
                    Retry stage
                  </button>
                  <button
                    class="act"
                    type="button"
                    (click)="sendBackToStageRequested.emit(item.request)"
                  >
                    Send back to…
                  </button>
                  <button class="act" type="button" (click)="takeOverRequested.emit(item.request)">
                    Take over
                  </button>
                  <button class="act danger" type="button" (click)="cancelled.emit(item.request)">
                    Cancel
                  </button>
                } @else {
                  <a class="act link" [routerLink]="['/requests', item.request.id]">Open dossier</a>
                  <button class="act danger" type="button" (click)="cancelled.emit(item.request)">
                    Cancel
                  </button>
                }
              </div>
            </article>
          }
        </aside>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      padding-bottom: 72px;
    }

    /* ── header: one quiet pulse line, no stat tiles ── */
    .head {
      padding: 30px 0 0;
    }
    h1 {
      font-size: 23px;
      letter-spacing: -0.015em;
    }
    .pulse {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 6px 10px;
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 13.5px;
    }
    .pulse b {
      color: var(--fg1);
      font-size: 14px;
      font-weight: 600;
    }
    .pulse b.hot {
      color: var(--amber-tx);
    }
    .pulse b.bad {
      color: var(--red-tx);
    }
    .sep {
      width: 3px;
      height: 3px;
      border-radius: 50%;
      background: var(--border-strong);
      align-self: center;
    }
    .quiet-stat {
      color: var(--faint);
    }
    .quiet-stat b {
      color: var(--fg2);
      font-weight: 600;
    }

    /* ── the cockpit: line left, decisions right, one screen ── */
    .cockpit {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 308px;
      gap: 0 36px;
      align-items: start;
      margin-top: 6px;
    }
    .zone-head {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin: 26px 0 10px;
      padding-bottom: 9px;
      border-bottom: 1px solid var(--hairline);
    }
    h2 {
      font-size: 15px;
      font-weight: 600;
    }
    .zone-note {
      margin: 0 0 0 auto;
      color: var(--faint);
      font-size: 12px;
    }
    .zcount {
      min-width: 20px;
      padding: 1px 7px;
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
      border-radius: var(--r-pill);
      font-size: 11.5px;
      font-weight: 600;
      text-align: center;
    }

    /* ── the line: one row per request, five segments, two ◆ joints ── */
    .line {
      overflow-x: auto;
    }
    .line-inner {
      min-width: 700px;
    }
    .lrow {
      display: grid;
      grid-template-columns: minmax(176px, 320px) minmax(0, 1fr) minmax(140px, 190px);
      gap: 0 16px;
      align-items: center;
      padding: 0 10px;
      margin: 0 -10px;
      border-radius: var(--r);
      text-decoration: none;
    }
    .lrow.live,
    .lrow.tone-done {
      min-height: 41px;
    }
    .lrow.live + .lrow.live {
      border-top: 1px solid var(--hairline);
    }
    a.lrow:hover {
      background: var(--surface-2);
    }
    a.lrow:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--accent-tint-bd);
    }

    /* header row: stage names over the segments, gate names under the joints */
    .lhead {
      align-items: start;
      min-height: 60px;
      margin-bottom: 4px;
    }
    .lhead:hover {
      background: none;
    }
    .lhead .track {
      align-items: flex-start;
    }
    .lhead .joint {
      padding-top: 3px;
    }
    .slab {
      display: block;
      flex: 1 1 0;
      min-width: 0;
    }
    .sname {
      display: block;
      color: var(--muted);
      font-size: 10.5px;
      font-weight: 600;
      line-height: 1.25;
    }
    .sname b {
      color: var(--faint);
      font-size: 10px;
      font-weight: 500;
    }
    .gname {
      position: absolute;
      top: 34px;
      left: 50%;
      transform: translateX(-50%);
      color: var(--faint);
      font-size: 10px;
      font-style: normal;
      font-weight: 600;
      white-space: nowrap;
    }
    .gname.hot {
      color: var(--amber-tx);
    }

    /* the track itself */
    .track {
      display: flex;
      align-items: center;
      min-width: 0;
    }
    .joint {
      position: relative;
      display: flex;
      flex: 0 0 14px;
      align-items: center;
      justify-content: center;
    }
    .joint.gated {
      flex-basis: 30px;
    }
    .dia {
      width: 8px;
      height: 8px;
      background: var(--surface);
      border: 1.5px solid var(--border-strong);
      border-radius: 1.5px;
      transform: rotate(45deg);
    }
    .dia.passed {
      background: var(--border-strong);
    }
    .dia.hot {
      background: var(--amber);
      border-color: var(--amber);
      animation: gate-pulse 1.8s var(--ease) infinite;
    }
    @keyframes gate-pulse {
      0%,
      100% {
        box-shadow: 0 0 0 0 var(--amber-bg);
        opacity: 1;
      }
      50% {
        box-shadow: 0 0 0 4px var(--amber-bg);
        opacity: 0.75;
      }
    }
    .seg {
      position: relative;
      flex: 1 1 0;
      min-width: 22px;
      height: 7px;
      border-radius: 4px;
      overflow: hidden;
    }
    .seg.todo {
      box-shadow: inset 0 0 0 1px var(--border);
    }
    .seg.done {
      background: var(--border-strong);
    }
    .seg.current {
      background: var(--surface-3);
      box-shadow: inset 0 0 0 1px var(--border-strong);
    }
    .fill {
      position: absolute;
      inset: 0 auto 0 0;
      display: block;
      background: var(--accent);
      border-radius: 4px;
    }
    .tone-run .seg.current {
      box-shadow: inset 0 0 0 1px var(--accent-tint-bd);
      background: var(--accent-tint);
    }
    .tone-human .seg.current {
      background: var(--red-bg);
      box-shadow: inset 0 0 0 1px var(--red-line);
    }
    .tone-owned .seg.current {
      background: var(--accent-tint);
      box-shadow: inset 0 0 0 1px var(--accent-tint-bd);
    }
    .tone-wait .seg.current,
    .tone-draft .seg.current {
      background: transparent;
      box-shadow: none;
      border: 1px dashed var(--border-strong);
    }

    /* row meta: dense single line */
    .meta {
      display: flex;
      align-items: baseline;
      gap: 8px;
      min-width: 0;
    }
    .rref {
      color: var(--faint);
      font-size: 10.5px;
      flex: 0 0 auto;
    }
    .rtitle {
      color: var(--fg1);
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rapp {
      color: var(--faint);
      font-size: 11px;
      white-space: nowrap;
      flex: 0 0 auto;
    }
    .tone-done .rtitle {
      color: var(--muted);
      font-weight: 500;
    }

    /* row state: what is true right now */
    .rstate {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: 11.5px;
      color: var(--muted);
    }
    .stext {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sdia {
      font-size: 9px;
      font-style: normal;
      color: var(--amber);
    }
    .rage {
      margin-left: auto;
      color: var(--faint);
      font-size: 10.5px;
      flex: 0 0 auto;
    }
    .tone-run .rstate {
      color: var(--fg2);
    }
    .tone-run .rstate sf-glyph {
      color: var(--accent);
    }
    .tone-gate .rstate {
      color: var(--amber-tx);
      font-weight: 600;
    }
    .tone-human .rstate {
      color: var(--red-tx);
      font-weight: 600;
    }
    .tone-owned .rstate {
      color: var(--accent-tx);
    }
    .tone-draft .rstate {
      color: var(--faint);
    }
    .tone-done .rstate {
      color: var(--green-tx);
    }

    .shipped-head {
      margin: 22px 0 4px;
      padding-top: 12px;
      border-top: 1px solid var(--hairline);
      color: var(--faint);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .tone-done .seg.done {
      opacity: 0.55;
    }
    .tone-done .dia.passed {
      opacity: 0.55;
    }
    .line-empty {
      margin: 14px 0 0;
      color: var(--muted);
      font-size: 13.5px;
    }
    .line-empty a {
      color: var(--accent-link);
    }

    /* ── the rail: every decision, always in reach ── */
    .rail {
      position: sticky;
      top: 14px;
    }
    .all-clear {
      margin: 0;
      padding: 11px 14px;
      color: var(--green-tx);
      background: var(--green-bg);
      border: 1px solid var(--green-line);
      border-radius: var(--r);
      font-size: 13px;
    }
    .q-filters {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0 0 10px;
    }
    .q-filters button {
      padding: 4px 11px;
      color: var(--muted);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-pill);
      font: 600 12px var(--body);
      cursor: pointer;
    }
    .q-filters button:hover {
      color: var(--fg1);
      border-color: var(--border-strong);
    }
    .q-filters button.on {
      color: var(--fg1);
      background: var(--surface-2);
      border-color: var(--border-strong);
    }
    .q-filters .mono {
      color: var(--faint);
      font-size: 10.5px;
    }

    .need {
      padding: 12px 14px;
      margin-bottom: 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      outline: none;
    }
    .need.is-gate {
      border-color: var(--amber-line);
    }
    .need.is-stalled {
      border-color: var(--red-line);
    }
    .need:focus-visible {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-tint-bd);
    }
    .n-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .n-chip {
      padding: 2px 9px;
      border-radius: var(--r);
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }
    .is-gate .n-chip {
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
    }
    .is-stalled .n-chip {
      color: var(--red-tx);
      background: var(--red-bg);
      border: 1px solid var(--red-line);
    }
    .is-owned .n-chip {
      color: var(--accent-tx);
      background: var(--accent-tint);
      border: 1px solid var(--accent-tint-bd);
    }
    .n-age {
      color: var(--faint);
      font-size: 10.5px;
    }
    .n-age.aged {
      color: var(--amber-tx);
      font-weight: 600;
    }
    .n-title {
      display: block;
      margin-top: 8px;
      color: var(--fg1);
      font-size: 13.5px;
      font-weight: 600;
      line-height: 1.35;
      text-decoration: none;
    }
    .n-title:hover {
      color: var(--accent-link);
    }
    .n-meta {
      margin: 3px 0 0;
      color: var(--faint);
      font-size: 11px;
    }
    .n-facts {
      display: flex;
      flex-wrap: wrap;
      gap: 3px 12px;
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 11px;
    }
    .n-facts .green {
      color: var(--green-tx);
    }
    .n-facts .red {
      color: var(--red-tx);
    }
    .n-facts .purple {
      color: var(--accent-tx);
    }
    .n-why {
      margin: 8px 0 0;
      color: var(--fg2);
      font-size: 12.5px;
      line-height: 1.4;
    }
    .n-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin-top: 11px;
    }
    .act {
      padding: 6px 11px;
      color: var(--fg1);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--r);
      font: 600 12px var(--body);
      text-decoration: none;
      cursor: pointer;
      transition: background var(--dur) var(--ease);
    }
    .act:hover {
      background: var(--surface-2);
    }
    .act.primary {
      color: #fff;
      background: var(--accent);
      border-color: var(--accent);
    }
    .act.primary:hover {
      background: var(--accent-hover);
    }
    .act.danger {
      color: var(--red-tx);
      border-color: var(--red-line);
    }
    .act.link {
      border-color: transparent;
      color: var(--accent-link);
    }
    .act kbd {
      margin-left: 4px;
      padding: 0 4px;
      border: 1px solid currentColor;
      border-radius: var(--r-sm);
      font: 500 9.5px var(--mono);
      opacity: 0.75;
    }
    .action-outcome {
      margin: 8px 0 0;
      padding: 7px 11px;
      color: var(--muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--r);
      font-size: 12px;
    }
    .action-outcome.conflict {
      color: var(--amber-tx);
      background: var(--amber-bg);
      border-color: var(--amber-line);
    }

    @media (max-width: 1360px) {
      .rapp {
        display: none;
      }
    }
    @media (max-width: 1120px) {
      .cockpit {
        grid-template-columns: minmax(0, 1fr);
      }
      .rail {
        position: static;
        order: -1;
      }
    }
    @media (max-width: 720px) {
      .head {
        padding-top: 24px;
      }
      .lrow {
        grid-template-columns: minmax(150px, 200px) minmax(0, 1fr) minmax(120px, 150px);
        gap: 0 12px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      * {
        transition: none !important;
        animation: none !important;
      }
    }
  `,
})
export class FloorContent {
  mission = input.required<MissionOut>();
  requests = input.required<FactoryRequest[]>();
  intakeUrl = input('http://localhost:4201/submit/new');
  actionOutcomes = input<Record<number, FloorActionOutcome>>({});
  approved = output<MissionGate>();
  sentBack = output<MissionGate>();
  retryRequested = output<FactoryRequest>();
  sendBackToStageRequested = output<FactoryRequest>();
  takeOverRequested = output<FactoryRequest>();
  cancelled = output<FactoryRequest>();

  /** The visible queue — derived and filtered by the page so keyboard order matches. */
  queue = input.required<QueueItem[]>();
  appOptions = input<{ key: string; label: string; count: number }[]>([]);
  activeFilter = input('all');
  filterChanged = output<string>();

  stages = STAGES;
  line = computed(() => {
    const runs = new Map<number, RunState>(
      this.mission().runs.map((run) => [run.request.id, run.run]),
    );
    return deriveLine(this.requests(), runs);
  });
  tallies = computed(() => deriveTallies(this.mission(), this.requests()));

  chip = queueChip;

  /** Joints sit before stage 1 (build approval) and stage 4 (deploy approval). */
  gateIdx(stageIndex: number): 0 | 1 {
    return stageIndex === 1 ? 0 : 1;
  }
  gateLabel(stageIndex: number): string {
    const name = STAGES[stageIndex].gate ?? '';
    const waiting = this.line().gateCounts[this.gateIdx(stageIndex)];
    return waiting > 0 ? `◆ ${name} · ${waiting}` : `◆ ${name}`;
  }
  rowLabel(row: TrackRow): string {
    const stage = row.stageIndex >= 5 ? 'Shipped' : STAGES[row.stageIndex].label;
    return `${row.title}, ${stage}, ${row.state}`;
  }
  /** The modals still speak MissionGate; rebuild it from the queue item. */
  asGate(item: { request: FactoryRequest; evidence: MissionGate['evidence'] }): MissionGate {
    return { request: item.request, evidence: item.evidence };
  }
}
