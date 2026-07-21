import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePanelsTopLeft } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';

import { ChatService } from '../../services/chat.service';
import { PreviewService } from '../../services/preview.service';
import {
  isDesignBridgeEvent,
  type DesignElement,
  type DesignElementPatch,
  type DesignLayer,
} from './design-bridge';

@Component({
  selector: 'app-preview-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButton, NgIcon],
  providers: [provideIcons({ lucidePanelsTopLeft })],
  host: { '(window:message)': 'onWindowMessage($event)' },
  template: `
    <div class="flex h-full min-h-0 flex-col">
      <div class="relative flex flex-1 flex-col overflow-hidden">
        @if (previewService.status().status === 'failed') {
          <div
            data-preview-status="failed"
            class="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
            role="status"
            aria-live="assertive"
            aria-atomic="true"
          >
            <p class="text-sm text-destructive">
              {{ previewService.status().error ?? 'Preview failed to start.' }}
            </p>
            <button hlmBtn type="button" (click)="restartPreview()">Restart preview</button>
          </div>
        } @else if (!hasGeneratedPreview()) {
          <div
            data-testid="preview-placeholder"
            class="flex flex-1 flex-col items-center justify-center gap-3 bg-background p-6 text-center"
          >
            <span class="flex size-11 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground">
              <ng-icon name="lucidePanelsTopLeft" size="22" />
            </span>
            <p class="text-sm font-medium text-foreground">Your app will appear here</p>
            <p class="max-w-xs text-xs text-muted-foreground">The preview updates automatically as generated UI becomes available.</p>
          </div>
        } @else {
          @if (iframeSrc(); as src) {
            @if (previewService.status().status === 'ready') {
              <p data-preview-status="ready" class="sr-only" role="status" aria-live="polite">Preview ready.</p>
            }
            <!-- Scripts and same-origin support the design bridge; forms support generated app flows. -->
            <iframe
              #previewFrame
              class="h-full w-full border-0 bg-background"
              [src]="src"
              [title]="'Preview for chat ' + chatService.activeChatId()"
              sandbox="allow-scripts allow-forms allow-same-origin"
              (load)="syncDesignMode()"
            ></iframe>
            @if (previewService.status().status === 'starting') {
              <div
                data-preview-updating
                class="absolute inset-x-0 top-0 z-10 flex flex-col items-center justify-center gap-1.5 border-b border-border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <div class="flex items-center justify-center gap-2">
                  <div
                    class="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary"
                    aria-hidden="true"
                  ></div>
                  <span>Updating preview…</span>
                </div>
                @if (startingSlow()) {
                  <div class="flex flex-wrap items-center justify-center gap-2 text-center">
                    <span>The preview is taking longer than expected.</span>
                    <button hlmBtn type="button" (click)="restartPreview()">Restart preview</button>
                  </div>
                }
              </div>
            }
          } @else {
            <div
              data-preview-status="starting"
              class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <div
                class="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary"
                aria-hidden="true"
              ></div>
              <p>Starting preview…</p>
              @if (startingSlow()) {
                <p>The preview is taking longer than expected.</p>
                <button hlmBtn type="button" (click)="restartPreview()">Restart preview</button>
              }
            </div>
          }
        }
      </div>
    </div>
  `,
})
export class PreviewPanel {
  readonly chatService = inject(ChatService);
  readonly previewService = inject(PreviewService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly startingChatId = computed(() => {
    const chatId = this.chatService.activeChatId();
    const status = this.previewService.status().status;
    return chatId !== null && (status === 'starting' || status === 'stopped')
      ? chatId
      : null;
  });
  readonly startingSlow = signal(false);

  readonly iframeSrc = signal<SafeResourceUrl | null>(null);
  readonly hasGeneratedPreview = computed(() => {
    if ((this.chatService.activeChat()?.versions.length ?? 0) > 0) {
      return true;
    }
    return Object.keys(this.chatService.currentTurnTouchedFiles()).some((path) =>
      path.startsWith('frontend/src/'),
    );
  });
  readonly designMode = input(false);
  readonly designLayers = output<DesignLayer[]>();
  readonly designElementSelected = output<DesignElement>();
  private readonly previewFrame = viewChild<ElementRef<HTMLIFrameElement>>('previewFrame');

  constructor() {
    effect(() => {
      const chatId = this.chatService.activeChatId();
      if (chatId) {
        this.previewService.attach(chatId);
      } else {
        this.previewService.detach();
        this.iframeSrc.set(null);
      }
    });

    effect((onCleanup) => {
      if (this.startingChatId() === null) {
        this.startingSlow.set(false);
        return;
      }

      this.startingSlow.set(false);
      const timer = setTimeout(() => this.startingSlow.set(true), 30_000);
      onCleanup(() => clearTimeout(timer));
    });

    effect(() => {
      const status = this.previewService.status();
      const reloadTick = this.chatService.previewReloadTick();
      if (status.status === 'ready' && status.url) {
        const cacheBust = reloadTick > 0 ? `?ng-preview=${reloadTick}` : '';
        this.iframeSrc.set(
          this.sanitizer.bypassSecurityTrustResourceUrl(`${status.url}${cacheBust}`),
        );
      } else if (status.status !== 'starting') {
        this.iframeSrc.set(null);
      }
    });

    effect(() => {
      this.designMode();
      this.iframeSrc();
      queueMicrotask(() => this.syncDesignMode());
    });
  }

  onWindowMessage(event: MessageEvent): void {
    const iframe = this.previewFrame()?.nativeElement;
    const expectedOrigin = this.previewOrigin();
    if (
      !iframe ||
      event.source !== iframe.contentWindow ||
      (expectedOrigin !== null && event.origin !== expectedOrigin) ||
      !isDesignBridgeEvent(event.data)
    ) {
      return;
    }

    if (event.data.type === 'bridge-ready') {
      this.syncDesignMode();
    } else if (event.data.type === 'design-layers') {
      this.designLayers.emit(event.data.layers);
    } else if (event.data.type === 'element-selected') {
      this.designElementSelected.emit(event.data.element);
    }
  }

  syncDesignMode(): void {
    this.postToPreview({ type: 'design-mode', enabled: this.designMode() });
  }

  selectElement(selector: string): void {
    this.postToPreview({ type: 'select-element', selector });
  }

  hoverElement(selector: string | null): void {
    this.postToPreview({ type: 'hover-element', selector });
  }

  setElementVisibility(selector: string, visible: boolean): void {
    this.postToPreview({ type: 'set-element-visibility', selector, visible });
  }

  updateElement(selector: string, patch: DesignElementPatch): void {
    this.postToPreview({
      type: 'preview-element-update',
      selector,
      ...patch,
    });
  }

  private postToPreview(message: Record<string, unknown>): void {
    const contentWindow = this.previewFrame()?.nativeElement.contentWindow;
    const targetOrigin = this.previewOrigin();
    if (!contentWindow || !targetOrigin) {
      return;
    }
    contentWindow.postMessage({ source: 'ng-v0', ...message }, targetOrigin);
  }

  // The preview iframe only ever shows the chat's own preview server, so its
  // origin is whatever previewService currently reports -- used to gate both
  // directions of postMessage instead of '*'.
  private previewOrigin(): string | null {
    const url = this.previewService.status().url;
    if (!url) {
      return null;
    }
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  statusDotClass(): string {
    switch (this.previewService.status().status) {
      case 'ready':
        return 'bg-emerald-500';
      case 'starting':
        return 'bg-amber-400';
      case 'failed':
        return 'bg-destructive';
      default:
        return 'bg-muted-foreground/40';
    }
  }

  restartPreview(): void {
    void this.previewService.restart();
  }
}
