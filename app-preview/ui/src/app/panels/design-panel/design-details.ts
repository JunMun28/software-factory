import { Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideAlignCenter,
  lucideAlignJustify,
  lucideAlignLeft,
  lucideAlignRight,
  lucideBold,
  lucideCaseLower,
  lucideCaseSensitive,
  lucideCaseUpper,
  lucideItalic,
  lucideMousePointer2,
  lucideRotateCcw,
  lucideSparkles,
  lucideStrikethrough,
  lucideUnderline,
} from '@ng-icons/lucide';

import type { DesignElement } from '../preview-panel/design-bridge';
import { ColorField } from './color-field';
import type { DesignDraft, EditableDesignStyles } from './design-draft';
import { ScrubbableInput } from './scrubbable-input';

interface StyleToggle {
  icon: string;
  label: string;
  key: keyof EditableDesignStyles;
  on: string;
  off: string;
  mode: 'equals' | 'includes';
}

@Component({
  selector: 'app-design-details',
  imports: [NgIcon, ScrubbableInput, ColorField],
  providers: [
    provideIcons({
      lucideAlignCenter,
      lucideAlignJustify,
      lucideAlignLeft,
      lucideAlignRight,
      lucideBold,
      lucideCaseLower,
      lucideCaseSensitive,
      lucideCaseUpper,
      lucideItalic,
      lucideMousePointer2,
      lucideRotateCcw,
      lucideSparkles,
      lucideStrikethrough,
      lucideUnderline,
    }),
  ],
  template: `
    <aside data-testid="design-details-panel" class="flex min-h-0 flex-col border-l border-border bg-card max-md:hidden">
      @if (selected(); as selected) {
        <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
          <div class="min-w-0">
            <p class="truncate text-xs font-medium">{{ draft()?.text || selected.label }}</p>
            <p class="truncate font-mono text-[10px] text-muted-foreground">{{ selected.selector }}</p>
          </div>
          <span class="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{{ selected.tag }}</span>
        </div>

        @if (draft(); as current) {
          <div class="min-h-0 flex-1 overflow-y-auto">
            <section class="border-b border-border p-3">
              <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Content</p>
              <textarea
                class="min-h-16 w-full resize-none rounded-md border border-input bg-background p-2 text-xs text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                [value]="current.text"
                (input)="textChange.emit(($any($event.target)).value)"
                aria-label="Selected element content"
              ></textarea>
            </section>

            <section class="space-y-3 border-b border-border p-3">
              <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Typography</p>
              <label class="block space-y-1">
                <span class="text-[10px] text-muted-foreground">Font family</span>
                <input class="design-control" aria-label="Font family" [value]="current.styles.fontFamily" (input)="onStyle('fontFamily', ($any($event.target)).value)" />
              </label>
              <div class="grid grid-cols-2 gap-2">
                <label class="block space-y-1">
                  <span class="text-[10px] text-muted-foreground">Size</span>
                  <app-scrubbable-input label="Font size" [value]="current.styles.fontSize" [step]="1" [min]="0" (valueChange)="onStyle('fontSize', $event)" />
                </label>
                <label class="block space-y-1">
                  <span class="text-[10px] text-muted-foreground">Weight</span>
                  <input class="design-control" aria-label="Font weight" [value]="current.styles.fontWeight" (input)="onStyle('fontWeight', ($any($event.target)).value)" />
                </label>
                <label class="block space-y-1">
                  <span class="text-[10px] text-muted-foreground">Line height</span>
                  <app-scrubbable-input label="Line height" [value]="current.styles.lineHeight" [step]="1" [min]="0" (valueChange)="onStyle('lineHeight', $event)" />
                </label>
                <label class="block space-y-1">
                  <span class="text-[10px] text-muted-foreground">Letter spacing</span>
                  <app-scrubbable-input label="Letter spacing" [value]="current.styles.letterSpacing" [step]="0.1" (valueChange)="onStyle('letterSpacing', $event)" />
                </label>
              </div>
              <div class="flex gap-1">
                @for (toggle of textToggles; track toggle.label) {
                  <button type="button" class="design-toggle" [class.bg-muted]="isToggleActive(toggle, current.styles)" [attr.aria-label]="toggle.label" [attr.aria-pressed]="isToggleActive(toggle, current.styles)" (click)="onToggle(toggle, current.styles)"><ng-icon [name]="toggle.icon" size="14" /></button>
                }
                <span class="mx-1 w-px bg-border"></span>
                @for (alignment of alignments; track alignment.value) {
                  <button type="button" class="design-toggle" [class.bg-muted]="current.styles.textAlign === alignment.value" [attr.aria-label]="alignment.label" [attr.aria-pressed]="current.styles.textAlign === alignment.value" (click)="onStyle('textAlign', alignment.value)"><ng-icon [name]="alignment.icon" size="14" /></button>
                }
              </div>
              <div class="flex gap-1">
                @for (toggle of transformToggles; track toggle.label) {
                  <button type="button" class="design-toggle" [class.bg-muted]="isToggleActive(toggle, current.styles)" [attr.aria-label]="toggle.label" [attr.aria-pressed]="isToggleActive(toggle, current.styles)" (click)="onToggle(toggle, current.styles)"><ng-icon [name]="toggle.icon" size="14" /></button>
                }
                <span class="mx-1 w-px bg-border"></span>
                @for (toggle of decorationToggles; track toggle.label) {
                  <button type="button" class="design-toggle" [class.bg-muted]="isToggleActive(toggle, current.styles)" [attr.aria-label]="toggle.label" [attr.aria-pressed]="isToggleActive(toggle, current.styles)" (click)="onToggle(toggle, current.styles)"><ng-icon [name]="toggle.icon" size="14" /></button>
                }
              </div>
            </section>

            <section class="space-y-3 border-b border-border p-3">
              <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Color</p>
              <app-color-field label="Text color" [value]="current.styles.color" (valueChange)="onStyle('color', $event)" />
              <app-color-field label="Background color" [value]="current.styles.backgroundColor" (valueChange)="onStyle('backgroundColor', $event)" />
            </section>

            <section class="space-y-3 border-b border-border p-3">
              <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Spacing</p>
              <label class="block space-y-1">
                <span class="text-[10px] text-muted-foreground">Padding</span>
                <app-scrubbable-input label="Padding" [value]="current.styles.padding" [step]="1" [min]="0" (valueChange)="onStyle('padding', $event)" />
              </label>
              <label class="block space-y-1">
                <span class="text-[10px] text-muted-foreground">Margin</span>
                <app-scrubbable-input label="Margin" [value]="current.styles.margin" [step]="1" (valueChange)="onStyle('margin', $event)" />
              </label>
            </section>

            <section class="space-y-3 border-b border-border p-3">
              <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Border</p>
              <div class="grid grid-cols-2 gap-2">
                <label class="block space-y-1">
                  <span class="text-[10px] text-muted-foreground">Width</span>
                  <app-scrubbable-input label="Border width" [value]="current.styles.borderWidth" [step]="1" [min]="0" (valueChange)="onStyle('borderWidth', $event)" />
                </label>
                <label class="block space-y-1">
                  <span class="text-[10px] text-muted-foreground">Style</span>
                  <select class="design-control" aria-label="Border style" [value]="current.styles.borderStyle" (change)="onStyle('borderStyle', ($any($event.target)).value)">
                    @for (style of borderStyles; track style) { <option [value]="style">{{ style }}</option> }
                  </select>
                </label>
                <label class="block space-y-1">
                  <span class="text-[10px] text-muted-foreground">Radius</span>
                  <app-scrubbable-input label="Border radius" [value]="current.styles.borderRadius" [step]="1" [min]="0" (valueChange)="onStyle('borderRadius', $event)" />
                </label>
                <label class="block space-y-1">
                  <span class="text-[10px] text-muted-foreground">Color</span>
                  <app-color-field label="Border color" [compact]="true" [value]="current.styles.borderColor" (valueChange)="onStyle('borderColor', $event)" />
                </label>
              </div>
            </section>

            <section class="p-3">
              <div class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <ng-icon name="lucideSparkles" size="13" /> Instructions
              </div>
              <div class="mb-2 flex flex-wrap gap-1">
                @for (suggestion of suggestions(); track suggestion) {
                  <button type="button" class="rounded border border-border px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground" (click)="useSuggestion(suggestion)">{{ suggestion }}</button>
                }
              </div>
              <textarea
                class="min-h-20 w-full resize-none rounded-md border border-input bg-background p-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
                [value]="instruction()"
                (input)="instructionChange.emit(($any($event.target)).value)"
                (keydown.enter)="onInstructionEnter($event)"
                aria-label="Instructions for selected element"
                placeholder="Add instructions for this element…"
              ></textarea>
            </section>
          </div>

          <div class="shrink-0 border-t border-border bg-card p-2">
            <div class="mb-2 flex items-center justify-between px-1 text-[10px] text-muted-foreground">
              <span>{{ pending() ? 'Previewing changes' : 'No pending changes' }}</span>
              @if (pending()) { <span class="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true"></span> }
            </div>
            <div class="grid grid-cols-[auto_1fr] gap-2">
              <button type="button" class="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-40" [disabled]="!draftChanged() || turnRunning()" (click)="reset.emit()">
                <ng-icon name="lucideRotateCcw" size="13" /> Reset
              </button>
              <button data-testid="apply-design-changes" type="button" class="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-40" [disabled]="!pending() || turnRunning()" (click)="apply.emit()">
                <ng-icon name="lucideSparkles" size="13" /> Apply
              </button>
            </div>
          </div>
        }
      } @else {
        <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-xs text-muted-foreground">
          <ng-icon name="lucideMousePointer2" size="22" />
          <p>Click any element in the preview to inspect and edit it.</p>
        </div>
      }
    </aside>
  `,
  styles: `
    :host {
      display: flex;
      min-height: 0;
    }
    :host > aside {
      flex: 1;
      min-width: 0;
    }
    .design-control {
      width: 100%;
      height: 2rem;
      border: 1px solid var(--input);
      border-radius: 0.375rem;
      background: var(--background);
      padding: 0 0.5rem;
      color: var(--foreground);
      font-size: 0.6875rem;
      outline: none;
    }
    .design-control:focus {
      border-color: var(--ring);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--ring) 24%, transparent);
    }
    .design-toggle {
      display: inline-flex;
      height: 2rem;
      width: 2rem;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      color: var(--muted-foreground);
    }
    .design-toggle:hover,
    .design-toggle:focus-visible {
      background: var(--muted);
      color: var(--foreground);
      outline: none;
    }
  `,
})
export class DesignDetails {
  readonly selected = input<DesignElement | null>(null);
  readonly draft = input<DesignDraft | null>(null);
  readonly instruction = input('');
  readonly pending = input(false);
  readonly draftChanged = input(false);
  readonly turnRunning = input(false);
  readonly suggestions = input<readonly string[]>([]);

