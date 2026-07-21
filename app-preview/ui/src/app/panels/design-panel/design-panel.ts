import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUp,
  lucideBox,
  lucideChevronRight,
  lucideEye,
  lucideEyeOff,
  lucideLayers3,
  lucideMousePointer2,
  lucidePanelRightClose,
  lucidePanelRightOpen,
  lucideSparkles,
} from '@ng-icons/lucide';

import { ChatService } from '../../services/chat.service';
import type {
  DesignElement,
  DesignLayer,
} from '../preview-panel/design-bridge';
import { PreviewPanel } from '../preview-panel/preview-panel';
import { DesignDetails } from './design-details';
import {
  buildDesignAnnotationPrompt,
  buildDesignPrompt,
  createDesignDraft,
  diffDesignDraft,
  hasDesignChanges,
  type DesignDraft,
  type EditableDesignStyles,
} from './design-draft';

@Component({
  selector: 'app-design-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, PreviewPanel, DesignDetails],
  providers: [
    provideIcons({
      lucideArrowUp,
      lucideBox,
      lucideChevronRight,
      lucideEye,
      lucideEyeOff,
      lucideLayers3,
      lucideMousePointer2,
      lucidePanelRightClose,
      lucidePanelRightOpen,
      lucideSparkles,
    }),
  ],
  template: `
    <div class="design-layout grid h-full min-h-0 bg-background" [class.details-open]="detailsOpen()">
      <aside class="min-h-0 overflow-y-auto border-r border-border bg-card max-md:hidden">
        <div class="flex h-10 items-center gap-2 border-b border-border px-3 text-xs font-medium">
          <ng-icon name="lucideLayers3" size="14" />
          <span>Layers</span>
          <button
            data-testid="toggle-design-details"
            type="button"
            class="workspace-icon-button ml-auto h-7 w-7"
            [attr.aria-label]="detailsOpen() ? 'Hide design details' : 'Show design details'"
            [attr.aria-expanded]="detailsOpen()"
            (click)="toggleDetails()"
          >
            <ng-icon [name]="detailsOpen() ? 'lucidePanelRightClose' : 'lucidePanelRightOpen'" size="14" />
          </button>
        </div>
        <div class="p-2">
          @if (layers().length === 0) {
            <p class="px-2 py-6 text-center text-xs leading-relaxed text-muted-foreground">
              Click an element in the preview to inspect it.
            </p>
          }
          @for (layer of layers(); track layer.selector) {
            <div
              data-testid="design-layer-row"
              class="flex h-7 items-center rounded text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              [class.bg-muted]="selectedElement()?.selector === layer.selector"
              [class.text-foreground]="selectedElement()?.selector === layer.selector"
              [style.padding-left.px]="6 + layer.depth * 10"
              (mouseenter)="hoverLayer(layer)"
              (mouseleave)="clearLayerHover()"
            >
              <button
                type="button"
                data-design-layer
                [attr.aria-current]="selectedElement()?.selector === layer.selector ? 'true' : null"
                class="flex min-w-0 flex-1 items-center gap-1 text-left"
                (click)="selectLayer(layer)"
              >
                <ng-icon name="lucideChevronRight" size="11" />
                <ng-icon name="lucideBox" size="12" />
                <span class="min-w-0 flex-1 truncate">{{ layer.label }}</span>
                <span class="font-mono text-[10px] text-muted-foreground">{{ layer.tag }}</span>
              </button>
              <button
                type="button"
                class="workspace-icon-button h-6 w-6 shrink-0"
                [attr.aria-label]="'Toggle ' + layer.label + ' visibility'"
                (click)="toggleVisibility(layer)"
              >
                <ng-icon [name]="isVisible(layer.selector) ? 'lucideEye' : 'lucideEyeOff'" size="11" />
              </button>
            </div>
          }
        </div>
      </aside>

      <div #previewSurface class="relative min-h-0 overflow-hidden bg-background">
        <app-preview-panel
          [designMode]="true"
          (designLayers)="handleLayers($event)"
          (designElementSelected)="handleElementSelected($event)"
        />

        @if (annotationOpen() && selectedElement(); as selected) {
          <section
            data-testid="annotation-popover"
            role="dialog"
            aria-label="Add comment to selected element"
            class="absolute z-20 w-[360px] max-w-[calc(100%-24px)] text-foreground"
            [style.left.px]="annotationPosition().left"
            [style.top.px]="annotationPosition().top"
            (keydown)="onAnnotationKeydown($event)"
          >
            <div
              data-testid="annotation-command-bar"
              class="flex h-11 items-center gap-1 rounded-full border border-border bg-card p-1 pl-2.5 shadow-lg"
            >
              <ng-icon class="shrink-0 text-muted-foreground" name="lucideMousePointer2" size="13" />
              <span data-testid="annotation-element-tag" class="shrink-0 font-mono text-xs text-muted-foreground">{{ selected.tag }}</span>
              <input
                #annotationInput
                autofocus
                autocomplete="off"
                aria-label="Comment on selected element"
                class="h-8 min-w-0 flex-1 bg-transparent px-1 text-xs text-foreground outline-none placeholder:text-muted-foreground"
                placeholder="Describe the change"
                [value]="annotationText()"
                (input)="annotationText.set(($any($event.target)).value)"
              />
              <button
                data-testid="toggle-annotation-suggestions"
                type="button"
                class="workspace-icon-button h-8 w-8 shrink-0 rounded-full"
                [attr.aria-label]="annotationSuggestionsOpen() ? 'Hide instruction shortcuts' : 'Show instruction shortcuts'"
                [attr.aria-expanded]="annotationSuggestionsOpen()"
                (click)="toggleAnnotationSuggestions()"
              >
                <ng-icon name="lucideSparkles" size="13" />
              </button>
              <button
                data-testid="add-annotation"
                type="button"
                aria-label="Add comment"
                class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40"
                [disabled]="!canSubmitAnnotation()"
                (click)="submitAnnotation()"
              >
                <ng-icon name="lucideArrowUp" size="14" />
              </button>
            </div>
            @if (annotationSuggestionsOpen()) {
              <div data-testid="annotation-instructions" class="mt-1.5 flex flex-wrap gap-1 rounded-xl border border-border bg-card p-1.5 shadow-lg">
                <span class="sr-only">Instructions</span>
                @for (suggestion of suggestions; track suggestion) {
                  <button
                    data-testid="annotation-suggestion"
                    type="button"
                    class="rounded border border-border px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    (click)="useAnnotationSuggestion(suggestion)"
                  >
                    {{ suggestion }}
                  </button>
                }
              </div>
            }
          </section>
        }

        @if (!selectedElement()) {
          <div
            data-testid="design-mode-hint"
            class="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md border border-border bg-card/95 px-3 py-1.5 text-[11px] text-muted-foreground shadow-sm"
          >
            <ng-icon name="lucideMousePointer2" size="13" />
            Hover to inspect, click to comment
          </div>
        }
      </div>

      @if (detailsOpen()) {
        <app-design-details
          [selected]="selectedElement()"
          [draft]="draft()"
          [instruction]="instruction()"
          [pending]="pending()"
          [draftChanged]="draftChanged()"
          [turnRunning]="chatService.turnRunning()"
          [suggestions]="suggestions"
          (textChange)="updateText($event)"
          (styleChange)="updateStyle($event.property, $event.value)"
          (instructionChange)="instruction.set($event)"
          (apply)="applyChanges()"
          (reset)="resetDraft()"
        />
      }
    </div>
  `,
  styles: `
    .design-layout {
      grid-template-columns: 220px minmax(0, 1fr);
    }
    .design-layout.details-open {
      grid-template-columns: 220px minmax(0, 1fr) 300px;
    }
    @media (max-width: 1280px) {
      .design-layout {
        grid-template-columns: 190px minmax(0, 1fr);
      }
      .design-layout.details-open {
        grid-template-columns: 190px minmax(0, 1fr) 270px;
      }
    }
    @media (max-width: 768px) {
      .design-layout,
      .design-layout.details-open {
        display: block;
      }
    }
  `,
})
export class DesignPanel {
  readonly chatService = inject(ChatService);
  private readonly preview = viewChild(PreviewPanel);
  private readonly previewSurface = viewChild<ElementRef<HTMLElement>>('previewSurface');
  private readonly annotationInput = viewChild<ElementRef<HTMLInputElement>>('annotationInput');

