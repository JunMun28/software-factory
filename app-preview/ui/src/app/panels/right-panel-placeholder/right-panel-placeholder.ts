import { Component } from '@angular/core';

@Component({
  selector: 'app-right-panel-placeholder',
  template: `
    <aside
      class="flex h-full w-96 shrink-0 flex-col border-l border-border bg-card text-card-foreground"
      data-panel="right"
    >
      <div class="border-b border-border px-4 py-4">
        <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Preview</p>
        <h2 class="text-sm font-semibold">Right panel</h2>
      </div>
      <div class="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Reserved for preview iframe and diff pane in upcoming issues.
      </div>
    </aside>
  `,
})
export class RightPanelPlaceholder {}
