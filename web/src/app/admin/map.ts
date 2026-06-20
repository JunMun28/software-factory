import {
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';

import { Api } from '../core/api.service';
import { activeRun, factoryColumns, MapCard, MapColumn, sortedExceptions } from '../core/map-view';
import { MissionOut } from '@sf/shared';
import { Poll } from '../core/poll.service';
import { Store } from '../core/store.service';
import { AdminShell } from './admin-shell';

/** Factory map (ADR 0016) — a spatial overview lens, NOT the worklist.
 *  Every live Work item across stage columns; click a card to drill into its
 *  delivery map on request-detail. Derived from store.requests + store.mission
 *  (stores nothing new). Mission control stays the default landing + worklist. */
@Component({
  selector: 'sf-map-page',
  imports: [AdminShell],
  template: `
    <admin-shell active="map" title="Factory map">
      <span headerExtra class="row" style="gap:10px">
        <span style="font-size:12.5px;color:var(--muted)">{{ subtitle() }}</span>

        <!-- P2 toolbar: filter + search -->
        <span class="seg fm-toolbar" style="margin-left:12px">
          <button [class.on]="filter() === 'all'" (click)="filter.set('all')">All</button>
          <button [class.on]="filter() === 'attention'" (click)="filter.set('attention')">
            Needs attention
          </button>
        </span>
        <input
          #searchEl
          class="fm-search"
          type="search"
          placeholder="Search…"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
          (keydown.escape)="searchEl.blur()"
          aria-label="Search work items"
        />
        <span class="fm-keys" aria-hidden="true">
          <kbd class="kbd">/</kbd> search <kbd class="kbd">J</kbd><kbd class="kbd">K</kbd> move
          <kbd class="kbd">↵</kbd> open <kbd class="kbd">F</kbd> filter
        </span>
      </span>

      <div class="scroll" style="position:absolute;inset:0;overflow:auto;padding:18px 20px 28px">
        <div class="fm-kpis">
          @for (k of kpis(); track k.lbl) {
            <div class="fm-kpi" [style.--kc]="k.color">
              <div class="fm-kpi__l"><span class="fm-kpi__dot"></span>{{ k.lbl }}</div>
              <div class="fm-kpi__n">{{ k.n }}</div>
            </div>
          }
        </div>

        @if (active(); as a) {
          <button
            class="fm-now"
            [attr.aria-label]="
              'Agent now working on ' +
              a.title +
              ', ' +
              a.ref +
              ', ' +
              a.app +
              ', stage ' +
              a.stageLabel +
              ', ' +
              a.pct +
              ' percent'
            "
            (click)="open(a.id)"
          >
            <div class="fm-now__who">
              <div class="fm-now__lab">
                <span class="fm-now__live" aria-hidden="true"></span>AGENT // NOW WORKING
              </div>
              <div class="fm-now__lane">1 of 1 lane active</div>
            </div>
            <div class="fm-now__run">
              <div class="fm-now__top">
                <span class="fm-now__ti">{{ a.title }}</span>
                <span class="fm-now__meta">{{ a.app }} · {{ a.ref }}</span>
                <span class="fm-now__stage">{{ a.stageLabel }}</span>
              </div>
              <div class="fm-now__step">{{ a.label }}…</div>
              <div class="fm-now__bar">
                <span [style.transform]="'scaleX(' + a.pct / 100 + ')'"></span>
              </div>
            </div>
            <div class="fm-now__meter">
              <div class="fm-now__pct">{{ a.pct }}%</div>
              @if (a.of) {
                <div class="fm-now__step2">step {{ a.step }}/{{ a.of }}</div>
              }
            </div>
          </button>
        } @else {
          <div class="fm-now fm-now--idle">
            <div class="fm-now__lab">
              <span class="fm-now__live fm-now__live--idle" aria-hidden="true"></span>AGENT // IDLE
            </div>
            <div class="fm-now__idletext">No active run — the lane is clear, agents ready.</div>
          </div>
        }

        @if (!loaded()) {
          <!-- Loading skeleton -->
          <div class="fm-lane fm-skel-lane">
            @for (_ of [0, 1, 2, 3, 4, 5]; track $index) {
              <div class="fm-stage">
                <div class="fm-hd">
                  <div class="fm-skel fm-skel--ring"></div>
                  <div class="fm-skel fm-skel--name"></div>
                  <div class="fm-skel fm-skel--sub"></div>
                </div>
                <div class="fm-cards">
                  <div class="fm-skel fm-skel--card"></div>
                  <div class="fm-skel fm-skel--card"></div>
                </div>
              </div>
            }
          </div>
        } @else {
          <div class="fm-scroll">
            <div class="fm-lane">
              @for (col of columns(); track col.key) {
                <div class="fm-stage">
                  <!-- Sticky per-column ring header (P1) -->
                  <div class="fm-hd" [attr.aria-label]="hdAriaLabel(col)">
                    <div
                      class="fm-ring"
                      [style.--rp]="ringPct(col)"
                      [style.--rc]="hotColor(col)"
                      [attr.aria-label]="ringAriaLabel(col)"
                      [title]="ringTitle(col)"
                    >
                      <span class="fm-ring__n">{{ count(col) }}</span>
                    </div>
                    <div class="fm-name">{{ col.label }}</div>
                    <!-- Re-homed waiting count as interactive amber chip (P0) -->
                    @if (waitingCount(col); as w) {
                      <button
                        class="fm-sub fm-sub--wait"
                        [attr.aria-label]="waitingAriaLabel(col, w)"
                        (click)="filterToWaiting(col)"
                      >
                        {{ count(col) }} {{ count(col) === 1 ? 'item' : 'items' }} · {{ w }}
                        {{ waitingLabel(col) }} →
                      </button>
                    } @else {
                      <div class="fm-sub">
                        {{ count(col) }} {{ count(col) === 1 ? 'item' : 'items' }}
                      </div>
                    }
                  </div>

                  <!-- Aggregate-first card body (P0) -->
                  <div class="fm-cards">
                    @let peek = exceptionPeek(col);
                    @let extraRun = runningCount(col);
                    @let extraMore = moreCount(col);

                    @if (col.cards.length === 0) {
                      <div class="fm-empty">stage idle</div>
                    } @else {
                      <!-- Top-5 exceptions peek -->
                      @for (c of peek; track c.id) {
                        <button
                          class="fm-card"
                          [class.fm-card--focus]="c.id === focusedId()"
                          [attr.data-st]="c.state"
                          [attr.aria-label]="cardAriaLabel(c)"
                          (click)="open(c.id)"
                        >
                          <div class="fm-card__t">
                            @if (c.state === 'run') {
                              <span class="fm-pulse" aria-hidden="true"></span>
                            }
                            <span class="fm-card__ti" [title]="c.title">{{ c.title }}</span>
                          </div>
                          <div class="fm-card__ref" [title]="c.ref + ' · ' + c.app">
                            {{ c.ref }} · {{ c.app }}
                          </div>
                          <div class="fm-card__meta">
                            @if (pill(c); as p) {
                              <span class="fm-pill" [attr.data-st]="c.state">{{ p }}</span>
                            }
                            @if (c.state === 'run' && c.of) {
                              <span class="fm-step">step {{ c.step }}/{{ c.of }}</span>
                            }
                          </div>
                        </button>
                      }

                      <!-- +N running collapse chip -->
                      @if (extraRun > 0) {
                        <div
                          class="fm-chip fm-chip--run"
                          [attr.aria-label]="extraRun + ' more running'"
                        >
                          <span class="fm-pulse fm-pulse--sm" aria-hidden="true"></span>
                          +{{ extraRun }} running
                        </div>
                      }

                      <!-- +N more → drill chip -->
                      @if (extraMore > 0) {
                        <button
                          class="fm-chip fm-chip--more"
                          [attr.aria-label]="'Show all ' + count(col) + ' items in ' + col.label"
                          (click)="drillToStage(col)"
                        >
                          +{{ extraMore }} more →
                        </button>
                      }
                    }
                  </div>
                </div>
              }
            </div>
          </div>
        }
      </div>
    </admin-shell>
  `,
  styles: `
    /* ── Cockpit canvas: blueprint grid ── */
    .scroll {
      background-image:
        linear-gradient(var(--mc-grid) 1px, transparent 1px),
        linear-gradient(90deg, var(--mc-grid) 1px, transparent 1px);
      background-size: 44px 44px;
    }

    /* ── Now-working band (single-lane hero) ── */
    .fm-now {
      position: relative;
      display: grid;
      grid-template-columns: 190px 1fr 130px;
      align-items: center;
      gap: 22px;
      width: 100%;
      text-align: left;
      margin-bottom: 22px;
      padding: 16px 20px;
      border: 1px solid var(--cyan-line);
      border-radius: var(--r-lg);
      background:
        linear-gradient(120deg, var(--cyan-bg), rgba(189, 3, 247, 0.05) 55%, transparent 82%),
        var(--glass);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      box-shadow:
        var(--glass-shadow),
        0 0 50px -22px var(--glow-cy);
      cursor: pointer;
      font-family: var(--body);
      overflow: hidden;
      transition:
        border-color var(--dur) var(--ease),
        transform var(--dur) var(--ease);
    }
    .fm-now:hover {
      transform: translateY(-1px);
      border-color: var(--cyan);
    }
    .fm-now::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: linear-gradient(var(--cyan), var(--a500));
      box-shadow: 0 0 16px var(--glow-cy);
    }
    .fm-now--idle {
      grid-template-columns: 1fr;
      cursor: default;
      border-color: var(--glass-bd2);
      background: var(--glass);
      box-shadow: var(--glass-shadow);
    }
    .fm-now--idle::before {
      background: var(--glass-bd2);
      box-shadow: none;
    }
    .fm-now__who {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .fm-now__lab {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.14em;
      color: var(--cyan);
    }
    .fm-now__live {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--cyan);
      box-shadow: 0 0 0 0 var(--glow-cy);
      animation: fm-beat 1.7s infinite;
    }
    .fm-now__live--idle {
      background: var(--faint);
      box-shadow: none;
      animation: none;
    }
    @keyframes fm-beat {
      0% {
        box-shadow: 0 0 0 0 var(--glow-cy);
      }
      70% {
        box-shadow: 0 0 0 7px transparent;
      }
      100% {
        box-shadow: 0 0 0 0 transparent;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .fm-now__live {
        animation: none;
      }
      .fm-now__bar > span::after {
        animation: none;
      }
    }
    .fm-now__lane {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .fm-now__run {
      min-width: 0;
    }
    .fm-now__top {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .fm-now__ti {
      font-size: 17px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .fm-now__meta {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
    }
    .fm-now__stage {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      color: var(--cyan);
      padding: 3px 9px;
      border-radius: 6px;
      background: var(--cyan-bg);
      border: 1px solid var(--cyan-line);
      text-transform: uppercase;
    }
    .fm-now__step {
      font-family: var(--mono);
      font-size: 12.5px;
      color: var(--fg2);
      margin-bottom: 11px;
    }
    .fm-now__bar {
      height: 7px;
      border-radius: 5px;
      background: var(--surface-3);
      overflow: hidden;
      position: relative;
      max-width: 560px;
    }
    .fm-now__bar > span {
      display: block;
      width: 100%;
      height: 100%;
      border-radius: 5px;
      background: linear-gradient(90deg, var(--a500), var(--cyan));
      box-shadow: 0 0 14px var(--glow-cy);
      position: relative;
      overflow: hidden;
      transform-origin: left center;
      /* transform (not width) to keep the fill off the layout path */
      transition: transform 0.6s var(--ease);
    }
    .fm-now__bar > span::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.5), transparent);
      transform: translateX(-100%);
      animation: fm-sheen 1.8s linear infinite;
    }
    @keyframes fm-sheen {
      to {
        transform: translateX(120%);
      }
    }
    .fm-now__meter {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
      text-align: right;
    }
    .fm-now__pct {
      font-family: var(--mono);
      font-size: 24px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .fm-now__step2 {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--faint);
    }
    .fm-now__idletext {
      font-size: 13px;
      color: var(--muted);
      margin-top: 6px;
    }

    /* ── Telemetry tiles ── */
    .fm-kpis {
      display: grid;
      grid-template-columns: repeat(4, minmax(150px, 1fr));
      gap: 14px;
      margin-bottom: 22px;
    }
    .fm-kpi {
      position: relative;
      border: 1px solid var(--glass-bd);
      border-radius: var(--r-lg);
      background: linear-gradient(160deg, rgba(255, 255, 255, 0.04), transparent 60%), var(--glass);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      box-shadow:
        var(--glass-shadow),
        0 0 30px -18px var(--kc, transparent);
      padding: 14px 16px 13px;
      overflow: hidden;
    }
    /* HUD corner ticks */
    .fm-kpi::before,
    .fm-kpi::after {
      content: '';
      position: absolute;
      width: 11px;
      height: 11px;
      opacity: 0.55;
    }
    .fm-kpi::before {
      top: 9px;
      left: 9px;
      border-top: 1.5px solid var(--glass-bd2);
      border-left: 1.5px solid var(--glass-bd2);
    }
    .fm-kpi::after {
      bottom: 9px;
      right: 9px;
      border-bottom: 1.5px solid var(--glass-bd2);
      border-right: 1.5px solid var(--glass-bd2);
    }
    .fm-kpi__l {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .fm-kpi__dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--kc, var(--a500));
      box-shadow: 0 0 9px var(--kc, var(--a500));
    }
    .fm-kpi__n {
      font-family: var(--mono);
      font-size: 40px;
      font-weight: 700;
      line-height: 1;
      margin-top: 12px;
      letter-spacing: -0.02em;
      font-variant-numeric: tabular-nums;
    }

    /* ── Toolbar (P2) ── */
    .fm-toolbar {
      font-size: 12px;
    }
    .fm-search {
      border: 1px solid var(--border-strong);
      border-radius: var(--r);
      background: var(--surface);
      color: var(--fg1);
      font-family: var(--body);
      font-size: 12.5px;
      padding: 4px 10px;
      outline: none;
      width: 160px;
    }
    .fm-search:focus {
      border-color: var(--a500);
    }
    /* keyboard-grammar hint (mirrors the queue header's advertised keys) */
    .fm-keys {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: var(--faint);
      white-space: nowrap;
    }

    /* ── Lane + stage grid (P0 fit-to-width) ── */
    .fm-scroll {
      overflow-x: auto;
      padding-bottom: 6px;
    }
    .fm-lane {
      position: relative;
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 0;
      padding: 6px 0;
      min-width: 768px; /* allow scroll below 768, fill above */
    }
    /* the conveyor: a calm static pipe… */
    .fm-lane::before {
      content: '';
      position: absolute;
      left: 80px;
      right: 40px;
      top: 38px;
      height: 2px;
      border-radius: 2px;
      background: linear-gradient(
        90deg,
        transparent,
        var(--cyan-line) 10%,
        var(--cyan-line) 90%,
        transparent
      );
      opacity: 0.7;
    }
    /* …plus a glowing bead flowing downstream — see .fm-lane::after in styles.css. */
    @media (prefers-reduced-motion: reduce) {
      .fm-ring {
        transition: none !important;
      }
    }
    .fm-stage {
      padding: 0 9px;
      position: relative;
      z-index: 1;
    }

    /* ── Sticky ring header (P1) ── */
    .fm-hd {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      text-align: center;
      margin-bottom: 12px;
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--bg);
      padding: 6px 0 8px;
    }
    .fm-ring {
      position: relative;
      width: 58px;
      height: 58px;
      border-radius: 50%;
      background: conic-gradient(
        var(--rc, var(--a500)) calc(var(--rp, 0) * 1%),
        var(--surface-3) 0
      );
      box-shadow: 0 0 18px -4px var(--rc, var(--a500));
      /* registered @property --rp lets the conic arc interpolate: the dial
         sweeps to its value on load/poll instead of snapping */
      transition:
        --rp 0.8s var(--ease),
        box-shadow 0.4s var(--ease);
    }
    .fm-ring::before {
      content: '';
      position: absolute;
      inset: 5px;
      border-radius: 50%;
      background: var(--bg);
    }
    .fm-ring__n {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      font-family: var(--mono);
      font-weight: 700;
      font-size: 24px;
      font-variant-numeric: tabular-nums;
    }
    .fm-name {
      font-size: 14px;
      font-weight: 700;
    }
    /* Sub-line: plain item count */
    .fm-sub {
      font-size: 11.5px; /* raised from 10.5px (P0) */
      color: var(--muted);
    }
    /* Sub-line: interactive amber waiting chip */
    .fm-sub--wait {
      display: inline-flex;
      align-items: center;
      gap: 0;
      font-size: 11.5px; /* raised from 10.5px (P0) */
      font-weight: 600;
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
      border-radius: 999px;
      padding: 1px 9px;
      cursor: pointer;
      font-family: var(--body);
      transition: opacity var(--dur) var(--ease);
      white-space: nowrap;
    }
    .fm-sub--wait:hover {
      opacity: 0.8;
    }

    /* ── Card body ── */
    .fm-cards {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    /* ── Card — shape language (P1): reuses bcard spine idea ── */
    .fm-card {
      text-align: left;
      width: 100%;
      border: 1px solid var(--glass-bd);
      border-left-width: 3px; /* spine (P1) */
      border-left-color: var(--glass-bd2);
      border-radius: var(--r-lg);
      background: linear-gradient(150deg, rgba(255, 255, 255, 0.04), transparent 70%), var(--glass);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow:
        0 14px 30px -22px rgba(0, 0, 0, 0.6),
        inset 0 1px 0 var(--glass-hi);
      padding: 10px 11px;
      cursor: pointer;
      font-family: var(--body);
      transition:
        border-color var(--dur) var(--ease),
        transform var(--dur) var(--ease),
        box-shadow var(--dur) var(--ease);
    }
    .fm-card:hover {
      border-color: var(--glass-bd2);
      transform: translateY(-2px);
    }
    /* keyboard-roving focus (J/K) — distinct from hover */
    .fm-card--focus {
      border-color: var(--accent-tint-bd);
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    /* State spine colors (P1) */
    .fm-card[data-st='gate'] {
      border-left-color: var(--amber);
      box-shadow:
        0 14px 30px -22px rgba(0, 0, 0, 0.6),
        0 0 22px -12px var(--glow-am),
        inset 0 1px 0 var(--glass-hi);
    }
    .fm-card[data-st='stalled'] {
      border-left-color: var(--red);
      box-shadow:
        0 14px 30px -22px rgba(0, 0, 0, 0.6),
        0 0 22px -10px var(--glow-rd),
        inset 0 1px 0 var(--glass-hi);
    }
    .fm-card[data-st='run'] {
      border-left-color: var(--cyan);
      box-shadow:
        0 14px 30px -22px rgba(0, 0, 0, 0.6),
        0 0 22px -12px var(--glow-cy),
        inset 0 1px 0 var(--glass-hi);
    }
    .fm-card[data-st='sent'] {
      border-left-color: var(--info);
    }

    /* ── Pulse animation ── */
    .fm-pulse {
      position: relative;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--a500);
      flex: none;
    }
    .fm-pulse::after {
      content: '';
      position: absolute;
      inset: -4px;
      border-radius: 50%;
      border: 1px solid var(--a500);
      opacity: 0.4;
      animation: fm-pulse 1.8s var(--ease) infinite;
    }
    .fm-pulse--sm {
      width: 6px;
      height: 6px;
    }
    .fm-pulse--sm::after {
      inset: -3px;
    }
    @keyframes fm-pulse {
      from {
        transform: scale(0.6);
        opacity: 0.5;
      }
      to {
        transform: scale(1.6);
        opacity: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .fm-pulse::after {
        animation: none;
      }
    }

    /* ── Card text rows ── */
    .fm-card__t {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 14px;
      font-weight: 600;
    }
    .fm-card__ti {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .fm-card__ref {
      font-family: var(--mono);
      font-size: 11px; /* raised from 10px (P0); --faint → --muted */
      color: var(--muted); /* raised from --faint (P0) */
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .fm-card__meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 7px;
    }
    .fm-pill {
      font-size: 11.5px; /* raised from 8.5px (P0) */
      font-weight: 700;
      /* removed text-transform:uppercase + letter-spacing (P0) */
      padding: 1px 6px;
      border-radius: 4px;
    }
    .fm-pill[data-st='gate'] {
      color: var(--amber-tx);
      background: var(--amber-bg);
      border: 1px solid var(--amber-line);
    }
    .fm-pill[data-st='stalled'] {
      color: var(--red-tx);
      background: var(--red-bg);
      border: 1px solid var(--red-line);
    }
    .fm-pill[data-st='run'] {
      color: var(--accent-tx);
      background: var(--a50);
      border: 1px solid var(--a100);
    }
    .fm-pill[data-st='sent'] {
      color: var(--info);
      background: var(--info-bg);
      border: 1px solid var(--border);
    }
    .fm-step {
      font-family: var(--mono);
      font-size: 11px; /* raised from 10px (P0) */
      color: var(--muted);
      margin-left: auto;
    }
    .fm-empty {
      border: 1px dashed var(--glass-bd2);
      border-radius: var(--r-lg);
      padding: 18px 10px;
      text-align: center;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      background: repeating-linear-gradient(
        45deg,
        rgba(255, 255, 255, 0.015),
        rgba(255, 255, 255, 0.015) 8px,
        transparent 8px,
        transparent 16px
      );
    }

    /* ── Aggregate collapse chips (P0) ── */
    .fm-chip {
      font-size: 11.5px;
      font-weight: 600;
      border-radius: var(--r-lg);
      padding: 6px 10px;
      text-align: center;
      cursor: default;
    }
    .fm-chip--run {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      color: var(--accent-tx);
      background: var(--a50);
      border: 1px solid var(--a100);
    }
    .fm-chip--more {
      color: var(--muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      cursor: pointer;
      font-family: var(--body);
      width: 100%;
      transition: border-color var(--dur) var(--ease);
    }
    .fm-chip--more:hover {
      border-color: var(--border-strong);
      color: var(--fg1);
    }

    /* ── Loading skeleton (P2) ── */
    .fm-skel-lane {
      opacity: 0.5;
    }
    .fm-skel {
      border-radius: var(--r-lg);
      background: var(--surface-3);
      animation: fm-shimmer 1.4s ease infinite alternate;
    }
    @keyframes fm-shimmer {
      from {
        opacity: 0.4;
      }
      to {
        opacity: 0.9;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .fm-skel {
        animation: none;
        opacity: 0.5;
      }
    }
    .fm-skel--ring {
      width: 58px;
      height: 58px;
      border-radius: 50%;
    }
    .fm-skel--name {
      width: 70%;
      height: 14px;
    }
    .fm-skel--sub {
      width: 50%;
      height: 11px;
    }
    .fm-skel--card {
      height: 72px;
    }

    /* Light theme: solid instrument panel, not dark's glass + glow (see ADR 0016). */
    :host-context([data-theme='light']) .fm-kpi {
      background: var(--surface);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      border-color: var(--border);
      box-shadow:
        0 1px 2px rgba(26, 22, 50, 0.05),
        0 4px 14px -8px rgba(26, 22, 50, 0.13);
    }
    :host-context([data-theme='light']) .fm-card {
      background: var(--surface);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      /* leave border-left (the state spine) to the data-st rules */
      border-top-color: var(--border);
      border-right-color: var(--border);
      border-bottom-color: var(--border);
      box-shadow:
        0 1px 2px rgba(26, 22, 50, 0.05),
        0 4px 14px -8px rgba(26, 22, 50, 0.13);
    }
    :host-context([data-theme='light']) .fm-now {
      background: linear-gradient(118deg, var(--cyan-bg), transparent 62%), var(--surface);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      box-shadow:
        0 1px 2px rgba(26, 22, 50, 0.05),
        0 6px 18px -10px rgba(10, 143, 163, 0.22);
    }
    :host-context([data-theme='light']) .fm-now--idle {
      background: var(--surface);
      box-shadow:
        0 1px 2px rgba(26, 22, 50, 0.05),
        0 4px 14px -8px rgba(26, 22, 50, 0.11);
    }
    /* the conic ring carries its own color; drop the colored halo on light */
    :host-context([data-theme='light']) .fm-ring {
      box-shadow: 0 0 0 1px rgba(26, 22, 50, 0.04);
    }
    /* empty-stage placeholder: solid well, not a see-through box over the grid */
    :host-context([data-theme='light']) .fm-empty {
      background: var(--surface-2);
    }
  `,
})
export class FactoryMap {
  private store = inject(Store);
  private api = inject(Api);
  private poll = inject(Poll);
  private router = inject(Router);

  /** Page-scoped mission aggregate. The root Store stopped polling /api/mission on
   *  every admin page (perf, commit 7d8af99); like the Mission page, the map fetches
   *  it itself on each poll tick for run-state (step/of) overlay. */
  private mission = signal<MissionOut | null>(null);

  constructor() {
    effect(() => {
      this.poll.version();
      this.api.mission().subscribe((v) => this.mission.set(v));
    });
    // Keep the keyboard selection in range as filter/search/poll change the card set.
    effect(() => {
      const n = this.flatCards().length;
      if (untracked(this.sel) >= n) this.sel.set(Math.max(0, n - 1));
    });
  }

  /** P2 filter/search signals */
  filter = signal<'all' | 'attention'>('all');
  search = signal('');

  /** Keyboard roving (J/K) over the visible exception cards (flattened in column order). */
  private searchEl = viewChild<ElementRef<HTMLInputElement>>('searchEl');
  sel = signal(0);
  flatCards = computed(() => this.columns().flatMap((col) => this.exceptionPeek(col)));
  focusedId = computed(() => this.flatCards()[this.sel()]?.id ?? -1);

  private raw = computed(() => factoryColumns(this.store.requests(), this.mission()));

  /** True once the store has emitted at least one non-null value */
  loaded = computed(() => this.store.requests().length > 0 || this.mission() !== null);

  /** The single active agent run for the "Now working" band (single-lane factory). */
  active = computed(() => activeRun(this.mission()));

  /** Columns after filter/search (P2) */
  columns = computed(() => {
    const cols = this.raw().columns;
    const q = this.search().trim().toLowerCase();
    const needsAttention = this.filter() === 'attention';

    return cols.map((col) => {
      let cards = col.cards;
      if (needsAttention) {
        cards = cards.filter((c) => c.state === 'gate' || c.state === 'stalled');
      }
      if (q) {
        cards = cards.filter(
          (c) =>
            c.title.toLowerCase().includes(q) ||
            c.ref.toLowerCase().includes(q) ||
            c.app.toLowerCase().includes(q),
        );
      }
      return { ...col, cards };
    });
  });

  /** Live items in a column; Done column shows its total */
  count(col: MapColumn): number {
    const live = col.cards.filter((c) => c.state !== 'done').length;
    return live || col.cards.length;
  }

  /** Ring fill = this column's live count normalized to the busiest column
   *  (relative volume). The P2 "fraction needing a human" reframing is deferred. */
  maxCount = computed(() => Math.max(1, ...this.columns().map((c) => this.count(c))));
  ringPct(col: MapColumn): number {
    return Math.round((this.count(col) / this.maxCount()) * 100);
  }

  hotColor(col: MapColumn): string {
    const cards = col.cards;
    if (cards.some((c) => c.state === 'stalled')) return 'var(--red)';
    if (cards.some((c) => c.state === 'gate')) return 'var(--amber)';
    if (cards.some((c) => c.state === 'run')) return 'var(--a500)';
    if (cards.length && cards.every((c) => c.state === 'done')) return 'var(--green)';
    return 'var(--faint)';
  }

  /** Waiting count from column.cards (fixes mismatch vs separate gate query) */
  waitingCount(col: MapColumn): number {
    if (col.key !== 'spec' && col.key !== 'review') return 0;
    return col.cards.filter((c) => c.state === 'gate').length;
  }

  waitingLabel(col: MapColumn): string {
    return col.key === 'review' ? 'at merge gate →' : 'awaiting approval →';
  }

  waitingAriaLabel(col: MapColumn, w: number): string {
    const label = col.key === 'review' ? 'at merge gate' : 'awaiting approval';
    return `Filter ${col.label} to ${w} ${w === 1 ? 'item' : 'items'} ${label}`;
  }

  filterToWaiting(col: MapColumn) {
    this.router.navigateByUrl(`/admin/list?stage=${col.key}&state=gate`);
  }

  drillToStage(col: MapColumn) {
    this.router.navigateByUrl(`/admin/list?stage=${col.key}`);
  }

  /** Top-5 exceptions peek sorted by severity (P0) */
  exceptionPeek(col: MapColumn): MapCard[] {
    return sortedExceptions(col.cards, 5);
  }

  /** Count of running items NOT in the peek (shown in collapse chip) */
  runningCount(col: MapColumn): number {
    const peek = this.exceptionPeek(col);
    const peekIds = new Set(peek.map((c) => c.id));
    return col.cards.filter((c) => c.state === 'run' && !peekIds.has(c.id)).length;
  }

  /** Count of non-running items beyond the peek (for "+N more" chip). */
  moreCount(col: MapColumn): number {
    const peek = this.exceptionPeek(col);
    const peekIds = new Set(peek.map((c) => c.id));
    return col.cards.filter((c) => !peekIds.has(c.id) && c.state !== 'run').length;
  }

  pill(c: MapCard): string | null {
    const m: Record<string, string | null> = {
      gate: 'Gate',
      stalled: 'Needs human',
      run: 'Running',
      sent: 'Sent back',
      triage: null,
      done: null,
    };
    return m[c.state];
  }

  /** a11y labels (P1) */
  cardAriaLabel(c: MapCard): string {
    const state = this.pill(c) ?? c.state;
    return `${c.title} · ${c.ref} · ${c.app} · ${state}`;
  }

  ringAriaLabel(col: MapColumn): string {
    const color = this.hotColor(col);
    const worstState =
      color === 'var(--red)'
        ? 'has stalled items'
        : color === 'var(--amber)'
          ? 'has items awaiting approval'
          : color === 'var(--a500)'
            ? 'has running items'
            : color === 'var(--green)'
              ? 'all done'
              : 'idle';
    return `${col.label}: ${this.count(col)} items, ${worstState}`;
  }

  hdAriaLabel(col: MapColumn): string {
    return `${col.label} stage header`;
  }

  /** Sighted-user legend for the conic ring: the fill and the centred number
   *  encode different things (relative load vs item count). */
  ringTitle(col: MapColumn): string {
    return `${col.label}: ${this.count(col)} items · ring fill shows load relative to the busiest stage`;
  }

  stats = computed(() => {
    const cards = this.raw().columns.flatMap((c) => c.cards);
    const live = cards.filter((c) => c.state !== 'done');
    return {
      live: live.length,
      run: live.filter((c) => c.state === 'run').length,
      gate: live.filter((c) => c.state === 'gate').length,
      stalled: live.filter((c) => c.state === 'stalled').length,
    };
  });

  subtitle = computed(() => {
    const s = this.stats();
    return `${s.live} in flight · ${s.gate} waiting on you · ${s.stalled} stalled`;
  });

  kpis = computed(() => {
    const s = this.stats();
    return [
      { lbl: 'In flight', n: s.live, color: 'var(--a500)' },
      { lbl: 'Running', n: s.run, color: 'var(--a500)' },
      { lbl: 'Awaiting approval', n: s.gate, color: 'var(--amber)' },
      { lbl: 'Needs a human', n: s.stalled, color: 'var(--red)' },
    ];
  });

  open(id: number) {
    this.router.navigateByUrl('/admin/requests/' + id + '?view=map');
  }

  /** Map-local key grammar (advertised in the header): / search · J/K move · ↵ open · F filter.
   *  Roving doesn't move DOM focus, so Enter on a tab-focused control defers to the native click. */
  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === '/') {
      e.preventDefault();
      this.searchEl()?.nativeElement.focus();
    } else if (k === 'f') {
      e.preventDefault();
      this.filter.set(this.filter() === 'all' ? 'attention' : 'all');
    } else if (k === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.moveSel(1);
    } else if (k === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.moveSel(-1);
    } else if (e.key === 'Enter' && tag !== 'button' && tag !== 'a') {
      const id = this.focusedId();
      if (id >= 0) {
        e.preventDefault();
        this.open(id);
      }
    }
  }

  private moveSel(d: number) {
    const n = this.flatCards().length;
    if (!n) return;
    this.sel.update((s) => Math.min(n - 1, Math.max(0, s + d)));
    setTimeout(
      () => document.querySelector('.fm-card--focus')?.scrollIntoView({ block: 'nearest' }),
      0,
    );
  }
}
