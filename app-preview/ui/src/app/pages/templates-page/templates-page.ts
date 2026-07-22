import { Component, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBot,
  lucideBox,
  lucideGamepad2,
  lucideLayoutDashboard,
  lucideLayoutTemplate,
  lucideSearch,
  lucideShoppingBag,
  lucideSparkles,
} from '@ng-icons/lucide';
import { RouterLink } from '@angular/router';

const CATEGORIES = [
  { label: 'Apps & Games', icon: 'lucideGamepad2' },
  { label: 'Landing Pages', icon: 'lucideLayoutTemplate' },
  { label: 'Dashboards', icon: 'lucideLayoutDashboard' },
  { label: 'Components', icon: 'lucideBox' },
  { label: 'E-commerce', icon: 'lucideShoppingBag' },
  { label: 'AI', icon: 'lucideBot' },
];

const FEATURED = ['Analytics command center', 'AI landing page', 'Reading dashboard'];

@Component({
  selector: 'app-templates-page',
  imports: [NgIcon, RouterLink],
  providers: [
    provideIcons({
      lucideBot,
      lucideBox,
      lucideGamepad2,
      lucideLayoutDashboard,
      lucideLayoutTemplate,
      lucideSearch,
      lucideShoppingBag,
      lucideSparkles,
    }),
  ],
  template: `
    <div class="min-h-dvh bg-background text-foreground">
      <header class="flex h-14 items-center justify-between border-b border-border px-5">
        <a routerLink="/" class="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-medium hover:bg-muted">New Chat</a>
        <span class="text-sm text-muted-foreground">Dana Reyes</span>
      </header>

      <div class="border-b border-border">
        <div class="mx-auto flex h-14 max-w-[1200px] items-center gap-6 px-6">
          <span class="text-lg font-semibold">Community</span>
          <nav class="flex h-full items-center gap-5 text-sm" role="tablist" aria-label="Template collections">
            <button
              type="button"
              role="tab"
              aria-label="Community Templates"
              [attr.aria-selected]="activeCollection() === 'community'"
              class="flex h-full items-center border-b-2"
              [class.border-foreground]="activeCollection() === 'community'"
              [class.border-transparent]="activeCollection() !== 'community'"
              [class.text-muted-foreground]="activeCollection() !== 'community'"
              (click)="activeCollection.set('community')"
            >
              Community Templates
            </button>
            <button
              type="button"
              role="tab"
              aria-label="Your Templates"
              [attr.aria-selected]="activeCollection() === 'yours'"
              class="flex h-full items-center border-b-2"
              [class.border-foreground]="activeCollection() === 'yours'"
              [class.border-transparent]="activeCollection() !== 'yours'"
              [class.text-muted-foreground]="activeCollection() !== 'yours'"
              (click)="activeCollection.set('yours')"
            >
              Your Templates
            </button>
          </nav>
        </div>
      </div>

      @if (activeCollection() === 'community') {
        <main class="mx-auto w-full max-w-[1200px] px-6 py-12 max-sm:px-4">
          <h1 class="text-4xl font-semibold tracking-tight">Community Templates</h1>
          <p class="mt-2 text-muted-foreground">Community templates are not available yet. The examples below are previews of planned categories.</p>
          <label class="mt-7 flex h-10 max-w-xl cursor-not-allowed items-center gap-2 rounded-md border border-border bg-card px-3 opacity-60">
            <ng-icon class="text-muted-foreground" name="lucideSearch" size="16" />
            <span class="sr-only">Search templates — coming soon</span>
            <input
              class="min-w-0 flex-1 cursor-not-allowed bg-transparent text-sm outline-none"
              aria-label="Search templates — coming soon"
              title="Search templates — coming soon"
              placeholder="Search coming soon"
              disabled
            />
          </label>

          <div class="mt-12 flex items-center justify-between"><h2 class="text-lg font-semibold">Categories</h2><span class="text-sm text-muted-foreground">Coming soon</span></div>
          <div class="mt-4 grid grid-cols-6 gap-3 max-lg:grid-cols-3 max-sm:grid-cols-2">
            @for (category of categories; track category.label) {
              <article data-template-card aria-disabled="true" [title]="category.label + ' templates — coming soon'" class="rounded-lg border border-border bg-card p-4 opacity-75">
                <span class="flex size-10 items-center justify-center rounded-md bg-muted"><ng-icon [name]="category.icon" size="20" /></span>
                <p class="mt-5 text-sm font-medium">{{ category.label }}</p>
                <p class="mt-1 text-xs text-muted-foreground">Coming soon</p>
              </article>
            }
          </div>

          <h2 class="mt-12 text-lg font-semibold">Featured Templates</h2>
          <div class="mt-4 grid grid-cols-3 gap-5 max-md:grid-cols-1">
            @for (template of featured; track template) {
              <article data-template-card aria-disabled="true" [title]="template + ' — coming soon'" class="overflow-hidden rounded-lg border border-border bg-card opacity-75">
                <div class="flex aspect-[16/10] items-center justify-center bg-muted/30 text-muted-foreground"><ng-icon name="lucideSparkles" size="32" /></div>
                <div class="p-4"><h3 class="text-sm font-medium">{{ template }}</h3><p class="mt-1 text-xs text-muted-foreground">Coming soon</p></div>
              </article>
            }
          </div>
        </main>
      } @else {
        <main class="mx-auto flex min-h-[calc(100dvh-7rem)] w-full max-w-[1200px] items-center justify-center px-6 py-12 text-center max-sm:px-4">
          <div class="max-w-md rounded-lg border border-dashed border-border px-10 py-14">
            <ng-icon class="text-muted-foreground" name="lucideLayoutTemplate" size="32" />
            <h1 class="mt-4 text-xl font-semibold">You have no templates yet</h1>
            <p class="mt-2 text-sm text-muted-foreground">Personal templates are not available yet.</p>
          </div>
        </main>
      }
    </div>
  `,
})
export class TemplatesPage {
  readonly categories = CATEGORIES;
  readonly featured = FEATURED;
  readonly activeCollection = signal<'community' | 'yours'>('community');
}
