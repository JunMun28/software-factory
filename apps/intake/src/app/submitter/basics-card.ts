import { Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Api, AppEntry, TrackChip } from '@sf/shared';
import { IntakeDraft } from './intake-draft.service';

/** all basics answered for this request type (identity + the two facts) */
export function basicsAnswered(d: IntakeDraft, type: string | null): boolean {
  // New apps and uncategorised requests take their title from the description.
  const identity =
    type === 'new' || type === 'other' ? true : d.appId !== null || !!d.appName.trim();
  if (type === 'bug') return identity && bugEvidenceAnswered(d) && !!d.bugFreq;
  return (
    identity && (!!d.reach || !!d.reachText.trim()) && !!d.impactMetric && !!d.impactValue.trim()
  );
}

export function bugEvidenceAnswered(d: IntakeDraft): boolean {
  return (
    !!d.bugWhere.trim() ||
    d.attachments().some((a) => a.kind === 'image' || a.mime.startsWith('image/')) ||
    d.pending().some((f) => f.type.startsWith('image/'))
  );
}

/** The Clarify step's BASICS — the "card sort + blast radius" redesign
 *  (mockups/basics-form verdict, 2026-07-11): staged numbered sections with
 *  illustrated type cards, a concentric-rings audience picker, and impact
 *  cards. Later sections sit blurred until the earlier ones are answered.
 *  Edits PATCH the request through the shared IntakeDraft; a dirty check
 *  keeps no-op blurs free. The blast radius collapses the old six reach
 *  options to four rings — legacy site/network values light the outer ring. */
