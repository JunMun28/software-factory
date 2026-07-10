import { Component, DestroyRef, computed, inject, input, OnInit, signal } from '@angular/core';

import { Api, ReviewSummary } from '@sf/shared';

/** The Clarify step's live PLAN: a structured summary ({overview, sections})
 *  that rewrites itself as answers land. Owns its own GET /summary polling;
 *  the parent calls refresh() after anything that changes the spec. */
@Component({
  selector: 'sf-plan-panel',
  template: `
    <aside class="plan" aria-label="Plan">
      <div class="plan__head">
        <span class="plan__t"><span class="plan__beam"></span>Plan</span>
        <span class="plan__status">
          @if (thinking()) {
            <span class="plan__pulse"></span>UPDATING
          } @else {
            AFTER {{ answers() }} ANSWER{{ answers() === 1 ? '' : 'S' }}
          }
        </span>
      </div>
      <div class="plan__body scroll" data-lenis-prevent>
        @if (plan(); as p) {
          @if (p.overview) {
            <p class="plan__ov">{{ p.overview }}</p>
          }
          @for (sec of p.sections; track sec.title) {
            <div class="psec">
              <div class="psec__t">{{ sec.title }}</div>
              <ul>
                @for (it of sec.items; track it) {
                  <li>{{ it }}</li>
                }
              </ul>
            </div>
          }
        }
        @if (thinking()) {
          <div class="psec">
            <div class="plan__sh" style="width: 82%"></div>
            <div class="plan__sh" style="width: 64%"></div>
            <div class="plan__sh" style="width: 71%"></div>
          </div>
        } @else if (!plan()?.overview) {
          <p class="plan__empty">The plan takes shape here as you answer.</p>
        }
      </div>
      <div class="plan__foot">
        A structured summary, not a transcript. It rewrites itself as you answer.
      </div>
    </aside>
  `,
  styles: `
    .plan {
      height: 100%;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
    }
    .plan__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 13px 18px;
      border-bottom: 1px solid var(--hairline);
    }
    .plan__t {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.01em;
      display: flex;
      align-items: center;
      gap: 9px;
    }
    .plan__beam {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--a400);
      box-shadow: 0 0 8px 2px rgba(189, 3, 247, 0.5);
    }
    .plan__status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-family: var(--mono);
      font-size: 10.5px;
      letter-spacing: 0.05em;
      color: var(--muted);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 4px 11px;
    }
    .plan__pulse {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--a500);
      animation: plpulse 1.4s infinite;
    }
    @keyframes plpulse {
      50% {
        opacity: 0.3;
      }
    }
    .plan__body {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px 20px;
    }
    .plan__ov {
      font-size: 14.5px;
      line-height: 1.65;
      color: var(--fg2);
      margin: 0 0 16px;
    }
    .psec {
      padding: 12px 0;
      border-top: 1px solid var(--hairline);
    }
    .psec__t {
      font-size: 11.5px;
      font-weight: 700;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--accent-tx);
      margin-bottom: 7px;
    }
    .psec ul {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .psec li {
      position: relative;
      padding-left: 16px;
      font-size: 13.5px;
      color: var(--fg2);
    }
    .psec li::before {
      content: '';
      position: absolute;
      left: 2px;
      top: 8px;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--a300);
    }
    .plan__sh {
      height: 13px;
      border-radius: 6px;
      margin: 6px 0;
      background: linear-gradient(
        90deg,
        var(--surface-2) 25%,
        var(--surface-3) 50%,
        var(--surface-2) 75%
      );
      background-size: 200% 100%;
      animation: plsh 1.4s infinite;
    }
    @keyframes plsh {
      to {
        background-position: -200% 0;
      }
    }
    .plan__empty {
      font-size: 13px;
      color: var(--faint);
      margin: 4px 0;
    }
    .plan__foot {
      border-top: 1px solid var(--hairline);
      padding: 9px 18px;
      font-size: 12px;
      color: var(--faint);
    }
    @media (prefers-reduced-motion: reduce) {
      .plan__pulse,
      .plan__sh {
        animation: none;
      }
    }
  `,
})
export class PlanPanel implements OnInit {
  /** the request whose plan this renders */
  id = input.required<number>();
  /** answered-turn count for the status pill */
  answers = input(0);

  private api = inject(Api);
  plan = signal<ReviewSummary | null>(null);
  thinking = computed(() => !!this.plan()?.thinking);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      if (this.timer) clearTimeout(this.timer);
    });
  }

  ngOnInit() {
    this.refresh();
  }

  /** fetch the summary; while the brain is writing, re-poll every ~1.5s */
  refresh() {
    this.api.summary(this.id()).subscribe((p) => {
      this.plan.set(p);
      if (this.timer) clearTimeout(this.timer);
      if (p.thinking && !this.destroyed) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.refresh();
        }, 1500);
      }
    });
  }
}
