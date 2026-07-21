import { Component, computed, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideGripVertical } from '@ng-icons/lucide';

import { adjustScrubbableValue, canScrubValue } from './scrubbable-value';

@Component({
  selector: 'app-scrubbable-input',
  imports: [NgIcon],
  providers: [provideIcons({ lucideGripVertical })],
  template: `
    <div class="scrubbable-shell" [class.scrubbing]="scrubbing()">
      <button
        type="button"
        class="scrub-handle"
        [attr.aria-label]="'Drag to adjust ' + label()"
        [disabled]="!scrubbable()"
        (pointerdown)="onPointerDown($event)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="onPointerEnd($event)"
        (pointercancel)="onPointerEnd($event)"
        (keydown)="onHandleKeydown($event)"
      >
        <ng-icon name="lucideGripVertical" size="10" aria-hidden="true" />
      </button>
      <input
        type="text"
        [attr.aria-label]="label()"
        [value]="value()"
        (input)="valueChange.emit(($any($event.target)).value)"
      />
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .scrubbable-shell {
      display: grid;
      grid-template-columns: 1.25rem minmax(0, 1fr);
      width: 100%;
      height: 2rem;
      overflow: hidden;
      border: 1px solid var(--input);
      border-radius: 0.375rem;
      background: var(--background);
      color: var(--foreground);
    }
    .scrubbable-shell:focus-within {
      border-color: var(--ring);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--ring) 24%, transparent);
    }
    .scrub-handle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      background: transparent;
      color: var(--muted-foreground);
      cursor: ew-resize;
      touch-action: none;
      user-select: none;
    }
    .scrub-handle:hover,
    .scrub-handle:focus-visible,
    .scrubbing .scrub-handle {
      background: var(--muted);
      color: var(--foreground);
      outline: none;
    }
    .scrub-handle:focus-visible {
      box-shadow: inset 0 0 0 1px var(--ring);
    }
    .scrub-handle:disabled {
      cursor: default;
      opacity: 0.35;
    }
    input {
      min-width: 0;
      border: 0;
      background: transparent;
      padding: 0 0.5rem 0 0.125rem;
      color: inherit;
      font: inherit;
      font-size: 0.6875rem;
      outline: none;
    }
  `,
})
export class ScrubbableInput {
  readonly value = input.required<string>();
  readonly label = input.required<string>();
  readonly step = input(1);
  readonly min = input<number | undefined>(undefined);
  readonly max = input<number | undefined>(undefined);
  readonly valueChange = output<string>();
  readonly scrubbing = signal(false);
  readonly scrubbable = computed(() => canScrubValue(this.value()));

  private activePointerId: number | null = null;
  private startX = 0;
  private startValue = '';
  private lastStepCount = 0;

  onPointerDown(event: PointerEvent): void {
    if (!this.scrubbable()) return;
    event.preventDefault();
    this.activePointerId = event.pointerId;
    this.startX = event.clientX;
    this.startValue = this.value();
    this.lastStepCount = 0;
    this.scrubbing.set(true);
    try {
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic test events and older browsers may not expose pointer capture.
    }
  }

  onPointerMove(event: PointerEvent): void {
    if (this.activePointerId !== event.pointerId) return;
    const stepCount = Math.trunc((event.clientX - this.startX) / 4);
    if (stepCount === this.lastStepCount) return;
    this.lastStepCount = stepCount;
    this.valueChange.emit(
      adjustScrubbableValue(this.startValue, stepCount, {
        step: this.step(),
        min: this.min(),
        max: this.max(),
      }),
    );
  }

  onPointerEnd(event: PointerEvent): void {
    if (this.activePointerId !== event.pointerId) return;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    } catch {
      // Ignore unavailable pointer capture.
    }
    this.activePointerId = null;
    this.scrubbing.set(false);
  }

  onHandleKeydown(event: KeyboardEvent): void {
    if (!this.scrubbable() || !['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const stepCount = direction * (event.shiftKey ? 10 : 1);
    this.valueChange.emit(
      adjustScrubbableValue(this.value(), stepCount, {
        step: this.step(),
        min: this.min(),
        max: this.max(),
      }),
    );
  }
}
