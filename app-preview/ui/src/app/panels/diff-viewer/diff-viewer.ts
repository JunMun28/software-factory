import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { parseUnifiedDiff } from '../../lib/unified-diff-parser';

@Component({
  selector: 'app-diff-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (parsedDiff().length === 0) {
      <p class="text-xs text-muted-foreground">No textual changes in this file.</p>
    } @else {
      <div class="overflow-x-auto rounded-md border border-border font-mono text-[11px] leading-5">
        @for (hunk of parsedDiff(); track hunk.header) {
          <div class="border-b border-border/60 px-2 py-1 text-muted-foreground">
            {{ hunk.header }}
          </div>
          @for (line of hunk.lines; track $index) {
            @switch (line.kind) {
              @case ('add') {
                <div class="grid grid-cols-[3rem_minmax(0,1fr)] bg-emerald-500/15">
                  <span class="select-none px-2 text-right text-muted-foreground">{{
                    line.newLineNumber
                  }}</span>
                  <span class="whitespace-pre px-2">+{{ line.content }}</span>
                </div>
              }
              @case ('remove') {
                <div class="grid grid-cols-[3rem_minmax(0,1fr)] bg-destructive/15">
                  <span class="select-none px-2 text-right text-muted-foreground">{{
                    line.oldLineNumber
                  }}</span>
                  <span class="whitespace-pre px-2">-{{ line.content }}</span>
                </div>
              }
              @case ('meta') {
                <div class="px-2 py-0.5 text-muted-foreground">{{ line.content }}</div>
              }
              @default {
                <div class="grid grid-cols-[3rem_minmax(0,1fr)]">
                  <span class="select-none px-2 text-right text-muted-foreground">{{
                    line.newLineNumber ?? line.oldLineNumber
                  }}</span>
                  <span class="whitespace-pre px-2"> {{ line.content }}</span>
                </div>
              }
            }
          }
        }
      </div>
    }
  `,
})
export class DiffViewer {
  readonly diff = input.required<string>();
  readonly parsedDiff = computed(() => parseUnifiedDiff(this.diff()));
}
