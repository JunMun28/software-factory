import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { FocusTrap } from '../../lib/focus-trap';

@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FocusTrap],
  template: `
    <div
      data-confirm-dialog-backdrop
      class="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 px-4"
      (click)="dismiss()"
    >
      <section
        focusTrap
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        class="w-full max-w-[420px] rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl"
        (click)="$event.stopPropagation()"
        (focusTrapEscape)="dismiss()"
      >
        <h2 id="confirm-dialog-title" class="text-lg font-semibold">{{ title() }}</h2>
        <p class="mt-2 text-sm text-muted-foreground">{{ description() }}</p>
        <div class="mt-6 flex justify-end gap-2">
          <button
            autoFocusTarget
            data-confirm-dialog-cancel
            type="button"
            class="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
            (click)="dismiss()"
          >
            Cancel
          </button>
          <button
            data-confirm-dialog-confirm
            type="button"
            class="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium disabled:opacity-40"
            [class.bg-foreground]="!destructive()"
            [class.text-background]="!destructive()"
            [class.bg-destructive]="destructive()"
            [class.text-destructive-foreground]="destructive()"
            [disabled]="busy()"
            (click)="confirmed.emit()"
          >
            {{ confirmLabel() }}
          </button>
        </div>
      </section>
    </div>
  `,
})
export class ConfirmDialog {
  readonly title = input.required<string>();
  readonly description = input.required<string>();
  readonly confirmLabel = input('Confirm');
  readonly busy = input(false);
  readonly destructive = input(false);
  readonly confirmed = output<void>();
  readonly dismissed = output<void>();

  dismiss(): void {
    if (this.busy()) {
      return;
    }
    this.dismissed.emit();
  }
}
