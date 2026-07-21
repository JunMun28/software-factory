import { DatePipe, JsonPipe, NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideChevronRight,
  lucideCircleAlert,
  lucideCircleCheck,
  lucideClock,
  lucideFileCode2,
  lucideGitCommitHorizontal,
  lucideLoaderCircle,
  lucideMousePointer2,
  lucideRotateCcw,
  lucideSearch,
  lucideSparkles,
  lucideTerminal,
  lucideZap,
} from '@ng-icons/lucide';

import {
  activityRows,
  basename,
  parseDesignAnnotationPrompt,
  shortSha,
  turnDuration,
  type ActivityRow,
  type TurnState,
} from '../../models/turn';
import type { ChatVersion } from '../../types/orchestrator-events';

const PROMPT_CLAMP_LINES = 6;
const PROMPT_CLAMP_CHARS = 480;

const ROW_ICONS: Record<ActivityRow['icon'], string> = {
  file: 'lucideFileCode2',
  gate: 'lucideCircleCheck',
  terminal: 'lucideTerminal',
  search: 'lucideSearch',
  spark: 'lucideSparkles',
};

@Component({
  selector: 'app-turn-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, JsonPipe, NgTemplateOutlet, NgIcon],
  providers: [
    provideIcons({
      lucideChevronDown,
      lucideChevronRight,
      lucideCircleAlert,
      lucideCircleCheck,
      lucideClock,
      lucideFileCode2,
      lucideGitCommitHorizontal,
      lucideLoaderCircle,
      lucideMousePointer2,
      lucideRotateCcw,
      lucideSearch,
      lucideSparkles,
      lucideTerminal,
      lucideZap,
    }),
  ],
  template: `
    <article class="space-y-4 py-2 text-card-foreground">
      @if (annotationPresentation(); as annotation) {
        <div data-user-prompt class="ml-auto flex w-fit max-w-[90%] flex-col items-end gap-2">
          <p
            data-annotation-comment
            class="whitespace-pre-wrap rounded-2xl bg-muted px-3 py-2 text-sm leading-relaxed"
          >
            {{ annotation.comment }}
          </p>
          <span
            data-annotation-element
            [title]="annotation.selector"
            class="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px] text-muted-foreground"
          >
            <ng-icon class="shrink-0" name="lucideMousePointer2" size="12" />
            <span class="min-w-0 truncate"
              >&lt;{{ annotation.tag }}&gt;{{
                annotation.elementLabel ? ' ' + annotation.elementLabel : ''
              }}</span
            >
          </span>
        </div>
      } @else {
        <div class="ml-auto flex w-fit max-w-[90%] flex-col items-end gap-1">
          <p
            data-user-prompt
            class="w-full whitespace-pre-wrap rounded-2xl bg-muted px-3 py-2 text-sm leading-relaxed"
            [class.line-clamp-6]="promptClamped()"
          >
            {{ turn().prompt }}
          </p>
          @if (promptNeedsClamp()) {
            <button
              type="button"
              data-prompt-toggle
              class="rounded px-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              (click)="promptExpanded.set(!promptExpanded())"
            >
              {{ promptExpanded() ? 'Show less' : 'Show full message' }}
            </button>
          }
        </div>
      }

      @if (hasBody()) {
        <div class="space-y-3 px-1">
          @if (turn().running) {
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <ng-icon class="animate-spin" name="lucideLoaderCircle" size="14" />
              <span>Working{{ elapsed() ? ' for ' + elapsed() : '' }}</span>
            </div>
          }

          @if (turn().narration) {
            <section class="flex items-start gap-2">
              <ng-icon
                class="mt-0.5 shrink-0 text-muted-foreground"
                name="lucideSparkles"
                size="14"
                aria-hidden="true"
              />
              <p
                data-narration
                class="whitespace-pre-wrap text-sm leading-relaxed"
                [class.text-muted-foreground]="turn().running"
              >
                {{ turn().narration }}
              </p>
            </section>
          }

          @if (rows().length > 0) {
            <ul class="space-y-0.5" role="list">
              @for (row of rows(); track row.id) {
                <li data-activity-row>
                  @if (row.detail !== undefined) {
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      [attr.aria-expanded]="isRowExpanded(row.id)"
                      (click)="toggleRow(row.id)"
                    >
                      <ng-template [ngTemplateOutlet]="rowContent" [ngTemplateOutletContext]="{ row }" />
                      <ng-icon
                        class="shrink-0 transition-transform"
                        [class.rotate-180]="isRowExpanded(row.id)"
                        name="lucideChevronDown"
                        size="12"
                      />
                    </button>
                    @if (isRowExpanded(row.id)) {
                      <pre
                        class="ml-6 max-h-64 overflow-auto rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground"
                        >{{ row.detail | json }}</pre>
                    }
                  } @else {
                    <div
                      class="flex w-full items-center gap-2 rounded px-1 py-1.5 text-xs text-muted-foreground"
                    >
                      <ng-template [ngTemplateOutlet]="rowContent" [ngTemplateOutletContext]="{ row }" />
                    </div>
                  }
                </li>
              }
            </ul>
          }

          @if (turn().gate) {
            <section>
              @switch (turn().gate!.status) {
                @case ('pending') {
                  <div
                    data-gate-status
                    class="inline-flex items-center gap-2 px-1 py-1 text-xs text-amber-600 dark:text-amber-400"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    <ng-icon class="animate-spin" name="lucideLoaderCircle" size="13" />
                    Running quality gate…
                  </div>
                }
                @case ('green') {
                  <div
                    data-gate-status
                    class="inline-flex items-center gap-2 px-1 py-1 text-xs text-emerald-600 dark:text-emerald-400"
                    role="status"
                    aria-live="assertive"
                    aria-atomic="true"
                  >
                    <ng-icon name="lucideCircleCheck" size="13" />
                    Gate passed
                  </div>
                }
                @case ('red') {
                  <div
                    data-gate-status
                    class="rounded-md border border-red-500/30 bg-red-500/10"
                    role="status"
                    aria-live="assertive"
                    aria-atomic="true"
                  >
                    <button
                      type="button"
                      class="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-red-700 dark:text-red-200"
                      (click)="toggleGate.emit()"
                    >
                      <span>Gate failed</span>
                      @if (turn().gate!.output) {
                        <span class="text-xs">{{
                          turn().gate!.expanded ? 'Hide output' : 'Show output'
                        }}</span>
                      }
                    </button>
                    @if (turn().gate!.expanded && turn().gate!.output) {
                      <pre
                        class="max-h-64 overflow-auto border-t border-red-500/20 px-3 py-2 text-xs text-red-800 dark:text-red-100"
                        >{{ turn().gate!.output }}</pre>
                    }
                  </div>
                }
              }
            </section>
          }

          @if (turn().result === 'no-change') {
            <section>
              <span class="inline-flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground">
                <ng-icon name="lucideCircleCheck" size="13" />
                No changes were made for this prompt.
              </span>
            </section>
          }

          @if (turn().result === 'error') {
            <section>
              <span
                data-turn-interrupted
                class="inline-flex items-center gap-2 px-1 py-1 text-xs text-red-700 dark:text-red-300"
                role="status"
                aria-live="assertive"
              >
                <ng-icon name="lucideCircleAlert" size="13" />
                Turn interrupted before it could finish.
              </span>
            </section>
          }

          @if (turn().version; as version) {
            <section
              data-version-chip
              class="overflow-hidden rounded-md border border-border bg-card text-xs"
            >
              <div class="flex items-center gap-1 px-1 py-1">
                @if (versionFiles().length > 0) {
                  <button
                    type="button"
                    data-version-chip-toggle
                    class="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    [attr.aria-expanded]="versionExpanded()"
                    [attr.aria-label]="
                      (versionExpanded() ? 'Hide' : 'Show') +
                      ' changed files for version ' +
                      versionLabelId()
                    "
                    (click)="versionExpanded.set(!versionExpanded())"
                  >
                    <ng-icon
                      class="shrink-0 text-muted-foreground transition-transform"
                      [class.rotate-90]="versionExpanded()"
                      name="lucideChevronRight"
                      size="13"
                    />
                    <ng-template
                      [ngTemplateOutlet]="versionSummary"
                      [ngTemplateOutletContext]="{ version }"
                    />
                  </button>
                } @else {
                  <div class="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1">
                    <ng-icon
                      class="shrink-0 text-muted-foreground"
                      name="lucideGitCommitHorizontal"
                      size="13"
                    />
                    <ng-template
                      [ngTemplateOutlet]="versionSummary"
                      [ngTemplateOutletContext]="{ version }"
                    />
                  </div>
                }
                @if (versionDetail()?.id) {
                  <button
                    type="button"
                    data-version-restore
                    class="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    [attr.aria-label]="'Restore version ' + versionLabelId()"
                    [disabled]="restoreBusy()"
                    (click)="restoreVersion.emit(versionDetail()!.id)"
                  >
                    @if (restoreBusy()) {
                      <ng-icon class="animate-spin" name="lucideLoaderCircle" size="13" />
                    } @else {
                      <ng-icon name="lucideRotateCcw" size="13" />
                    }
                    <span>Restore</span>
                  </button>
                }
              </div>

              @if (versionExpanded() && versionFiles().length > 0) {
                <ul class="border-t border-border" role="list">
                  @for (file of versionFiles(); track file.path) {
                    <li
                      data-version-file
                      class="flex items-center gap-2 px-3 py-1.5 text-muted-foreground"
                    >
                      <ng-icon class="shrink-0" name="lucideFileCode2" size="12" />
                      <span class="font-medium text-foreground">{{ base(file.path) }}</span>
                      <span class="min-w-0 truncate font-mono text-[11px]">{{ file.path }}</span>
                      <span class="ml-auto shrink-0 text-[11px]">{{ file.status }}</span>
                    </li>
                  }
                </ul>
              }
            </section>
          }

          @if (footerTime(); as time) {
            <div
              data-turn-footer
              class="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground"
            >
              @if (duration(); as worked) {
                <span class="inline-flex items-center gap-1">
                  <ng-icon name="lucideZap" size="12" aria-hidden="true" />
                  Worked for {{ worked }}
                </span>
                <span aria-hidden="true">·</span>
              }
              <span class="inline-flex items-center gap-1">
                <ng-icon name="lucideClock" size="12" aria-hidden="true" />
                {{ time | date: 'shortTime' }}
              </span>
            </div>
          }
        </div>
      }
    </article>

    <ng-template #rowContent let-row="row">
      @switch (row.status) {
        @case ('running') {
          <ng-icon
            aria-hidden="true"
            class="shrink-0 animate-spin text-amber-600 dark:text-amber-400"
            name="lucideLoaderCircle"
            size="13"
          />
          <span class="sr-only">running</span>
        }
        @case ('error') {
          <ng-icon
            aria-hidden="true"
            class="shrink-0 text-destructive"
            name="lucideCircleAlert"
            size="13"
          />
          <span class="sr-only">failed</span>
        }
        @default {
          <ng-icon aria-hidden="true" class="shrink-0" [name]="rowIcon(row)" size="13" />
        }
      }
      <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
    </ng-template>

    <ng-template #versionSummary let-version="version">
      <span class="min-w-0 truncate font-medium text-foreground">{{
        version.message || 'Version ' + versionLabelId()
      }}</span>
      <span
        class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
        >v{{ versionLabelId() }}</span
      >
      @if (versionDetail()?.diffStat; as stat) {
        <span data-version-diffstat class="inline-flex shrink-0 items-center gap-1 font-mono text-[11px]">
          <span class="text-emerald-600 dark:text-emerald-400">+{{ stat.additions }}</span>
          <span class="text-red-600 dark:text-red-400">-{{ stat.deletions }}</span>
        </span>
      }
    </ng-template>
  `,
})
export class TurnBlock {
  readonly turn = input.required<TurnState>();
  readonly versionDetail = input<ChatVersion | null>(null);
  readonly restoreBusy = input(false);
  readonly toggleGate = output<void>();
  readonly restoreVersion = output<string>();