  readonly layers = signal<DesignLayer[]>([]);
  readonly selectedElement = signal<DesignElement | null>(null);
  readonly originalDraft = signal<DesignDraft | null>(null);
  readonly draft = signal<DesignDraft | null>(null);
  readonly visibility = signal<Record<string, boolean>>({});
  readonly instruction = signal('');
  readonly annotationOpen = signal(false);
  readonly annotationText = signal('');
  readonly annotationSuggestionsOpen = signal(false);
  readonly annotationPosition = signal({ left: 12, top: 12 });
  readonly detailsOpen = signal(false);
  readonly suggestions = ['/modern', '/contrast', '/spacious', '/simplify', '/readable'];
  readonly pending = computed(() => {
    const original = this.originalDraft();
    const current = this.draft();
    return Boolean(
      original &&
        current &&
        hasDesignChanges(original, current, this.instruction()),
    );
  });
  readonly draftChanged = computed(() => {
    const original = this.originalDraft();
    const current = this.draft();
    return Boolean(original && current && hasDesignChanges(original, current, ''));
  });
  readonly canSubmitAnnotation = computed(
    () =>
      Boolean(this.chatService.activeChatId()) &&
      Boolean(this.selectedElement()) &&
      this.annotationText().trim().length > 0 &&
      !this.chatService.turnRunning(),
  );

