import { Component, ElementRef, inject, input, viewChild } from '@angular/core';

import { Api, Icon } from '@sf/shared';
import { IntakeDraft } from './intake-draft.service';

/** Reusable attachment uploader — button + drag/drop + paste, with removable chips.
 *  Reads/writes the shared IntakeDraft so pending (pre-requestId) and uploaded
 *  files render together. (ADR 0022) */
@Component({
  selector: 'sf-attach-field',
  imports: [Icon],
  template: `
    <div
      class="attach"
      (dragover)="$event.preventDefault()"
      (drop)="onDrop($event)"
      (paste)="onPaste($event)"
    >
      <button type="button" class="attach__btn focusable" (click)="picker().nativeElement.click()">
        <sf-icon name="plus" [size]="14" /> Attach files
      </button>
      <span class="attach__hint">images, logs, PDF/Word/Excel · up to 5 · 10 MB each</span>
      <input
        #fileInput
        type="file"
        multiple
        accept=".png,.jpg,.jpeg,.gif,.webp,.txt,.log,.md,.csv,.pdf,.docx,.xlsx"
        hidden
        (change)="onPick($event)"
      />

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
})
export class AttachField {
  draft = inject(IntakeDraft);
  api = inject(Api);
  source = input<'describe' | 'interview'>('describe');
  picker = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) this.draft.addFiles(Array.from(input.files), this.source());
    input.value = '';
  }
  onDrop(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer?.files.length)
      this.draft.addFiles(Array.from(e.dataTransfer.files), this.source());
  }
  onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) this.draft.addFiles(files, this.source());
  }
}