@Component({
  selector: 'sf-basics-card',
  imports: [FormsModule, TrackChip],
  template: `
    <div class="basics">
      <!-- S1 · TYPE (chip-collapsed; cards open when unsure or correcting) -->
      <section class="sec answered">
        <div class="sechead">
          <span class="snum"></span>
          <div class="htxt">
            <h2>What kind of request is this?</h2>
            <p class="sub">We inferred this from your description — change it if it's off.</p>
          </div>
          <sf-track-chip
            [t]="draft.type ?? rtype() ?? 'new'"
            [state]="cardsOpen() ? 'unsure' : 'confident'"
            (correct)="cardsOpen.set(!cardsOpen())"
          />
        </div>
        @if (cardsOpen()) {
          <div class="typegrid">
            <button
              type="button"
              class="tcard"
              [class.sel]="picked() === 'bug'"
              (click)="pickType('bug')"
            >
              <span class="glow"></span>
              <span class="art">
                <svg
                  viewBox="0 0 48 48"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path
                    d="M30 12a7 7 0 0 0-9.4 8.3L9 31.9a3.4 3.4 0 0 0 4.8 4.8l11.6-11.6A7 7 0 0 0 34 15.6l-4 4-4.3-1.4L24.3 14z"
                  />
                  <circle cx="12.2" cy="33.6" r="1" />
                </svg>
              </span>
              <span class="tl">Fix a problem</span>
              <span class="ex">Something's broken, slow, or wrong and needs a fix.</span>
              <span class="tick">✓</span>
            </button>
            <button
              type="button"
              class="tcard"
              [class.sel]="picked() === 'enh'"
              (click)="pickType('enh')"
            >
              <span class="glow"></span>
              <span class="art">
                <svg
                  viewBox="0 0 48 48"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="8" y="10" width="32" height="22" rx="3" />
                  <path d="M8 16h32" />
                  <path d="M18 40h12M24 32v8" />
                  <path d="M20 25l4-5 4 3 4-6" />
                </svg>
              </span>
              <span class="tl">Improve an app</span>
              <span class="ex">An app already exists but should do more or better.</span>
              <span class="tick">✓</span>
            </button>
            <button
              type="button"
              class="tcard"
              [class.sel]="picked() === 'new'"
              (click)="pickType('new')"
            >
              <span class="glow"></span>
              <span class="art">
                <svg
                  viewBox="0 0 48 48"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M24 7l14 8v18l-14 8-14-8V15z" />
                  <path d="M10 15l14 8 14-8M24 23v18" />
                  <path d="M24 16v6M21 19h6" stroke-width="2.2" />
                </svg>
              </span>
              <span class="tl">Build a new app</span>
              <span class="ex">Nothing exists yet. Start from a blank page.</span>
              <span class="tick">✓</span>
            </button>
            <button
              type="button"
              class="tcard"
              [class.sel]="picked() === 'other'"
              (click)="pickType('other')"
            >
              <span class="glow"></span>
              <span class="art">
                <svg
                  viewBox="0 0 48 48"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 14a10 10 0 0 1 20 0c0 5-4 6-6 8s-2 4-2 4" />
                  <circle cx="24" cy="39" r="1.4" />
                </svg>
              </span>
              <span class="tl">Something else</span>
              <span class="ex">Not sure yet. We'll figure it out together.</span>
              <span class="tick">✓</span>
            </button>
          </div>
        }
      </section>

      <!-- S2 · APP (bug / enh only) -->
      @if (rtype() === 'bug' || rtype() === 'enh') {
        <section class="sec" [class.answered]="appAnswered()">
          <div class="sechead">
            <span class="snum"><i>2</i></span>
            <div class="htxt">
              <h2>Which app is this about?</h2>
              <p class="sub">{{ appPlaceholder() }}</p>
            </div>
            @if (appAnswered()) {
              <span class="tag">{{ draft.appName || 'Selected' }}</span>
            }
          </div>
          <div class="panel">
            <span class="dd-wrap">
              <input
                id="nr-app-dd"
                class="input basics__in"
                role="combobox"
                autocomplete="off"
                aria-autocomplete="list"
                aria-controls="nr-app-list"
                [attr.aria-expanded]="appsMenuOpen() && !customApp()"
                maxlength="120"
                [placeholder]="customApp() ? 'Type the app name' : appPlaceholder()"
                [ngModel]="appQuery()"
                (ngModelChange)="customApp() ? onCustomInput($event) : onAppInput($event)"
                (focus)="!customApp() && appsMenuOpen.set(true)"
                (blur)="appsMenuOpen.set(false); save()"
                (keydown.escape)="appsMenuOpen.set(false)"
              />
              @if (appsMenuOpen() && !customApp()) {
                <div class="pop pop--fill" role="listbox" id="nr-app-list">
                  @for (a of filteredApps(); track a.id) {
                    <button
                      class="pop__opt"
                      role="option"
                      [attr.aria-selected]="draft.appId === a.id"
                      [class.on]="draft.appId === a.id"
                      (mousedown)="$event.preventDefault(); pickApp(a)"
                    >
                      {{ a.name }}
                    </button>
                  } @empty {
                    @if (!appQuery().trim()) {
                      <div class="dd__empty">No apps registered yet.</div>
                    }
                  }
                  <button
                    class="pop__opt dd__other"
                    (mousedown)="$event.preventDefault(); chooseOther()"
                  >
                    @if (appQuery().trim() && !exactApp()) {
                      Add “{{ appQuery().trim() }}” as a new app
                    } @else {
                      My app isn’t listed
                    }
                  </button>
                </div>
              }
            </span>
          </div>
        </section>
      }

      @if (rtype() === 'bug') {
        <!-- S3 · EVIDENCE -->
        <section
          class="sec"
          [class.locked]="!appAnswered()"
          [class.answered]="bugEvidenceAnswered()"
        >
          <div class="sechead">
            <span class="snum"><i>3</i></span>
            <div class="htxt">
              <h2>Show us where it happens</h2>
              <p class="sub">A link or a screenshot — either works.</p>
            </div>
            @if (bugEvidenceAnswered()) {
              <span class="tag">{{
                screenshots().length ? 'Screenshot added' : 'Link added'
              }}</span>
            }
          </div>
          <div class="panel">
            <span class="evidence" (paste)="onEvidencePaste($event)">
              <input
                class="input basics__in evidence__link"
                inputmode="url"
                autocomplete="url"
                placeholder="Paste a page link"
                [(ngModel)]="draft.bugWhere"
                (blur)="save()"
              />
              <button type="button" class="evidence__add" (click)="screenshotInput.click()">
                Add screenshot
              </button>
              <input
                #screenshotInput
                type="file"
                accept="image/*"
                hidden
                (change)="onScreenshotPick($event)"
              />
              @if (screenshots().length) {
                <span class="evidence__files">
                  @for (shot of screenshots(); track shot.id) {
                    <span class="evidence__file">
                      {{ shot.filename }}
                      <button
                        type="button"
                        aria-label="Remove {{ shot.filename }}"
                        (click)="removeScreenshot(shot.id)"
                      >
                        ×
                      </button>
                    </span>
                  }
                </span>
              }
              @if (draft.lastError()) {
                <span class="evidence__error" role="alert">{{ draft.lastError() }}</span>
              }
            </span>
          </div>
        </section>

        <!-- S4 · FREQUENCY -->
        <section
          class="sec"
          [class.locked]="!appAnswered() || !bugEvidenceAnswered()"
          [class.answered]="!!draft.bugFreq"
        >
          <div class="sechead">
            <span class="snum"><i>4</i></span>
            <div class="htxt">
              <h2>How often does it happen?</h2>
              <p class="sub">Roughly how often it shows up.</p>
            </div>
            @if (draft.bugFreq) {
              <span class="tag">{{ freqLabel() }}</span>
            }
          </div>
          <div class="freqgrid">
            @for (f of freqs; track f[0]) {
              <button
                type="button"
                class="fcard"
                [class.sel]="draft.bugFreq === f[0]"
                (click)="pickFreq(f[0])"
              >
                {{ f[1] }}
              </button>
            }
          </div>
        </section>
      } @else {
        <!-- S2/S3 · AUDIENCE (blast radius) -->
        <section
          class="sec"
          [class.locked]="rtype() === 'enh' && !appAnswered()"
          [class.answered]="audAnswered()"
        >
          <div class="sechead">
            <span class="snum"
              ><i>{{ rtype() === 'enh' ? 3 : 2 }}</i></span
            >
            <div class="htxt">
              <h2>{{ audienceLabel() }}</h2>
              <p class="sub">Click the ring that matches the blast radius.</p>
            </div>
            @if (audAnswered()) {
              <span class="tag">{{ audTag() }}</span>
            }
          </div>
          <div class="radius">
            <div class="ringwrap">
              <svg
                viewBox="0 0 400 400"
                role="group"
                aria-label="How many people this touches"
                aria-hidden="true"
              >
                <!-- painted largest→smallest so inner disks form annulus hit-zones -->
                <circle
                  class="ring-band"
                  [class.reach]="selIdx() >= 3"
                  [class.edge]="selIdx() === 3"
                  cx="200"
                  cy="200"
                  r="190"
                  (click)="pickRing('wider')"
                />
                <circle
                  class="ring-band"
                  [class.reach]="selIdx() >= 2"
                  [class.edge]="selIdx() === 2"
                  cx="200"
                  cy="200"
                  r="142"
                  (click)="pickRing('dept')"
                />
                <circle
                  class="ring-band"
                  [class.reach]="selIdx() >= 1"
                  [class.edge]="selIdx() === 1"
                  cx="200"
                  cy="200"
                  r="92"
                  (click)="pickRing('team')"
                />
                <circle
                  class="ring-band"
                  [class.reach]="selIdx() >= 0"
                  [class.edge]="selIdx() === 0"
                  cx="200"
                  cy="200"
                  r="46"
                  (click)="pickRing('me')"
                />
                <g pointer-events="none">
                  <circle
                    class="dot-people"
                    [class.lit]="selIdx() >= 1"
                    cx="200"
                    cy="128"
                    r="4.5"
                  />
                  <circle
                    class="dot-people"
                    [class.lit]="selIdx() >= 1"
                    cx="255"
                    cy="230"
                    r="4.5"
                  />
                  <circle
                    class="dot-people"
                    [class.lit]="selIdx() >= 1"
                    cx="150"
                    cy="245"
                    r="4.5"
                  />
                  <circle class="dot-people" [class.lit]="selIdx() >= 2" cx="200" cy="90" r="4.5" />
                  <circle
                    class="dot-people"
                    [class.lit]="selIdx() >= 2"
                    cx="300"
                    cy="170"
                    r="4.5"
                  />
                  <circle
                    class="dot-people"
                    [class.lit]="selIdx() >= 2"
                    cx="285"
                    cy="270"
                    r="4.5"
                  />
                  <circle
                    class="dot-people"
                    [class.lit]="selIdx() >= 2"
                    cx="120"
                    cy="285"
                    r="4.5"
                  />
                  <circle
                    class="dot-people"
                    [class.lit]="selIdx() >= 2"
                    cx="102"
                    cy="150"
                    r="4.5"
                  />
                  <circle class="dot-people" [class.lit]="selIdx() >= 3" cx="200" cy="48" r="4.5" />
                  <circle
                    class="dot-people"
                    [class.lit]="selIdx() >= 3"
                    cx="335"
                    cy="120"
                    r="4.5"
                  />
                  <circle
                    class="dot-people"
                    [class.lit]="selIdx() >= 3"
                    cx="360"
                    cy="235"
                    r="4.5"
                  />
                  <circle
                    class="dot-people"
                    [class.lit]="selIdx() >= 3"
                    cx="290"
                    cy="330"
                    r="4.5"
                  />
                  <circle
                    class="dot-people"
                    [class.lit]="selIdx() >= 3"
                    cx="160"
                    cy="352"
                    r="4.5"
                  />
                  <circle class="dot-people" [class.lit]="selIdx() >= 3" cx="62" cy="290" r="4.5" />
                  <circle class="dot-people" [class.lit]="selIdx() >= 3" cx="45" cy="165" r="4.5" />
                  <circle class="dot-people" [class.lit]="selIdx() >= 3" cx="88" cy="70" r="4.5" />
                </g>
                <g pointer-events="none">
                  <circle class="you-body" [class.lit]="selIdx() >= 0" cx="200" cy="188" r="9" />
                  <path
                    class="you-body"
                    [class.lit]="selIdx() >= 0"
                    d="M184 216c0-9 7-15 16-15s16 6 16 15z"
                  />
                </g>
              </svg>
            </div>
            <div class="aud-side">
              <div class="readout" aria-live="polite">
                <div class="count">
                  {{ aud()?.count ?? '—' }}
                  @if (aud(); as a) {
                    <span class="u">{{ a.unit }}</span>
                  }
                </div>
                <div class="scope">{{ audScope() }}</div>
                <div class="hint">{{ audHint() }}</div>
              </div>
              <div class="legend" role="group" [attr.aria-label]="audienceLabel()">
                @for (rc of reaches; track rc.v) {
                  <button type="button" [class.on]="legendOn(rc.v)" (click)="pickRing(rc.v)">
                    <span class="sw"></span><b>{{ rc.label }}</b
                    ><small>{{ rc.count }}</small>
                  </button>
                }
              </div>
              <input
                class="input basics__in aud-free"
                placeholder="Or describe the group"
                [ngModel]="draft.reachText"
                (ngModelChange)="onReachInput($event)"
                (blur)="save()"
              />
            </div>
          </div>
        </section>

        <!-- S3/S4 · IMPACT -->
        <section
          class="sec"
          [class.locked]="!audAnswered() || (rtype() === 'enh' && !appAnswered())"
          [class.answered]="impAnswered()"
        >
          <div class="sechead">
            <span class="snum"
              ><i>{{ rtype() === 'enh' ? 4 : 3 }}</i></span
            >
            <div class="htxt">
              <h2>{{ benefitLabel() }}</h2>
              <p class="sub">The main payoff — roughly.</p>
            </div>
            @if (impAnswered()) {
              <span class="tag">{{ impTag() }}</span>
            }
          </div>
          <div class="impgrid">
            <button
              type="button"
              class="icard"
              [class.sel]="draft.impactMetric === 'hours'"
              (click)="pickMetric('hours')"
            >
              <span class="glow"></span>
              <span class="art">
                <svg
                  viewBox="0 0 48 48"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="24" cy="26" r="15" />
                  <path d="M24 26V17M24 26l6 4" />
                  <path d="M18 6h12M24 6v5" />
                </svg>
              </span>
              <span class="tl">Saves time</span>
              <span class="ex">Kills a recurring time-sink.</span>
            </button>
            <button
              type="button"
              class="icard"
              [class.sel]="draft.impactMetric === 'cost'"
              (click)="pickMetric('cost')"
            >
              <span class="glow"></span>
              <span class="art">
                <svg
                  viewBox="0 0 48 48"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <ellipse cx="24" cy="14" rx="14" ry="5" />
                  <path d="M10 14v9c0 2.8 6.3 5 14 5s14-2.2 14-5v-9" />
                  <path d="M10 23v9c0 2.8 6.3 5 14 5s14-2.2 14-5v-9" />
                </svg>
              </span>
              <span class="tl">Saves money</span>
              <span class="ex">Cuts cost or unlocks revenue.</span>
            </button>
            <button
              type="button"
              class="icard"
              [class.sel]="draft.impactMetric === 'other'"
              (click)="pickMetric('other')"
            >
              <span class="glow"></span>
              <span class="art">
                <svg
                  viewBox="0 0 48 48"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="19" cy="20" r="9" />
                  <path d="M25.5 26.5L38 39M31 33l-4 4M35 29l-4 4" />
                </svg>
              </span>
              <span class="tl">Unlocks something</span>
              <span class="ex">Makes possible what wasn't before.</span>
            </button>
          </div>
          @if (draft.impactMetric) {
            <div class="imp-est">
              <label for="imp-est-in">{{ estQuestion() }}</label>
              <input
                id="imp-est-in"
                class="input basics__in"
                [placeholder]="metricPlaceholder()"
                [ngModel]="draft.impactValue"
                (ngModelChange)="onImpactInput($event)"
                (blur)="save()"
              />
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: `
    .basics {
      display: flex;
      flex-direction: column;
      gap: 30px;
    }

    /* ---- sections / staging ---- */
    .sec {
      transition:
        filter 0.5s var(--ease),
        opacity 0.5s var(--ease),
        transform 0.5s var(--ease);
    }
    .sec.locked {
      filter: blur(6px) saturate(0.5);
      opacity: 0.5;
      pointer-events: none;
      transform: scale(0.99);
      user-select: none;
    }
    .sechead {
      display: flex;
      align-items: center;
      gap: 13px;
      margin-bottom: 14px;
    }
    .snum {
      width: 28px;
      height: 28px;
      flex: none;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--mono);
      font-size: 12.5px;
      color: var(--muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      transition:
        background 0.3s,
        color 0.3s,
        border-color 0.3s;
    }
    .sec.answered .snum {
      background: var(--green-bg);
      border-color: var(--green-line);
      color: var(--green);
    }
    .sec.answered .snum::after {
      content: '✓';
      font-weight: 700;
    }
    .sec.answered .snum i {
      display: none;
    }
    .snum i {
      font-style: normal;
    }
    .sechead h2 {
      font-size: 17px;
      font-weight: 650;
      letter-spacing: -0.015em;
      margin: 0;
      color: var(--fg1);
    }
    .sechead .sub {
      font-size: 12.5px;
      color: var(--muted);
      margin: 1px 0 0;
    }
    .htxt {
      flex: 1;
      min-width: 0;
    }
    .tag {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--accent-tx);
      background: var(--accent-tint);
      border: 1px solid var(--accent-tint-bd);
      padding: 4px 10px;
      border-radius: 999px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
    }

    /* ---- type cards ---- */
    .typegrid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }
    .tcard {
      position: relative;
      text-align: left;
      cursor: pointer;
      font-family: inherit;
      border: 1.5px solid var(--border);
      border-radius: 14px;
      background: var(--surface);
      color: inherit;
      padding: 18px 18px 16px;
      overflow: hidden;
      transition:
        border-color 0.2s,
        background 0.2s,
        transform 0.18s,
        box-shadow 0.2s;
    }
    .tcard:hover {
      transform: translateY(-3px);
      box-shadow: var(--shadow-pop);
      border-color: var(--border-strong);
    }
    .tcard:active {
      transform: translateY(-1px);
    }
    .tcard .art {
      display: block;
      width: 46px;
      height: 46px;
      margin-bottom: 10px;
      color: var(--faint);
      transition: color 0.2s;
    }
    .tcard .art svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .tcard .tl {
      display: block;
      font-size: 15px;
      font-weight: 600;
      color: var(--fg1);
      letter-spacing: -0.01em;
    }
    .tcard .ex {
      display: block;
      margin-top: 3px;
      font-size: 12.5px;
      color: var(--muted);
      line-height: 1.45;
    }
    .tcard .tick {
      position: absolute;
      top: 13px;
      right: 13px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 1.5px solid var(--border-strong);
      display: flex;
      align-items: center;
      justify-content: center;
      color: transparent;
      font-size: 12px;
      transition: all 0.2s;
    }
    .tcard.sel {
      border-color: var(--accent);
      background: var(--accent-tint);
      box-shadow: 0 0 0 1px var(--accent) inset;
    }
    .tcard.sel .art {
      color: var(--accent-tx);
    }
    .tcard.sel .tick {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .tcard .glow {
      position: absolute;
      inset: 0;
      background: radial-gradient(120% 80% at 15% 0%, var(--accent-tint), transparent 60%);
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
    }
    .tcard.sel .glow {
      opacity: 1;
    }

    /* ---- app / evidence panels ---- */
    .panel {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--surface);
      padding: 16px;
    }

    /* ---- blast radius ---- */
    .radius {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 240px;
      gap: 24px;
      align-items: center;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--surface);
      padding: 22px;
    }
    .ringwrap {
      position: relative;
      width: 100%;
      max-width: 340px;
      margin: 0 auto;
      aspect-ratio: 1;
    }
    .ringwrap svg {
      width: 100%;
      height: 100%;
      display: block;
      overflow: visible;
    }
    .ring-band {
      cursor: pointer;
      fill: var(--surface-2);
      stroke: var(--border-strong);
      stroke-width: 1.5;
      opacity: 0.55;
      transition:
        fill 0.3s,
        stroke 0.3s,
        opacity 0.3s;
    }
    .ring-band.reach {
      fill: var(--accent-tint);
      stroke: var(--accent-tint-bd);
      opacity: 1;
    }
    .ring-band.edge {
      stroke: var(--accent);
      stroke-width: 2.5;
    }
    .ringwrap:hover .ring-band {
      opacity: 0.75;
    }
    .ringwrap:hover .ring-band.reach {
      opacity: 1;
    }
    .dot-people {
      fill: var(--faint);
      transition: fill 0.3s;
    }
    .dot-people.lit {
      fill: var(--accent-tx);
    }
    .you-body {
      fill: var(--muted);
      transition: fill 0.3s;
    }
    .you-body.lit {
      fill: var(--accent-tx);
    }
    .aud-side {
      min-width: 0;
    }
    .readout .count {
      font-size: 30px;
      font-weight: 650;
      color: var(--fg1);
      letter-spacing: -0.02em;
      line-height: 1.1;
    }
    .readout .count .u {
      font-size: 15px;
      color: var(--muted);
      font-weight: 500;
    }
    .readout .scope {
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--accent-tx);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-top: 2px;
    }
    .readout .hint {
      font-size: 12.5px;
      color: var(--muted);
      margin-top: 7px;
      line-height: 1.45;
      min-height: 36px;
    }
    .legend {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .legend button {
      display: flex;
      align-items: center;
      gap: 9px;
      cursor: pointer;
      padding: 6px 9px;
      border-radius: 8px;
      border: 1px solid transparent;
      background: none;
      font-family: inherit;
      font-size: 13px;
      color: var(--muted);
      text-align: left;
      transition:
        background 0.16s,
        color 0.16s,
        border-color 0.16s;
    }
    .legend button:hover {
      background: var(--surface-2);
    }
    .legend .sw {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      flex: none;
      background: var(--border-strong);
    }
    .legend b {
      color: var(--fg2);
      font-weight: 500;
    }
    .legend small {
      color: var(--muted);
      margin-left: auto;
      font-family: var(--mono);
      font-size: 10.5px;
    }
    .legend button.on {
      background: var(--accent-tint);
      border-color: var(--accent-tint-bd);
    }
    .legend button.on .sw {
      background: var(--accent);
    }
    .legend button.on b {
      color: var(--fg1);
    }
    .legend button.on small {
      color: var(--accent-tx);
    }
    .aud-free {
      margin-top: 10px;
      width: 100%;
    }

    /* ---- impact cards ---- */
    .impgrid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }
    .icard {
      position: relative;
      cursor: pointer;
      text-align: center;
      font-family: inherit;
      border: 1.5px solid var(--border);
      border-radius: 14px;
      background: var(--surface);
      color: inherit;
      padding: 20px 14px 18px;
      overflow: hidden;
      transition:
        border-color 0.2s,
        background 0.2s,
        transform 0.18s,
        box-shadow 0.2s;
    }
    .icard:hover {
      transform: translateY(-3px);
      box-shadow: var(--shadow-pop);
      border-color: var(--border-strong);
    }
    .icard .art {
      display: block;
      width: 42px;
      height: 42px;
      margin: 0 auto 10px;
      color: var(--faint);
      transition: color 0.2s;
    }
    .icard .art svg {
      width: 100%;
      height: 100%;
    }
    .icard .tl {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: var(--fg1);
    }
    .icard .ex {
      display: block;
      margin-top: 4px;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.45;
    }
    .icard.sel {
      border-color: var(--accent);
      background: var(--accent-tint);
      box-shadow: 0 0 0 1px var(--accent) inset;
    }
    .icard.sel .art {
      color: var(--accent-tx);
    }
    .icard .glow {
      position: absolute;
      inset: 0;
      background: radial-gradient(100% 70% at 50% 0%, var(--accent-tint), transparent 65%);
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
    }
    .icard.sel .glow {
      opacity: 1;
    }
    .imp-est {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--surface);
      padding: 12px 16px;
    }
    .imp-est label {
      font-size: 13px;
      font-weight: 500;
      color: var(--fg2);
      flex: none;
    }
    .imp-est input {
      flex: 1;
      min-width: 0;
    }

    /* ---- frequency ---- */
    .freqgrid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
    }
    .fcard {
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      color: var(--fg2);
      border: 1.5px solid var(--border);
      border-radius: 12px;
      background: var(--surface);
      padding: 13px 10px;
      cursor: pointer;
      transition:
        border-color 0.2s,
        background 0.2s,
        color 0.2s,
        transform 0.18s;
    }
    .fcard:hover {
      transform: translateY(-2px);
      border-color: var(--border-strong);
    }
    .fcard.sel {
      border-color: var(--accent);
      background: var(--accent-tint);
      color: var(--accent-tx);
      box-shadow: 0 0 0 1px var(--accent) inset;
    }

    /* ---- shared bits carried over ---- */
    .evidence {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .evidence__link {
      flex: 1 1 220px;
      min-width: 160px;
    }
    .evidence__add {
      min-height: 34px;
      padding: 6px 12px;
      border: 1px solid var(--border-strong);
      border-radius: var(--r);
      background: var(--surface);
      color: var(--fg2);
      font: 500 12.5px var(--body);
      cursor: pointer;
    }
    .evidence__add:hover {
      border-color: var(--accent-tint-bd);
      color: var(--accent-tx);
    }
    .evidence__files {
      display: flex;
      flex: 1 0 100%;
      flex-wrap: wrap;
      gap: 4px;
    }
    .evidence__file {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      padding: 3px 8px;
      border-radius: 999px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 11.5px;
    }
    .evidence__file button {
      border: 0;
      padding: 0;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }
    .evidence__error {
      flex: 1 0 100%;
      color: var(--red);
      font-size: 11.5px;
    }
    .basics__in {
      min-height: 34px;
      padding: 6px 11px;
      font-size: 13px;
    }
    .dd-wrap {
      position: relative;
      display: block;
      min-width: 0;
    }
    .dd-wrap .basics__in {
      width: 100%;
    }
    .dd__other {
      color: var(--accent-tx);
      font-weight: 500;
    }
    .dd__empty {
      padding: 12px;
      font-size: 13px;
      color: var(--muted);
    }

    /* ---- responsive ---- */
    @media (max-width: 760px) {
      .radius {
        grid-template-columns: 1fr;
        gap: 18px;
        padding: 18px;
      }
      .impgrid {
        grid-template-columns: 1fr;
        gap: 10px;
      }
      .icard {
        display: flex;
        align-items: center;
        text-align: left;
        gap: 14px;
        padding: 14px 16px;
      }
      .icard .art {
        margin: 0;
        width: 38px;
        height: 38px;
        flex: none;
      }
      .icard .tl,
      .icard .ex {
        display: block;
      }
      .freqgrid {
        grid-template-columns: repeat(2, 1fr);
      }
      .imp-est {
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
      }
    }
    @media (max-width: 460px) {
      .typegrid {
        grid-template-columns: 1fr;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .sec,
      .tcard,
      .icard,
      .fcard {
        transition: none;
      }
    }
  `,
})
export class BasicsCard implements OnInit {
  /** the request these basics belong to */
  id = input.required<number>();
  /** current request type — re-shapes the sections (kept fresh by the parent) */
  rtype = input<string | null>(null);
  /** the Type section changed the request type (already PATCHed) */
  typeChanged = output<string>();
  /** any basics edit was PATCHed — parents refresh what depends on the spec */
  saved = output<void>();

  draft = inject(IntakeDraft);
  private api = inject(Api);

  freqs: [string, string][] = [
    ['Every time', 'Every time'],
    ['Most of the time', 'Usually'],
    ['Sometimes', 'Sometimes'],
    ['Only once so far', 'It happened once'],
  ];
  /** the four blast-radius bands, inner → outer; 'wider' absorbs legacy site/network */
  reaches = [
    { v: 'me', label: 'Just me', count: '1' },
    { v: 'team', label: 'My team', count: '2–10' },
    { v: 'dept', label: 'A department', count: '10–50' },
    { v: 'wider', label: 'The whole site', count: '50+' },
  ];
  private AUD: Record<string, { scope: string; count: string; unit: string; hint: string }> = {
    me: {
      scope: 'Just me',
      count: '~1',
      unit: 'person',
      hint: 'A personal tool. Quick to review, quick to ship.',
    },
    team: {
      scope: 'My team',
      count: '2–10',
      unit: 'people',
      hint: 'Your immediate team feels it. Light review, fast turnaround.',
    },
    dept: {
      scope: 'A department',
      count: '10–50',
      unit: 'people',
      hint: 'A whole function relies on it, so expect a closer review.',
    },
    wider: {
      scope: 'Whole org',
      count: '50+',
      unit: 'people',
      hint: 'Company-wide reach. Highest scrutiny, most careful rollout.',
    },
  };

  /** the type cards are shown when the guess is unsure or the submitter opens them to correct */
  cardsOpen = signal(false);
  /** which card the submitter has explicitly clicked — starts empty so NO card is pre-selected
   *  (the inferred type lives in the chip; the grid is for an active choice, not a default nudge) */
  picked = signal<string | null>(null);

  apps = signal<AppEntry[]>([]);
  appsMenuOpen = signal(false);
  appQuery = signal('');
  customApp = signal(false); // "Other" was chosen — the input is a free-text app name
  screenshots = computed(() => this.draft.attachments().filter((a) => a.kind === 'image'));
  filteredApps = computed(() => {
    const q = this.appQuery().trim().toLowerCase();
    const list = this.apps();
    return q ? list.filter((a) => a.name.toLowerCase().includes(q)) : list;
  });
  exactApp = computed(() => {
    const q = this.appQuery().trim().toLowerCase();
    return q ? (this.apps().find((a) => a.name.toLowerCase() === q) ?? null) : null;
  });

  /** recompute answered-states when a non-signal draft field changes */
  private rev = signal(0);

  /** last-saved snapshot — save() is a no-op unless something changed */
  private savedSnapshot = '';
  private snapshot(): string {
    const d = this.draft;
    return JSON.stringify([
      d.type,
      d.newName,
      d.appId,
      d.appName,
      d.bugWhere,
      d.bugFreq,
      d.reach,
      d.reachText,
      d.impactMetric,
      d.impactValue,
    ]);
  }

  ngOnInit() {
    this.api.apps().subscribe((a) => this.apps.set(a.filter((x) => !x.muted)));
    this.seedFromDraft();
    this.cardsOpen.set(this.draft.typeConfidence < 0.5);
    // hydration may still be in flight when the card mounts (two parallel GETs) —
    // one late reseed covers the deep-link/reload race
    setTimeout(() => {
      if (!this.appQuery() && this.draft.appName) this.seedFromDraft();
      this.savedSnapshot = this.snapshot();
      this.rev.update((n) => n + 1);
    }, 500);
    this.savedSnapshot = this.snapshot();
  }
  private seedFromDraft() {
    this.appQuery.set(this.draft.appName);
    this.customApp.set(!!this.draft.appName && this.draft.appId === null);
  }

  /* ---- answered states (drive staging + section checks) ---- */
  appAnswered() {
    return this.draft.appId !== null || !!this.draft.appName.trim();
  }
  audAnswered() {
    return !!this.draft.reach || !!this.draft.reachText.trim();
  }
  impAnswered() {
    return !!this.draft.impactMetric && !!this.draft.impactValue.trim();
  }
  bugEvidenceAnswered() {
    return bugEvidenceAnswered(this.draft);
  }

  /* ---- copy ---- */
  appPlaceholder() {
    return this.rtype() === 'bug'
      ? 'Search for the app with the problem'
      : 'Search for the app to improve';
  }
  audienceLabel() {
    return {
      enh: 'Who benefits?',
      new: 'Who is this for?',
      other: 'Who is this for?',
    }[this.rtype() ?? 'new'];
  }
  benefitLabel() {
    const t = this.rtype() ?? 'new';
    if (t === 'other') return 'What would a good outcome be?';
    if (t === 'new') return 'What is the business value?';
    return 'What would winning look like?';
  }
  freqLabel() {
    return this.freqs.find((f) => f[0] === this.draft.bugFreq)?.[1] ?? '';
  }
  estQuestion() {
    if (!this.draft.impactMetric) return '';
    return {
      hours: 'Roughly how many hours a year?',
      cost: 'Roughly how much a year, in $k?',
      other: 'Describe the payoff in a line.',
    }[this.draft.impactMetric];
  }
  metricPlaceholder() {
    if (!this.draft.impactMetric) return 'Enter estimate';
    return { hours: 'Estimated hours', cost: 'Estimated $k', other: 'Describe the benefit' }[
      this.draft.impactMetric
    ];
  }

  /* ---- blast radius ---- */
  /** selected band index (0 me … 3 whole-org); legacy site/network read as the
   *  outer band; -1 when nothing (or a custom group) is picked */
  selIdx() {
    if (this.draft.reachText.trim() || !this.draft.reach) return -1;
    const i = ['me', 'team', 'dept'].indexOf(this.draft.reach);
    return i === -1 ? 3 : i;
  }
  legendOn(v: string) {
    if (this.draft.reachText.trim() || !this.draft.reach) return false;
    if (v === 'wider') return ['wider', 'site', 'network'].includes(this.draft.reach);
    return this.draft.reach === v;
  }
  aud() {
    const i = this.selIdx();
    if (i < 0) return null;
    return this.AUD[['me', 'team', 'dept', 'wider'][i]];
  }
  audScope() {
    if (this.draft.reachText.trim()) return 'Your own group';
    return this.aud()?.scope ?? 'pick a ring';
  }
  audHint() {
    if (this.draft.reachText.trim()) return this.draft.reachText.trim();
    return (
      this.aud()?.hint ??
      'The wider the ring, the more people this touches, and the more eyes review it.'
    );
  }
  audTag() {
    if (this.draft.reachText.trim()) return this.draft.reachText.trim();
    const i = this.selIdx();
    if (i < 0) return '';
    return `${this.reaches[i].label} · ${this.reaches[i].count}`;
  }
  pickRing(v: string) {
    this.pickReach(v);
  }
  impTag() {
    const label = { hours: 'Saves time', cost: 'Saves money', other: 'Unlocks something' }[
      this.draft.impactMetric ?? 'other'
    ];
    return `${label} · ${this.draft.impactValue.trim()}`;
  }

  /** list mode: the text is a filter; only an exact match selects a known app. */
  onAppInput(text: string) {
    this.appQuery.set(text);
    const ex = this.exactApp();
    this.draft.appId = ex ? ex.id : null;
    this.draft.appName = ex ? ex.name : '';
    this.appsMenuOpen.set(true);
  }
  /** custom mode: the text IS the new app name. */
  onCustomInput(text: string) {
    this.appQuery.set(text);
    this.draft.appName = text;
    this.draft.appId = null;
  }
  pickApp(a: AppEntry) {
    this.customApp.set(false);
    this.draft.appId = a.id;
    this.draft.appName = a.name;
    this.appQuery.set(a.name);
    this.appsMenuOpen.set(false);
    this.save();
  }
  /** "Other" — switch to free-text entry, carrying over anything already typed. */
  chooseOther() {
    this.customApp.set(true);
    this.draft.appId = null;
    this.draft.appName = this.appQuery().trim();
    this.appsMenuOpen.set(false);
  }

  pickType(t: string) {
    this.picked.set(t); // reflect the explicit choice (the grid starts with none selected)
    if (this.draft.type === t) {
      this.cardsOpen.set(false);
      return;
    }
    this.draft.type = t as never;
    this.draft.typeConfidence = 1; // an explicit choice is certain
    this.cardsOpen.set(false);
    void this.save(true).then((didSave) => {
      if (didSave) this.typeChanged.emit(t);
    });
  }
  pickReach(r: string) {
    this.draft.reach = this.draft.reach === r && !this.draft.reachText ? null : (r as never);
    this.draft.reachText = '';
    this.save();
  }
  onReachInput(text: string) {
    this.draft.reachText = text;
    this.draft.reach = null;
    this.rev.update((n) => n + 1);
  }
  pickMetric(m: string) {
    this.draft.impactMetric = this.draft.impactMetric === m ? null : (m as never);
    this.rev.update((n) => n + 1);
    if (this.draft.impactMetric === null || this.draft.impactValue.trim()) this.save();
  }
  onImpactInput(text: string) {
    this.draft.impactValue = text;
    this.rev.update((n) => n + 1);
  }
  async onScreenshotPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    await this.uploadScreenshots(files);
  }
  async onEvidencePaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    await this.uploadScreenshots(files);
  }
  private async uploadScreenshots(files: File[]) {
    const images = files.filter(
      (file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name),
    );
    if (!images.length) {
      this.draft.lastError.set('Choose an image file for the screenshot.');
      return;
    }
    await this.draft.addFiles(images, 'interview');
    this.rev.update((n) => n + 1);
    await this.save(true);
  }
  async removeScreenshot(id: number) {
    await this.draft.removeAttachment(id);
    this.rev.update((n) => n + 1);
    await this.save(true);
  }
  pickFreq(f: string) {
    this.draft.bugFreq = this.draft.bugFreq === f ? '' : f;
    this.save();
  }

  /** PATCH the basics onto the request; skips clean saves and un-hydrated drafts */
  async save(force = false): Promise<boolean> {
    this.rev.update((n) => n + 1);
    if (!this.draft.type || this.draft.requestId !== this.id()) return false;
    const snap = this.snapshot();
    if (!force && snap === this.savedSnapshot) return false;
    await this.draft.save();
    this.savedSnapshot = snap;
    this.saved.emit();
    return true;
  }
}