  toggleDetails(): void {
    this.detailsOpen.update((open) => !open);
    const selected = this.selectedElement();
    if (selected && this.annotationOpen()) {
      setTimeout(() => this.positionAnnotation(selected));
    }
  }

  handleLayers(layers: DesignLayer[]): void {
    this.layers.set(layers);
  }

  handleElementSelected(element: DesignElement): void {
    const nextDraft = createDesignDraft(element);
    this.selectedElement.set(element);
    this.originalDraft.set(nextDraft);
    this.draft.set(cloneDraft(nextDraft));
    this.instruction.set('');
    this.annotationText.set('');
    this.annotationSuggestionsOpen.set(false);
    this.annotationOpen.set(true);
    this.positionAnnotation(element);
    setTimeout(() => this.annotationInput()?.nativeElement.focus());
  }

  closeAnnotation(): void {
    this.annotationOpen.set(false);
    this.annotationText.set('');
    this.annotationSuggestionsOpen.set(false);
  }

  toggleAnnotationSuggestions(): void {
    this.annotationSuggestionsOpen.update((open) => !open);
    queueMicrotask(() => this.annotationInput()?.nativeElement.focus());
  }

  useAnnotationSuggestion(suggestion: string): void {
    const current = this.annotationText().trim();
    this.annotationText.set(current ? `${current} ${suggestion}` : suggestion);
    queueMicrotask(() => this.annotationInput()?.nativeElement.focus());
  }

