import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { TYPE_LABEL } from '../util';
import { Icon } from './icon';

@Component({
  selector: 'sf-track-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <button
      type="button"
      class="tchip"
      [class.tchip--unsure]="state() === 'unsure'"
      [class.tchip--pulse]="state() === 'pulse'"
      (click)="correct.emit()"
      [attr.aria-label]="
        state() === 'unsure' ? 'Choose the request type' : 'Change the request type'
      "
    >
      @if (state() === 'unsure') {
        <sf-icon name="help" [size]="12" />
        <span class="tchip__t">What kind of request is this?</span>
      } @else {
        <sf-icon [name]="icon()" [size]="12" />
        <span class="tchip__t">{{ label() }}</span>
      }
      <span class="tchip__edit">change</span>
    </button>
  `,
  styles: `
    /* Neutral surface, never a purple fill: this chip is a settled *state*, and
       the design system reserves purple for the brand dot, primary actions and
       small semantic tags. A tinted control also reads as "selected", which this
       is not — it is the current answer, with an affordance to change it. */
    .tchip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--body);
      font-size: 12.5px;
      color: var(--fg1);
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 5px 12px;
      cursor: pointer;
      transition:
        border-color var(--dur) var(--ease),
        box-shadow var(--dur) var(--ease);
    }
    .tchip:hover {
      border-color: var(--border-strong);
    }
    /* unsure differs by TEXT weight, not by fill — both are neutral now */
    .tchip--unsure {
      border-style: dashed;
      color: var(--muted);
    }
    .tchip__edit {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--faint);
      margin-left: 4px;
    }
    .tchip--pulse {
      animation: tchip-pulse 1.2s ease-in-out 3;
    }
    @keyframes tchip-pulse {
      50% {
        box-shadow: 0 0 0 4px var(--accent-tint);
        border-color: var(--accent);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .tchip--pulse {
        animation: none;
      }
    }
  `,
})
export class TrackChip {
  t = input.required<string>();
  state = input<'confident' | 'unsure' | 'pulse'>('confident');
  correct = output<void>();
  icon = computed(
    () =>
      (({ bug: 'bug', enh: 'spark', new: 'app', other: 'help' }) as Record<string, string>)[
        this.t()
      ] ?? 'help',
  );
  label = computed(() => TYPE_LABEL[this.t()] ?? this.t());
}
