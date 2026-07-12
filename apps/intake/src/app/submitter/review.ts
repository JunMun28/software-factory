import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';

import {
  Api,
  Icon,
  Mark,
  RequestDetail,
  ReviewSummary,
  TypeChip,
  prototypeSrcdoc,
} from '@sf/shared';
import { IntakeDraft } from './intake-draft.service';
import { ProtoFullscreen } from './proto-fullscreen';
import { SubShell } from './sub-shell';

/** Review — the AI-written spec of the request before submit, shown wide and two-column: the
 *  structured spec on the left, the prototype (with a full-screen view) on the right. Two ways
 *  forward: "Add more detail" reopens the chat, or "Submit request" sends it to a reviewer. */
@Component({
  selector: 'sf-review',
  imports: [SubShell, Icon, Mark, TypeChip, ProtoFullscreen, NgTemplateOutlet],
  template: `
    <sub-shell active="new">
      <div class="rv-wrap fade-in">
        <h1 class="rv-h1">Review your request</h1>
        <p class="rv-sub">Here's the spec we'll send to the reviewer. Add more, or submit it.</p>

        @if (req(); as r) {
          @if (r.type === 'new') {
            <!-- FULL/RICH review — New app only: structured spec + prototype -->
            <div class="rv-grid">
              <!-- LEFT: the structured spec -->
              <div class="rv-main">
                <div class="card rv" style="overflow:hidden">
                  <div class="rv__head">
                    <span class="rv__av"><sf-mark [size]="14" color="#fff" /></span>
                    <span class="rv__title">Request spec</span>
                  </div>

                  @if (summary()?.overview; as ov) {
                    <div class="rv__body">
                      <p class="rv__overview">{{ ov }}</p>
                      @for (sec of summary()!.sections; track sec.title) {
                        <div class="rv__sec">
                          <div class="rv__sec-title">{{ sec.title }}</div>
                          <ul class="rv__list">
                            @for (it of sec.items; track $index) {
                              <li>{{ it }}</li>
                            }
                          </ul>
                        </div>
                      }
                    </div>
                  } @else {
                    <div class="rv__body rv__loading" aria-hidden="true">
                      <span class="rv__bar" style="width:92%"></span>
                      <span class="rv__bar" style="width:80%"></span>
                      <span class="rv__bar" style="width:96%"></span>
                      <span class="rv__bar" style="width:70%"></span>
                      <span class="rv__bar" style="width:60%"></span>
                      <span class="rv__thinking">Writing the spec…</span>
                    </div>
                  }

                  <div class="rv__facts">
                    <ng-container [ngTemplateOutlet]="facts" [ngTemplateOutletContext]="{ r }" />
                  </div>
                </div>
              </div>

              <!-- RIGHT: the prototype (new-app only) -->
              <aside class="rv-side">
                @if (protoDoc(); as doc) {
                  <div class="card pv" style="overflow:hidden">
                    <div class="pv__head">
                      <span class="pv__title">Prototype</span>
                      <span class="pv__sp"></span>
                      <button class="pv__btn" (click)="openFull()" title="View full screen">
                        <sf-icon name="maximize" [size]="14" /> Full screen
                      </button>
                      <button class="pv__edit" (click)="editProto()">Edit</button>
                    </div>
                    <div class="pv__frame">
                      <iframe
                        [srcdoc]="doc"
                        sandbox="allow-scripts"
                        title="Prototype preview"
                        loading="lazy"
                      ></iframe>
                    </div>
                  </div>
                } @else {
                  <button class="pv-add" (click)="editProto()">
                    <span style="color:var(--accent)">＋</span> Add a prototype
                  </button>
                }
              </aside>
            </div>
          } @else {
            <!-- COMPACT review — short tracks (bug/enh/other): what the factory understood -->
            <div class="rv-grid rv-grid--solo review--compact">
              <div class="card rv" style="overflow:hidden">
                <div class="rv__head">
                  <span class="rv__av"><sf-mark [size]="14" color="#fff" /></span>
                  <span class="rv__title">What we understood</span>
                </div>

                @if (summary()?.overview; as ov) {
                  <div class="rv__body">
                    <p class="rv__overview">{{ ov }}</p>
                  </div>
                } @else {
                  <div class="rv__body rv__loading" aria-hidden="true">
                    <span class="rv__bar" style="width:92%"></span>
                    <span class="rv__bar" style="width:76%"></span>
                    <span class="rv__thinking">Writing the spec…</span>
                  </div>
                }

                <div class="rv__facts">
                  <ng-container [ngTemplateOutlet]="facts" [ngTemplateOutletContext]="{ r }" />
                </div>
              </div>
            </div>
          }
        }

        <!-- Shared "what happens next" footer — same copy for every track -->
        <div class="rv-next">
          <span class="rv-next__k">What happens next</span>
          <p class="rv-next__p">
            A reviewer checks your request, then either approves it to build or sends back a quick
            question. You'll get an email either way.
          </p>
        </div>

        <div class="rv-actions">
          <button class="btn ghost" (click)="addMore()">
            <span style="color:var(--accent)">↩</span> Add more detail
          </button>
          <button class="btn primary lg" [disabled]="submitting()" (click)="submit()">
            {{ submitting() ? 'Submitting…' : 'Submit request' }}
            <sf-icon name="arrowRight" [size]="16" />
          </button>
        </div>
      </div>

      <!-- Key facts — shared between the full and compact layouts -->
      <ng-template #facts let-r="r">
        <span><i>Type</i><sf-type-chip [t]="r.type" /></span>
        <span
          ><i>{{ r.type === 'new' ? 'App name' : 'App' }}</i
          >{{ r.app_name }}</span
        >
        @if (r.type !== 'bug') {
          <span
            ><i>{{
              r.type === 'enh'
                ? 'Who benefits?'
                : r.type === 'other'
                  ? 'Who is this for?'
                  : 'Who will use it?'
            }}</i
            >{{ reachLabel(r.reach) || 'Only the requester' }}</span
          >
          @if (impactLabel(r); as impact) {
            <span
              ><i>{{ r.type === 'other' ? 'Expected outcome' : 'Expected benefit' }}</i
              >{{ impact }}</span
            >
          }
        }
        <button class="rv__edit" (click)="go('/submit/new')">Edit details</button>
      </ng-template>

      <!-- full-screen prototype overlay (shared component) -->
      @if (fullscreen() && protoDoc(); as doc) {
        <sf-proto-fullscreen
          [doc]="doc"
          [title]="(req()?.app_name || 'Prototype') + ' · prototype'"
          (closed)="closeFull()"
        />
      }
    </sub-shell>
  `,
  styles: `
    .rv-wrap {
      max-width: 1180px;
      margin: 0 auto;
      padding: 34px 26px 84px;
    }
    .rv-h1 {
      font-size: 28px;
      letter-spacing: -0.02em;
      margin: 0;
    }
    .rv-sub {
      color: var(--muted);
      margin: 6px 0 22px;
      font-size: 16px;
    }
    .rv-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.02fr);
      gap: 20px;
      align-items: start;
    }
    .rv-grid--solo {
      grid-template-columns: 1fr;
      max-width: 800px;
    }
    @media (max-width: 940px) {
      .rv-grid {
        grid-template-columns: 1fr;
      }
    }
    .rv-side {
      position: sticky;
      top: 18px;
    }
    .rv-next {
      margin-top: 22px;
      padding: 14px 16px;
      border-radius: 12px;
      background: var(--surface-2);
      border: 1px solid var(--hairline);
    }
    .rv-next__k {
      display: block;
      font-size: 11.5px;
      font-weight: 700;
      color: var(--accent-link);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 5px;
    }
    .rv-next__p {
      margin: 0;
      font-size: 14px;
      line-height: 1.6;
      color: var(--fg1);
    }
    .rv-actions {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-top: 16px;
    }

    .rv__head {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 12px 16px;
      background: var(--accent-tint);
      border-bottom: 1px solid var(--accent-tint-bd);
    }
    .rv__av {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--a600);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }
    .rv__title {
      font-size: 13px;
      font-weight: 600;
      color: var(--accent-link);
    }
    .rv__body {
      padding: 18px 20px;
    }
    .rv__overview {
      margin: 0;
      font-size: 15.5px;
      line-height: 1.62;
      color: var(--fg1);
    }
    .rv__sec {
      margin-top: 18px;
    }
    .rv__sec-title {
      font-size: 11.5px;
      font-weight: 700;
      color: var(--accent-link);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 7px;
    }
    .rv__list {
      margin: 0;
      padding-left: 18px;
      font-size: 14.5px;
      line-height: 1.65;
      color: var(--fg1);
    }
    .rv__list li {
      margin-bottom: 4px;
    }
    .rv__loading {
      display: flex;
      flex-direction: column;
      gap: 11px;
    }
    .rv__bar {
      height: 12px;
      border-radius: 6px;
      background: linear-gradient(
        90deg,
        var(--surface-2) 25%,
        var(--surface-3) 37%,
        var(--surface-2) 63%
      );
      background-size: 400% 100%;
      animation: rv-shimmer 1.4s ease infinite;
    }
    .rv__thinking {
      font-size: 12.5px;
      color: var(--faint);
      margin-top: 2px;
    }
    @keyframes rv-shimmer {
      0% {
        background-position: 100% 50%;
      }
      100% {
        background-position: 0 50%;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .rv__bar {
        animation: none;
      }
    }
    .rv__facts {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 22px;
      padding: 12px 20px;
      border-top: 1px solid var(--hairline);
      background: var(--surface-2);
      font-size: 13px;
    }
    .rv__facts > span {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--fg1);
      font-weight: 500;
    }
    .rv__facts i {
      font-style: normal;
      color: var(--muted);
      font-weight: 400;
    }
    .rv__edit {
      margin-left: auto;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--accent-link);
      font-weight: 600;
      font-size: 13px;
      font-family: var(--body);
      padding: 2px 4px;
    }

    .pv__head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px 10px 16px;
      border-bottom: 1px solid var(--hairline);
      background: var(--surface-2);
    }
    .pv__title {
      font-size: 13px;
      font-weight: 600;
      color: var(--fg1);
    }
    .pv__sp {
      flex: 1;
    }
    .pv__btn,
    .pv__edit {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--accent-link);
      font-weight: 600;
      font-size: 12.5px;
      font-family: var(--body);
      padding: 4px 6px;
      border-radius: 7px;
    }
    .pv__btn:hover,
    .pv__edit:hover {
      background: var(--accent-tint);
    }
    .pv__frame {
      height: 460px;
      background: #fff;
    }
    .pv__frame iframe {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
    }
    .pv-add {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: none;
      border: 1px dashed var(--hairline);
      border-radius: 10px;
      padding: 12px 16px;
      cursor: pointer;
      color: var(--muted);
      font-weight: 600;
      font-size: 13.5px;
      font-family: var(--body);
      width: 100%;
      justify-content: center;
    }
  `,
})
export class Review implements OnInit {
  private api = inject(Api);
  private router = inject(Router);
  private draft = inject(IntakeDraft);
  private sanitizer = inject(DomSanitizer);
  id = Number(inject(ActivatedRoute).snapshot.paramMap.get('id'));
  private get extra() {
    return this.draft.extra;
  }