  onAnnotationKeydown(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key === 'Escape') {
      keyboard.preventDefault();
      this.closeAnnotation();
      return;
    }
    if (
      keyboard.key === 'Enter' &&
      keyboard.target === this.annotationInput()?.nativeElement
    ) {
      keyboard.preventDefault();
      this.submitAnnotation();
    }
  }

  submitAnnotation(): void {
    const chatId = this.chatService.activeChatId();
    const selected = this.selectedElement();
    const comment = this.annotationText().trim();
    if (!chatId || !selected || !comment || this.chatService.turnRunning()) {
      return;
    }

    const prompt = buildDesignAnnotationPrompt(selected, comment);
    this.annotationOpen.set(false);
    this.annotationText.set('');
    this.annotationSuggestionsOpen.set(false);
    void this.chatService.sendTurn(chatId, prompt);
  }

  private positionAnnotation(element: DesignElement): void {
    const surface = this.previewSurface()?.nativeElement;
    const surfaceWidth = surface?.clientWidth || 800;
    const surfaceHeight = surface?.clientHeight || 600;
    const popoverWidth = Math.min(360, surfaceWidth - 24);
    const popoverHeight = 88;
    const edge = 12;
    const gap = 12;
    const rect = element.rect ?? { x: edge, y: edge, width: 0, height: 0 };
    const left = rect.x + (rect.width - popoverWidth) / 2;
    const below = rect.y + rect.height + gap;
    const top = below + popoverHeight <= surfaceHeight - edge
      ? below
      : rect.y - popoverHeight - gap;

    this.annotationPosition.set({
      left: Math.max(edge, Math.min(left, surfaceWidth - popoverWidth - edge)),
      top: Math.max(
        edge,
        Math.min(top, surfaceHeight - popoverHeight - edge),
      ),
    });
  }

  selectLayer(layer: DesignLayer): void {
    this.preview()?.selectElement(layer.selector);
  }

  hoverLayer(layer: DesignLayer): void {
    this.preview()?.hoverElement(layer.selector);
  }

  clearLayerHover(): void {
    this.preview()?.hoverElement(null);
  }

  isVisible(selector: string): boolean {
    return this.visibility()[selector] ?? true;
  }

  toggleVisibility(layer: DesignLayer): void {
    const visible = !this.isVisible(layer.selector);
    this.visibility.update((state) => ({ ...state, [layer.selector]: visible }));
    this.preview()?.setElementVisibility(layer.selector, visible);
  }

  updateText(value: string): void {
    const selected = this.selectedElement();
    if (!selected) return;
    this.draft.update((current) => (current ? { ...current, text: value } : current));
    this.preview()?.updateElement(selected.selector, { text: value });
  }

  updateStyle(property: string, value: string): void {
    const selected = this.selectedElement();
    const key = property as keyof EditableDesignStyles;
    if (!selected || !this.draft()?.styles || !(key in this.draft()!.styles)) return;
    this.draft.update((current) =>
      current
        ? { ...current, styles: { ...current.styles, [key]: value } }
        : current,
    );
    this.preview()?.updateElement(selected.selector, { styles: { [key]: value } });
  }

  resetDraft(): void {
    const selected = this.selectedElement();
    const original = this.originalDraft();
    const current = this.draft();
    if (!selected || !original || !current) return;
    const revert = diffDesignDraft(current, original);
    const reset = cloneDraft(original);
    this.draft.set(reset);
    this.instruction.set('');
    this.preview()?.updateElement(selected.selector, {
      ...(revert.text !== undefined ? { text: revert.text } : {}),
      ...(Object.keys(revert.styles).length > 0 ? { styles: revert.styles } : {}),
    });
  }

  applyChanges(): void {
    const chatId = this.chatService.activeChatId();
    const selected = this.selectedElement();
    const original = this.originalDraft();
    const current = this.draft();
    if (
      !chatId ||
      !selected ||
      !original ||
      !current ||
      !this.pending() ||
      this.chatService.turnRunning()
    ) {
      return;
    }

    const prompt = buildDesignPrompt(
      selected,
      original,
      current,
      this.instruction(),
    );
    this.originalDraft.set(cloneDraft(current));
    this.instruction.set('');
    void this.chatService.sendTurn(chatId, prompt);
  }
}

function cloneDraft(draft: DesignDraft): DesignDraft {
  return { text: draft.text, styles: { ...draft.styles } };
}
