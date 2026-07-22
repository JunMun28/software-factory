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
import { IntakeDraft } from './intake-draft.service';

/** Submitter shell: an "island" top bar — brand left, floating glass nav pill
 *  centered, controls right — over a Lenis-smoothed content area. Intake is
 *  submitter-only since the app split (ADR 0017 Phase 2). */
@Component({
  selector: 'sub-shell',
  imports: [Mark, Avatar, Icon],
  template: `
    <div class="sub">
      <div class="sub-top">
        <button class="sub-brand" type="button" (click)="home()" title="New request">
          <sf-mark [size]="22" />
          <span>AIRES</span>
        </button>
        <nav class="sub-nav">
          <button [class.on]="active() === 'new'" (click)="startNew()">New request</button>
          <button [class.on]="active() === 'list'" (click)="go('/requests')">My requests</button>
        </nav>
        <div class="sub-top-right">
          <button
            class="adm-iconbtn"
            type="button"
            (click)="toggleTheme()"
            [attr.aria-label]="
              theme.resolved() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
            "
            [title]="theme.resolved() === 'dark' ? 'Light mode' : 'Dark mode'"
          >
            <sf-icon [name]="theme.resolved() === 'dark' ? 'sun' : 'moon'" [size]="18" />
          </button>
          <span [title]="session.user().name + ' — ' + session.user().email">
            <sf-avatar [color]="session.user().color">{{ session.user().initials }}</sf-avatar>
          </span>
        </div>
      </div>
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
    .adm-iconbtn {
      border-color: transparent;
      background: transparent;
    }
    .adm-iconbtn:hover {
      border-color: transparent;
      background: var(--surface-2);
    }
    /* inline/block line boxes would push the avatar below center */
    .sub-top-right > span,
    .sub-top-right sf-avatar {
      display: inline-flex;
    }
    /* the brand wordmark is the first thing to go on narrow screens */
    @media (max-width: 560px) {
      .sub-brand span {
        display: none;
      }
    }
  `,
})
export class SubShell implements OnDestroy {
  session = inject(Session);
  theme = inject(Theme);
  private router = inject(Router);
  private draft = inject(IntakeDraft);

  toggleTheme() {
    this.theme.set(this.theme.resolved() === 'dark' ? 'light' : 'dark');
  }

  home() {
    this.startNew();
  }

  /** Start a genuinely new request: clear any in-progress draft so the composer
   *  opens fresh. The brand mark and the "New request" nav both mean "start over"
   *  — unlike Review's "Edit details", which routes to the composer to keep editing
   *  the current draft and so must NOT reset. */
  startNew() {
    this.draft.reset();
    this.router.navigateByUrl('/submit/new');
  }

  active = input<'new' | 'list' | ''>('');
  private scrollHost = viewChild<ElementRef<HTMLDivElement>>('scrollHost');
  private lenis: Lenis | null = null;

  constructor() {
    afterNextRender(() => this.initScroll());
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

  go(url: string) {
    this.router.navigateByUrl(url);
  }
}