  private readonly nowTick = signal(Date.now());
  private readonly running = computed(() => this.turn().running);
  private readonly promptText = computed(() => this.turn().prompt);
  private readonly tools = computed(() => this.turn().tools);

  readonly promptExpanded = signal(false);
  readonly versionExpanded = signal(false);
  private readonly expandedRows = signal<ReadonlySet<string>>(new Set());

  readonly annotationPresentation = computed(() => parseDesignAnnotationPrompt(this.promptText()));
  readonly rows = computed(() => activityRows(this.tools()));

  protected readonly shortSha = shortSha;
  protected readonly base = basename;

  readonly promptNeedsClamp = computed(() => {
    if (this.annotationPresentation()) {
      return false;
    }
    const prompt = this.promptText();
    return prompt.split('\n').length > PROMPT_CLAMP_LINES || prompt.length > PROMPT_CLAMP_CHARS;
  });

  readonly promptClamped = computed(() => this.promptNeedsClamp() && !this.promptExpanded());

  readonly versionFiles = computed(() => this.versionDetail()?.files ?? []);

  readonly versionLabelId = computed(() => {
    const detail = this.versionDetail();
    if (detail) {
      return String(detail.seq);
    }
    const commit = this.turn().version?.commit;
    return commit ? shortSha(commit) : '';
  });

