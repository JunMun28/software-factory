import { Component, ElementRef, afterNextRender, input, output, viewChild } from '@angular/core';
import { SafeHtml } from '@angular/platform-browser';

import { Icon } from '@sf/shared';

/** Full-viewport overlay showing a prototype mock for review. Esc or the Close button dismisses it;
 *  focus moves to Close on open and the dialog is labelled (a11y). Shared by the Prototype step and
 *  Review so the overlay markup, styles, and sandbox wiring live in exactly one place. */
@Component({
  selector: 'sf-proto-fullscreen',
  imports: [Icon],
  host: { '(window:keydown.escape)': 'closed.emit()' },
  template: `
    <div class="fs" role="dialog" aria-modal="true" aria-label="Prototype full screen">
      <div class="fs__bar">
        <span class="fs__title">{{ title() }}</span>
        <button class="fs__close" #closeBtn (click)="closed.emit()">
          <sf-icon name="x" [size]="15" /> Close
        </button>
      </div>
      <iframe
        class="fs__frame"
        [srcdoc]="doc()"
        sandbox="allow-scripts"
        title="Prototype full screen"
      ></iframe>
    </div>
  `,
  styles: `
    .fs {
      position: fixed;
      inset: 0;
      z-index: 200;
      background: var(--bg);
      display: flex;
      flex-direction: column;
    }
    .fs__bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 18px;
      border-bottom: 1px solid var(--hairline);
      background: var(--surface);
    }
    .fs__title {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--fg1);
      flex: 1;
    }
    .fs__close {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--surface-2);
      border: 1px solid var(--hairline);
      border-radius: 9px;
      padding: 7px 13px;
      cursor: pointer;
      color: var(--fg1);
      font-weight: 600;
      font-size: 13px;
      font-family: var(--body);
    }
    .fs__frame {
      flex: 1;
      width: 100%;
      border: 0;
      background: #fff;
    }
  `,
})
export class ProtoFullscreen {
  doc = input.required<SafeHtml>();
  title = input('Prototype · full screen');
  closed = output<void>();

  private closeBtn = viewChild<ElementRef<HTMLButtonElement>>('closeBtn');

  constructor() {
    // move focus into the dialog on open (a11y) — the overlay is created fresh each time it opens
    afterNextRender(() => this.closeBtn()?.nativeElement.focus());
  }
}
