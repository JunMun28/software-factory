import {
  afterNextRender,
  Component,
  ElementRef,
  inject,
  input,
  OnDestroy,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import Lenis from 'lenis';

import { Avatar, Icon, Mark, Theme } from '@sf/shared';
import { Session } from '../core/session.service';

/** Submitter shell: top bar + intake progress as a fixed LEFT RAIL — only the
 *  current step is labelled ("1 · Describe"); a scroll-linked tracing beam runs
 *  down from it (gradient fill + glowing head), and mini dots keep 1-of-N
 *  orientation + back-navigation. Page scrolling is smoothed with Lenis
 *  (disabled under prefers-reduced-motion). Chosen from the 2026-07 stepper lab
 *  (variant 4 "Left rail" + tracing beam). Intake is submitter-only since the
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
          <div class="rail__cur">
            <span class="rail__dot">{{ step()! + 1 }}</span>
            <span class="rail__lbl">{{ steps()[step()!].label }}</span>
          </div>
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
          <div class="rail__track">
            <div class="rail__fill" #beamFill><i class="rail__head"></i></div>
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
    .rail__cur {
      display: flex;
      align-items: center;
      gap: 9px;
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
    .rail__lbl {
      font-size: 13px;
      font-weight: 600;
      color: var(--accent-tx);
      white-space: nowrap;
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
    .rail__track {
      position: relative;
      flex: 1;
      width: 2px;
      margin-left: 12px;
      background: var(--hairline);
      border-radius: 2px;
    }
    .rail__fill {
      width: 100%;
      height: 0%;
      background: linear-gradient(180deg, var(--a500), var(--a400) 55%, #22d3ee);
      border-radius: 2px;
      position: relative;
    }
    .rail__head {
      position: absolute;
      left: 50%;
      bottom: 0;
      transform: translate(-50%, 50%);
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--a300);
      box-shadow:
        0 0 10px 2px rgba(189, 3, 247, 0.65),
        0 0 26px 6px rgba(189, 3, 247, 0.3);
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
  private beamFill = viewChild<ElementRef<HTMLDivElement>>('beamFill');
  private lenis: Lenis | null = null;
  private readonly onHostScroll = () => this.updateBeam();

  constructor() {
    afterNextRender(() => this.initScroll());
  }

  /** Lenis smooths the shell body (skipped under prefers-reduced-motion); the
   *  tracing beam listens to native scroll, which fires either way. */
  private initScroll() {
    const host = this.scrollHost()?.nativeElement;
    if (!host) return;
    host.addEventListener('scroll', this.onHostScroll, { passive: true });
    this.updateBeam();
    if (!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.lenis = new Lenis({
        wrapper: host,
        content: host.firstElementChild as HTMLElement,
        autoRaf: true,
      });
    }
  }

  ngOnDestroy() {
    this.scrollHost()?.nativeElement.removeEventListener('scroll', this.onHostScroll);
    this.lenis?.destroy();
    this.lenis = null;
  }

  private updateBeam() {
    const host = this.scrollHost()?.nativeElement;
    const fill = this.beamFill()?.nativeElement;
    if (!host || !fill) return;
    const limit = host.scrollHeight - host.clientHeight;
    const p = limit > 0 ? Math.min(1, Math.max(0, host.scrollTop / limit)) : 0;
    fill.style.height = `${(p * 100).toFixed(2)}%`;
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
