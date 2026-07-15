import { DestroyRef, Signal, WritableSignal, computed, signal } from '@angular/core';
import { Observable } from 'rxjs';

/** Per-step knobs for the parts of the loop that genuinely differ between wizard steps.
 *  Everything is optional; the defaults reproduce the Interview's (simplest) shape. */
export interface GenerationStreamOptions<T> {
  /** Validate the SSE terminal payload before adopting it; invalid → poll fallback.
   *  (Interview: `typeof s.asked === 'number'`; Prototype: `typeof s.status === 'string'`.) */
  isValidEvent?: (s: T) => boolean;
  /** Whether the initial read should start driving generation. Default: isThinking.
   *  (Prototype also drives when the first draft is owed: no html / a pending turn.) */
  needsStreamOnLoad?: (s: T) => boolean;
  /** Whether a terminal SSE state leaves more generation owed → reopen the stream.
   *  Default: never. (Prototype: a queued edit is still `pending`.) */
  needsStreamAfterEvent?: (s: T) => boolean;
  /** Side effects after each adopted state, with where it came from — components hang
   *  their scroll-to-end / busy-flag bookkeeping here instead of owning the loop. */
  onState?: (s: T, source: 'load' | 'sse' | 'poll') => void;
  /** The initial read errored. Default: silent (a revisit retries). */
  onLoadError?: () => void;
  /** A poll tick errored. Default: silent — the loop stops, the read stays retryable. */
  onPollError?: () => void;
}

/** Re-poll cadence while the server reports it is still generating. */
const POLL_MS = 1500;

/**
 * One wizard step's generation loop, made deep (deepening candidate 3, D13–D15):
 * read the step's state, and while the server is generating drive it to completion —
 * over SSE when the step has a stream endpoint (`streamUrlFn`), falling back to a
 * kicked 1500 ms poll on any SSE hiccup; poll-only when `streamUrlFn` is null
 * (the Review summary has no stream). Owns its timers and EventSource, and tears
 * both down via the component's DestroyRef. Plain class — one instance per step,
 * no TestBed needed to test it.
 *
 * The read is called `readFn(kick)`: `kick=false` for the initial/re-entry read
 * (the stream drives generation itself), `kick=true` on poll ticks (the poll IS
 * the generation kicker when SSE is unavailable). Poll-only steps ignore the flag.
 */
export class GenerationStream<T> {
  /** The latest server state. Writable: mutation responses adopt through ingest(),
   *  and component specs set it directly. */
  readonly state: WritableSignal<T | null> = signal<T | null>(null);
  /** The server is generating (isThinking on the current state; false while null). */
  readonly thinking: Signal<boolean>;
  private _streaming = signal(false);
  /** An SSE connection is open, driving the generation. */
  readonly streaming: Signal<boolean> = this._streaming.asReadonly();

  private destroyed = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private closeStreamFn: (() => void) | null = null;

  constructor(
    private readFn: (kick: boolean) => Observable<T>,
    private streamUrlFn: (() => string) | null,
    private isThinking: (s: T) => boolean,
    destroyRef: DestroyRef,
    private opts: GenerationStreamOptions<T> = {},
  ) {
    this.thinking = computed(() => {
      const s = this.state();
      return s !== null && this.isThinking(s);
    });
    destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.clearPoll();
      this.closeStream();
    });
  }

  /** Initial load and public re-entry (PlanPanel's parent calls this after every answer):
   *  read WITHOUT kicking generation, adopt the state, and keep driving if it's owed. */
  refresh(): void {
    if (this.destroyed) return;
    this.clearPoll();
    this.readFn(false).subscribe({
      next: (s) => {
        this.state.set(s);
        this.opts.onState?.(s, 'load');
        if ((this.opts.needsStreamOnLoad ?? this.isThinking)(s)) this.drive();
      },
      error: () => this.opts.onLoadError?.(),
    });
  }

  /** Adopt a state returned by a mutation (answer / instruct / escalate / restore).
   *  `drive=true` continues generation — SSE with poll fallback, or poll-only. The
   *  caller decides (the predicates differ per action, e.g. Prototype's pending edits). */
  ingest(s: T, drive = false): void {
    this.state.set(s);
    if (drive && !this.destroyed) this.drive();
  }

  private drive(): void {
    // a pending poll tick must never race the driver we are about to start —
    // a stale poll response could transiently overwrite an SSE terminal state
    this.clearPoll();
    if (this.streamUrlFn) this.openStream();
    else this.schedulePoll();
  }

  /** Drive generation over SSE; the single terminal `state` event carries the finished
   *  state. Any error — or a payload that fails isValidEvent — falls back to polling. */
  private openStream(): void {
    this.closeStream();
    if (this.destroyed) return;
    this._streaming.set(true);
    this.closeStreamFn = openEventSource<T>(
      this.streamUrlFn!(),
      (s) => {
        this.closeStream();
        if ((this.opts.isValidEvent ?? (() => true))(s)) {
          this.state.set(s);
          this.opts.onState?.(s, 'sse');
          if (this.opts.needsStreamAfterEvent?.(s)) this.openStream();
        } else {
          this.poll(); // empty/garbled state → recover via the poll fallback
        }
      },
      () => {
        this.closeStream();
        this.poll(); // network/SSE hiccup → fall back to polling (which kicks generation)
      },
    );
  }

  private closeStream(): void {
    if (this.closeStreamFn) {
      this.closeStreamFn();
      this.closeStreamFn = null;
    }
    this._streaming.set(false);
  }

  /** SSE fallback / poll-only loop: read WITH the generation kick, re-poll every
   *  1500 ms while the server is thinking. Exactly one pending tick at a time. */
  private poll(): void {
    if (this.destroyed) return;
    this.readFn(true).subscribe({
      next: (s) => {
        this.state.set(s);
        this.opts.onState?.(s, 'poll');
        if (this.isThinking(s)) this.schedulePoll();
      },
      error: () => this.opts.onPollError?.(),
    });
  }

  private schedulePoll(): void {
    this.clearPoll();
    if (this.destroyed) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.poll();
    }, POLL_MS);
  }

  private clearPoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

/** One-shot SSE lifecycle — absorbed from @sf/shared's `streamState()` (intake was its
 *  only consumer; Task 5 of the 2026-07-15 plan deletes the shared original). Opens an
 *  EventSource to `url`; the server drives a slow generation and emits a single terminal
 *  `state` event, whose JSON payload is handed to `onState`. Any connection error (or a
 *  payload that won't parse) calls `onError`. Returns a close fn — GenerationStream
 *  invokes it in closeStream() so the `streaming` signal stays in sync. */
function openEventSource<T>(
  url: string,
  onState: (data: T) => void,
  onError: () => void,
): () => void {
  const es = new EventSource(url);
  es.addEventListener('state', (e) => {
    let data: T;
    try {
      data = JSON.parse((e as MessageEvent).data) as T;
    } catch {
      onError();
      return;
    }
    onState(data);
  });
  es.onerror = onError;
  return () => es.close();
}
