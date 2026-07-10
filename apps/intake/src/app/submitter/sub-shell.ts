import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  HostListener,
  inject,
  input,
  isDevMode,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import Lenis from 'lenis';

import { Avatar, Icon, Mark, Theme } from '@sf/shared';
import { Session } from '../core/session.service';

const RAIL_VARIANTS = [
  { key: 'A', name: 'Chapter label' },
  { key: 'B', name: 'Vertical index' },
  { key: 'C', name: 'Compact pill' },
  { key: 'D', name: 'Bracket marker' },
  { key: 'E', name: 'Margin caption' },
] as const;

type RailVariant = (typeof RAIL_VARIANTS)[number]['key'];

function isRailVariant(value: string | null): value is RailVariant {
  return RAIL_VARIANTS.some((variant) => variant.key === value);
}

/** Submitter shell: top bar + intake progress as a fixed LEFT RAIL — only the
 *  current step is labelled ("1 · Describe"), and mini dots keep 1-of-N
 *  orientation + back-navigation. Page scrolling is smoothed with Lenis
 *  (disabled under prefers-reduced-motion). Chosen from the 2026-07 stepper lab
 *  (variant 4 "Left rail"). Intake is submitter-only since the
 *  app split (ADR 0017 Phase 2). */
@Component({
  selector: 'sub-shell',
  imports: [Mark, Avatar, Icon],
  template: `
    <div class="sub">
      <div class="sub-top">
        <button class="sub-brand" type="button" (click)="home()" title="My requests">
          <sf-mark [size]="20" /> Software Factory
        </button>
        <div class="row" style="gap:16px">
          <nav class="sub-nav">
            <button [class.on]="active() === 'new'" (click)="go('/submit/new')">New request</button>
            <button [class.on]="active() === 'list'" (click)="go('/requests')">My requests</button>
          </nav>
          <button
            class="adm-iconbtn"
            type="button"
            (click)="toggleTheme()"
            [attr.aria-label]="
              theme.resolved() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
            "
            [title]="theme.resolved() === 'dark' ? 'Light mode' : 'Dark mode'"
          >
            <sf-icon [name]="theme.resolved() === 'dark' ? 'sun' : 'moon'" [size]="16" />
          </button>
          <span
            class="sub-id"
            style="font-family:var(--body);font-size:13px"
            [title]="session.user().email"
          >
            <sf-avatar [sm]="true" [color]="session.user().color">{{
              session.user().initials
            }}</sf-avatar>
            {{ session.user().name }}
          </span>
        </div>
      </div>
      @if (step() !== null) {
        <aside class="rail" aria-label="Progress">
          @switch (railVariant()) {
            @case ('A') {
              <div class="rail-title rail-title--chapter" data-rail-variant="A">
                <span>{{ stepNumber() }}</span>
                <span class="rail-title__slash">/</span>
                <span>{{ stepLabel().toUpperCase() }}</span>
              </div>
            }
            @case ('B') {
              <div class="rail-title rail-title--vertical" data-rail-variant="B">
                <strong>{{ stepNumber() }}</strong>
                <span>{{ stepLabel().toUpperCase() }}</span>
              </div>
            }
            @case ('C') {
              <div class="rail-title rail-title--pill" data-rail-variant="C">
                <span>{{ stepNumber() }}</span>
                <span>{{ stepLabel() }}</span>
              </div>
            }
            @case ('D') {
              <div class="rail-title rail-title--bracket" data-rail-variant="D">
                <i class="rail-title__corner rail-title__corner--tl" aria-hidden="true"></i>
                <span class="rail-title__index">{{ stepNumber() }}</span>
                <strong>{{ stepLabel() }}</strong>
                <i class="rail-title__corner rail-title__corner--br" aria-hidden="true"></i>
              </div>
            }
            @case ('E') {
              <div class="rail-title rail-title--caption" data-rail-variant="E">
                <span>Current section · {{ stepNumber() }}</span>
                <strong>{{ stepLabel() }}</strong>
              </div>
            }
          }
          <div class="rail__minis">
            @for (s of steps(); track s.label; let i = $index) {
              <button
                type="button"
                class="mini"
                [class.done]="i < step()!"
                [class.cur]="i === step()!"
                [disabled]="i >= step()! || !backable()"
                [attr.aria-label]="s.label + (i === step()! ? ' (current)' : '')"
                [title]="i < step()! && backable() ? 'Back to ' + s.label : s.label"
                (click)="i < step()! && backable() && goStep(i)"
              ></button>
            }
          </div>
        </aside>
        <div class="railchip" aria-label="Progress">
          <span class="rail__dot">{{ step()! + 1 }}</span>
          {{ steps()[step()!].label }}
          <span class="railchip__of">of {{ steps().length }}</span>
        </div>
      }
      <div class="sub-body scroll" #scrollHost>
        <div class="sub-body-inner"><ng-content /></div>
      </div>
      @if (showPrototypeSwitcher && step() === 0) {
        <div class="proto-switcher" aria-label="Rail title prototype switcher">
          <button type="button" aria-label="Previous rail title variant" (click)="cycleVariant(-1)">
            ←
          </button>
          <span class="proto-switcher__label">
            {{ variantDetails().key }} — {{ variantDetails().name }}
          </span>
          <button type="button" aria-label="Next rail title variant" (click)="cycleVariant(1)">
            →
          </button>
        </div>
      }
    </div>
  `,
  styles: `
    .sub-brand {
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      color: inherit;
    }
    .sub-brand:hover {
      opacity: 0.78;
    }

    /* ── left progress rail ── */
    .rail {
      position: fixed;
      left: 26px;
      top: 96px;
      bottom: 34px;
      z-index: 15;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      pointer-events: none;
    }
    .rail-title {
      display: flex;
      color: var(--accent-tx);
      white-space: nowrap;
    }
    .rail-title--chapter {
      align-items: baseline;
      gap: 7px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
    }
    .rail-title__slash {
      color: var(--faint);
      font-weight: 400;
    }
    .rail-title--vertical {
      align-items: flex-start;
      gap: 7px;
      height: 68px;
    }
    .rail-title--vertical strong {
      font-size: 36px;
      line-height: 0.88;
      letter-spacing: -0.07em;
    }
    .rail-title--vertical span {
      writing-mode: vertical-rl;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.14em;
    }
    .rail-title--pill {
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      background: var(--surface);
      font-size: 12px;
      font-weight: 600;
    }
    .rail-title--pill span:first-child {
      color: var(--faint);
      font-size: 10px;
      letter-spacing: 0.08em;
    }
    .rail-title--bracket {
      position: relative;
      flex-direction: column;
      gap: 2px;
      padding: 8px 12px;
    }
    .rail-title--bracket strong {
      font-size: 14px;
      font-weight: 650;
    }
    .rail-title__index {
      color: var(--faint);
      font-size: 9px;
      letter-spacing: 0.12em;
    }
    .rail-title__corner {
      position: absolute;
      width: 12px;
      height: 12px;
      border-color: var(--a500);
    }
    .rail-title__corner--tl {
      top: 0;
      left: 0;
      border-top: 1px solid;
      border-left: 1px solid;
    }
    .rail-title__corner--br {
      right: 0;
      bottom: 0;
      border-right: 1px solid;
      border-bottom: 1px solid;
    }
    .rail-title--caption {
      flex-direction: column;
      gap: 3px;
      padding-left: 9px;
      border-left: 2px solid var(--a500);
    }
    .rail-title--caption span {
      color: var(--faint);
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .rail-title--caption strong {
      font-size: 17px;
      font-weight: 600;
    }
    .rail__dot {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      border: 2px solid var(--a500);
      font-size: 12px;
      font-weight: 600;
      color: var(--accent-tx);
      background: var(--surface);
    }
    .rail__minis {
      display: flex;
      gap: 7px;
      margin: 13px 0 15px 10px;
      pointer-events: auto;
    }
    .mini {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      padding: 0;
      border: 1px solid var(--border-strong);
      background: var(--surface);
      cursor: default;
    }
    .mini.done {
      background: var(--a600);
      border-color: var(--a600);
      cursor: pointer;
    }
    .mini.cur {
      border-color: var(--a500);
      background: var(--a100);
    }
    .mini:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px rgba(189, 3, 247, 0.38);
    }
    .proto-switcher {
      position: fixed;
      left: 50%;
      bottom: 20px;
      z-index: 30;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 5px;
      transform: translateX(-50%);
      color: var(--accent-tx);
      background: var(--surface);
      border: 1px solid var(--a500);
      border-radius: 999px;
      box-shadow: var(--shadow-pop);
    }
    .proto-switcher button {
      width: 30px;
      height: 30px;
      padding: 0;
      color: var(--accent-tx);
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      border-radius: 50%;
      cursor: pointer;
    }
    .proto-switcher button:hover {
      background: var(--surface-3);
    }
    .proto-switcher button:focus-visible {
      outline: 2px solid var(--a500);
      outline-offset: 2px;
    }
    .proto-switcher__label {
      min-width: 142px;
      font-size: 12px;
      font-weight: 700;
      text-align: center;
    }
    /* compact chip replaces the rail on narrow screens */
    .railchip {
      display: none;
    }
    @media (max-width: 999px) {
      .rail {
        display: none;
      }
      .railchip {
        position: fixed;
        top: 70px;
        left: 16px;
        z-index: 15;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--accent-tx);
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 5px 12px 5px 6px;
        box-shadow: var(--shadow-pop);
      }
      .railchip .rail__dot {
        width: 20px;
        height: 20px;
        font-size: 10.5px;
      }
      .railchip__of {
        font-weight: 400;
        color: var(--faint);
        font-size: 11.5px;
      }
    }
  `,
})
export class SubShell implements OnDestroy {
  session = inject(Session);
  theme = inject(Theme);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  protected readonly showPrototypeSwitcher = isDevMode();
  protected readonly railVariant = signal<RailVariant>('A');
  protected readonly variantDetails = computed(
    () => RAIL_VARIANTS.find((variant) => variant.key === this.railVariant())!,
  );
  protected readonly stepNumber = computed(() => String((this.step() ?? 0) + 1).padStart(2, '0'));
  protected readonly stepLabel = computed(() => {
    const step = this.step();
    return step === null ? '' : (this.steps()[step]?.label ?? '');
  });

