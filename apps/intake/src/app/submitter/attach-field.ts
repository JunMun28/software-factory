import { Component, ElementRef, inject, input, signal, viewChild } from '@angular/core';

import { Api, Icon } from '@sf/shared';
import { IntakeDraft } from './intake-draft.service';

/** Reusable attachment uploader — drag/drop + paste + browse, with removable chips.
 *  Reads/writes the shared IntakeDraft so pending (pre-requestId) and uploaded
 *  files render together. `zone` renders a full drop zone; the default is the
 *  compact button row (drop and paste work in both). (ADR 0022) */
@Component({
  selector: 'sf-attach-field',
  imports: [Icon],
  template: `
    <div
      class="attach"
      (dragover)="$event.preventDefault(); dragging.set(true)"
      (dragleave)="dragging.set(false)"
      (drop)="onDrop($event)"
      (paste)="onPaste($event)"
    >
      @if (zone()) {
        <button
          type="button"
          class="zone focusable"
          [class.zone--over]="dragging()"
          (click)="picker().nativeElement.click()"
        >
          <span class="zone__t">Drag &amp; drop files here, or <u>browse</u></span>
          <span class="zone__h">any file type · up to 5 · 100 MB each</span>
        </button>
      } @else {
        <button
          type="button"
          class="attach__btn focusable"
          (click)="picker().nativeElement.click()"
        >
          <sf-icon name="plus" [size]="14" /> Attach files
        </button>
        <span class="attach__hint">any file type · up to 5 · 100 MB each</span>
      }
      <input #fileInput type="file" multiple hidden (change)="onPick($event)" />

      @if (draft.attachments().length || draft.pending().length) {
        <div class="attach__chips">
          @for (a of draft.attachments(); track a.id) {
            <span class="attach__chip" [class.attach__chip--img]="a.kind === 'image'">
              @if (a.kind === 'image') {
                <img class="attach__thumb" [src]="api.attachmentRawUrl(a.id)" alt="" />
              } @else {
                <sf-icon name="app" [size]="14" color="var(--muted)" />
              }
              <span class="attach__name">{{ a.filename }}</span>
              <button
                type="button"
                class="attach__x"
                (click)="draft.removeAttachment(a.id)"
                aria-label="Remove"
              >
                <sf-icon name="x" [size]="12" />
              </button>
            </span>
          }
          @for (f of draft.pending(); track $index) {
            <span class="attach__chip attach__chip--pending">
              <sf-icon name="clock" [size]="13" color="var(--faint)" />
              <span class="attach__name">{{ f.name }}</span>
              <button
                type="button"
                class="attach__x"
                (click)="draft.removePending($index)"
                aria-label="Remove"
              >
                <sf-icon name="x" [size]="12" />
              </button>
            </span>
          }
        </div>
      }
      @if (draft.lastError()) {
        <p class="attach__err">{{ draft.lastError() }}</p>
      }
    </div>
  `,
  styles: `
    .zone {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      width: 100%;
      padding: 24px 16px;
      border: 1.5px dashed var(--border-strong);
      border-radius: 10px;
      background: var(--surface);
      cursor: pointer;
      font-family: var(--body);
      color: var(--fg2);
      transition:
        border-color var(--dur) var(--ease),
        background var(--dur) var(--ease),
        color var(--dur) var(--ease);
    }
    .zone:hover,
    .zone--over {
      border-color: var(--a400);
      background: var(--surface-2);
      color: var(--accent-tx);
    }
    .zone__t {
      font-size: 13.5px;
      font-weight: 500;
    }
    .zone__t u {
      text-underline-offset: 3px;
    }
    .zone__h {
      font-size: 12px;
      color: var(--faint);
    }
  `,
})
export class AttachField {
  draft = inject(IntakeDraft);
  api = inject(Api);
  source = input<'describe' | 'interview'>('describe');
  /** full-width drop zone instead of the compact button row */
  zone = input(false);
  picker = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
  dragging = signal(false);

  onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) this.draft.addFiles(Array.from(input.files), this.source());
    input.value = '';
  }
  onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragging.set(false);
    if (e.dataTransfer?.files.length)
      this.draft.addFiles(Array.from(e.dataTransfer.files), this.source());
  }
  onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) this.draft.addFiles(files, this.source());
  }
}
