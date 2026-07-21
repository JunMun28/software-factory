import { Component } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideShapes } from '@ng-icons/lucide';

@Component({
  selector: 'app-design-systems-page',
  imports: [NgIcon],
  providers: [provideIcons({ lucideShapes })],
  template: `
    <section class="mx-auto min-h-full w-full max-w-[1160px] px-8 py-10 max-sm:px-4 max-sm:py-6">
      <h1 class="text-3xl font-semibold tracking-tight">Design Systems</h1>
      <div class="mt-8 flex min-h-72 items-center justify-center rounded-lg border border-dashed border-border px-6 text-center text-muted-foreground">
        <div class="max-w-md">
          <ng-icon name="lucideShapes" size="30" />
          <h2 class="mt-4 text-base font-medium text-foreground">Design Systems are not available yet</h2>
          <p class="mt-2 text-sm">Reusable tokens and component libraries are planned for a future release.</p>
        </div>
      </div>
    </section>
  `,
})
export class DesignSystemsPage {}