  toggleTheme() {
    this.theme.set(this.theme.resolved() === 'dark' ? 'light' : 'dark');
  }

  home() {
    this.router.navigateByUrl('/requests');
  }

  active = input<'new' | 'list' | ''>('');
  step = input<number | null>(null);
  /** request id for step navigation; when set, steps before the current are clickable */
  reqId = input<number | null>(null);
  /** new-app flow inserts the Prototype step between Clarify and Review */
  proto = input(false);

  private scrollHost = viewChild<ElementRef<HTMLDivElement>>('scrollHost');
  private lenis: Lenis | null = null;

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const variant = params.get('variant');
      this.railVariant.set(isRailVariant(variant) ? variant : 'A');
    });
    afterNextRender(() => this.initScroll());
  }

  cycleVariant(direction: -1 | 1) {
    const currentIndex = RAIL_VARIANTS.findIndex((variant) => variant.key === this.railVariant());
    const nextIndex = (currentIndex + direction + RAIL_VARIANTS.length) % RAIL_VARIANTS.length;
    const variant = RAIL_VARIANTS[nextIndex].key;
    this.railVariant.set(variant);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { variant },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (this.isEditableTarget(event.target)) return;

    event.preventDefault();
    this.cycleVariant(event.key === 'ArrowLeft' ? -1 : 1);
  }

  private isEditableTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'),
    );
  }

  /** Lenis smooths the shell body (skipped under prefers-reduced-motion). */
  private initScroll() {
    const host = this.scrollHost()?.nativeElement;
    if (!host) return;
    if (!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.lenis = new Lenis({
        wrapper: host,
        content: host.firstElementChild as HTMLElement,
        autoRaf: true,
      });
    }
  }

  ngOnDestroy() {
    this.lenis?.destroy();
    this.lenis = null;
  }

  /** smooth-scroll an element into view inside the shell body (Lenis-eased;
   *  instant when Lenis is off) */
  scrollToEl(el: HTMLElement) {
    const host = this.scrollHost()?.nativeElement;
    if (!host) return;
    if (this.lenis) {
      this.lenis.resize(); // content may have grown since init (dynamic sections)
      this.lenis.scrollTo(el, { offset: -12, duration: 1.05 });
    } else {
      host.scrollTop =
        el.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop - 12;
    }
  }

  private allSteps = [
    { label: 'Describe', path: () => '/submit/new' },
    { label: 'Clarify', path: (id: number | null) => `/submit/${id}/interview` },
    { label: 'Prototype', path: (id: number | null) => `/submit/${id}/prototype` },
    { label: 'Review', path: (id: number | null) => `/submit/${id}/review` },
  ];

  /** the visible wizard steps — Prototype only appears in the new-app flow */
  steps() {
    return this.proto() ? this.allSteps : this.allSteps.filter((s) => s.label !== 'Prototype');
  }

  backable() {
    return this.step()! <= this.steps().length - 1;
  }
  go(url: string) {
    this.router.navigateByUrl(url);
  }
  goStep(i: number) {
    this.router.navigateByUrl(this.steps()[i].path(this.reqId()));
  }
}