  // The footer time is the completion moment; hide the footer entirely for a
  // still-running turn. Legacy rows without a finish time fall back to start.
  readonly footerTime = computed(() => {
    const turn = this.turn();
    if (turn.running) {
      return null;
    }
    return turn.finishedAt ?? turn.startedAt ?? null;
  });

  readonly duration = computed(() => turnDuration(this.turn().startedAt, this.turn().finishedAt));

  readonly hasBody = computed(() => {
    const turn = this.turn();
    return Boolean(
      turn.narration ||
        turn.running ||
        turn.tools.length > 0 ||
        turn.gate ||
        turn.version ||
        turn.result === 'no-change' ||
        turn.result === 'error' ||
        this.footerTime() !== null,
    );
  });

  readonly elapsed = computed(() => {
    const startedAt = this.turn().startedAt;
    if (!startedAt || !this.turn().running) {
      return '';
    }
    const seconds = Math.max(0, Math.floor((this.nowTick() - startedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  });

  constructor() {
    effect((onCleanup) => {
      if (!this.running()) {
        return;
      }

      this.nowTick.set(Date.now());
      const timer = setInterval(() => this.nowTick.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
  }

  rowIcon(row: ActivityRow): string {
    return ROW_ICONS[row.icon];
  }

  isRowExpanded(id: string): boolean {
    return this.expandedRows().has(id);
  }

  toggleRow(id: string): void {
    this.expandedRows.update((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }
}