  req = signal<RequestDetail | null>(null);
  summary = signal<ReviewSummary | null>(null);
  protoDoc = signal<SafeHtml | null>(null); // the prototype rendered into the preview iframe
  fullscreen = signal(false);
  submitting = signal(false);
  private destroyed = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      if (this.pollTimer) clearTimeout(this.pollTimer);
    });
  }

  ngOnInit() {
    this.api.request(this.id).subscribe((r) => {
      this.req.set(r);
      this.draft.hydrateFrom(r); // survive a reload here → step back to Describe
      // render the stored prototype into a sandboxed iframe (CSP-normalized; srcdoc needs a trusted value)
      this.protoDoc.set(
        r.type === 'new' && r.prototype_html
          ? this.sanitizer.bypassSecurityTrustHtml(prototypeSrcdoc(r.prototype_html))
          : null,
      );
    });
    this.loadSummary();
  }

  openFull() {
    if (this.protoDoc()) this.fullscreen.set(true);
  }
  closeFull() {
    this.fullscreen.set(false);
  }

  /** back to the Prototype step to keep shaping the mock */
  editProto() {
    this.router.navigateByUrl(`/submit/${this.id}/prototype`);
  }

  /** Fetch the AI spec; poll every ~1.5s while it's still generating. */
  private loadSummary() {
    if (this.destroyed) return;
    this.api.summary(this.id).subscribe({
      next: (s) => {
        this.summary.set(s);
        if (s.thinking && !this.destroyed) {
          this.pollTimer = setTimeout(() => this.loadSummary(), 1500);
        }
      },
      error: () => {
        /* leave the skeleton up; a transient error just retries on next visit */
      },
    });
  }

  reachLabel(reach: RequestDetail['reach']) {
    if (!reach) return null;
    const canned: Record<string, string> = {
      me: 'Only me (1 person)',
      team: 'My team (under 10 people)',
      dept: 'My department (tens of people)',
      wider: 'Several departments (100+ people)',
      site: 'One site (hundreds of people)',
      network: 'Across sites (1000+ people)',
    };
    return canned[reach] ?? reach;
  }
  impactLabel(r: RequestDetail) {
    if (!r.impact_metric || !r.impact_value) return null;
    return {
      hours: `${r.impact_value} hours saved per year`,
      cost: `$${r.impact_value}k saved per year`,
      other: r.impact_value,
    }[r.impact_metric];
  }
  go(url: string) {
    this.router.navigateByUrl(url);
  }
  /** back to the chat to add more — the interview reopens for a follow-up */
  addMore() {
    this.router.navigateByUrl(`/submit/${this.id}/interview`);
  }

  submit() {
    this.submitting.set(true);
    this.api.submit(this.id, this.extra).subscribe({
      next: () => {
        this.draft.reset();
        this.router.navigateByUrl(`/submit/${this.id}/done`);
      },
      error: () => this.submitting.set(false),
    });
  }
}
