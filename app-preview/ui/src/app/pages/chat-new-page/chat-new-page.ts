import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCircleAlert, lucideLoaderCircle } from '@ng-icons/lucide';

import { ChatService } from '../../services/chat.service';

/**
 * `/chats/new?seed=<rid>&url=<git-url>&ref=<sha>` — the ng-v0 bridge landing
 * (docs/design/ng-v0-bridge.md, "UX"). Reads the factory's seed params, asks the
 * orchestrator to clone a fresh chat from that repo state, and drops the user
 * straight into the chat. A red seed gate comes back as 422; we show its output
 * in a readable error state rather than spinning forever.
 */
@Component({
  selector: 'app-chat-new-page',
  imports: [NgIcon, RouterLink],
  providers: [provideIcons({ lucideCircleAlert, lucideLoaderCircle })],
  template: `
    <section
      class="mx-auto flex min-h-full w-full max-w-[720px] flex-col items-center justify-center px-8 py-16 text-center max-sm:px-4"
    >
      @if (state() === 'creating') {
        <ng-icon
          class="animate-spin text-muted-foreground"
          name="lucideLoaderCircle"
          size="28"
        />
        <h1 class="mt-5 text-lg font-semibold tracking-tight">Setting up your editor…</h1>
        <p class="mt-2 text-sm text-muted-foreground">
          @if (rid()) {
            Cloning {{ rid() }} and checking it builds before your first turn.
          } @else {
            Cloning the app and checking it builds before your first turn.
          }
        </p>
      } @else {
        <div
          class="w-full rounded-lg border border-red-500/30 bg-red-500/10 text-left"
          role="status"
          aria-live="assertive"
        >
          <div class="flex items-center gap-2 px-4 py-3 text-sm font-medium text-red-700 dark:text-red-200">
            <ng-icon name="lucideCircleAlert" size="16" />
            <span>{{ headline() }}</span>
          </div>
          @if (gateOutput()) {
            <pre
              class="max-h-80 overflow-auto border-t border-red-500/20 px-4 py-3 text-xs text-red-800 dark:text-red-100"
              >{{ gateOutput() }}</pre
            >
          } @else if (detail()) {
            <p class="border-t border-red-500/20 px-4 py-3 text-xs text-red-800 dark:text-red-100">
              {{ detail() }}
            </p>
          }
        </div>
        <a
          [routerLink]="['/chats']"
          class="mt-6 inline-flex h-9 items-center rounded-md border border-border bg-card px-4 text-sm font-medium hover:bg-muted/40"
        >
          Back to chats
        </a>
      }
    </section>
  `,
})
export class ChatNewPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly chatService = inject(ChatService);

  readonly state = signal<'creating' | 'error'>('creating');
  readonly rid = signal<string>('');
  readonly headline = signal<string>('Something went wrong');
  readonly detail = signal<string | null>(null);
  readonly gateOutput = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    const rid = params.get('seed')?.trim() ?? '';
    const url = params.get('url')?.trim() ?? '';
    const ref = params.get('ref')?.trim() ?? '';
    this.rid.set(rid);

    if (!url || !ref) {
      this.fail('This editor link is missing its source. Open it again from the factory preview.');
      return;
    }

    const result = await this.chatService.createSeededChat({
      title: rid ? `${rid} preview edits` : 'Preview edits',
      seed: { kind: 'git', url, ref },
    });

    if ('chatId' in result) {
      await this.router.navigate(['/chats', result.chatId]);
      return;
    }
    // A red seed gate: the cloned app doesn't build. Show the output so the
    // requester knows what to fix — never leave them on a spinner.
    if (result.gateOutput) {
      this.headline.set("This preview doesn't build yet — nothing to edit.");
      this.gateOutput.set(result.gateOutput);
      this.state.set('error');
      return;
    }
    this.fail(result.error);
  }

  private fail(message: string): void {
    this.headline.set("Couldn't open the editor");
    this.detail.set(message);
    this.state.set('error');
  }
}