  readonly textChange = output<string>();
  readonly styleChange = output<{ property: string; value: string }>();
  readonly instructionChange = output<string>();
  readonly apply = output<void>();
  readonly reset = output<void>();

  readonly alignments = [
    { value: 'left', label: 'Align left', icon: 'lucideAlignLeft' },
    { value: 'center', label: 'Align center', icon: 'lucideAlignCenter' },
    { value: 'right', label: 'Align right', icon: 'lucideAlignRight' },
    { value: 'justify', label: 'Justify text', icon: 'lucideAlignJustify' },
  ];
  readonly borderStyles = ['none', 'solid', 'dashed', 'dotted', 'double'];
  readonly textToggles: StyleToggle[] = [
    { icon: 'lucideBold', label: 'Toggle bold', key: 'fontWeight', on: '700', off: '400', mode: 'equals' },
    { icon: 'lucideItalic', label: 'Toggle italic', key: 'fontStyle', on: 'italic', off: 'normal', mode: 'equals' },
  ];
  readonly transformToggles: StyleToggle[] = [
    { icon: 'lucideCaseLower', label: 'Toggle lowercase', key: 'textTransform', on: 'lowercase', off: 'none', mode: 'equals' },
    { icon: 'lucideCaseUpper', label: 'Toggle uppercase', key: 'textTransform', on: 'uppercase', off: 'none', mode: 'equals' },
    { icon: 'lucideCaseSensitive', label: 'Toggle capitalize', key: 'textTransform', on: 'capitalize', off: 'none', mode: 'equals' },
  ];
  readonly decorationToggles: StyleToggle[] = [
    { icon: 'lucideUnderline', label: 'Toggle underline', key: 'textDecoration', on: 'underline', off: 'none', mode: 'includes' },
    { icon: 'lucideStrikethrough', label: 'Toggle strikethrough', key: 'textDecoration', on: 'line-through', off: 'none', mode: 'includes' },
  ];

  isToggleActive(toggle: StyleToggle, styles: EditableDesignStyles): boolean {
    const current = styles[toggle.key];
    return toggle.mode === 'includes'
      ? current.includes(toggle.on)
      : current === toggle.on;
  }

  onToggle(toggle: StyleToggle, styles: EditableDesignStyles): void {
    const next = this.isToggleActive(toggle, styles) ? toggle.off : toggle.on;
    this.onStyle(toggle.key, next);
  }

  onStyle(property: string, value: string): void {
    this.styleChange.emit({ property, value });
  }

  useSuggestion(suggestion: string): void {
    const current = this.instruction().trim();
    this.instructionChange.emit(current ? `${current} ${suggestion}` : suggestion);
  }

  onInstructionEnter(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (keyboard.shiftKey) return;
    keyboard.preventDefault();
    this.apply.emit();
  }
}
