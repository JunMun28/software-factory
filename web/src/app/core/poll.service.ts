import { Injectable, NgZone, OnDestroy, inject, signal } from '@angular/core';

import { Api } from './api.service';
import { ProgressEvent } from '@sf/shared';

/**
 * ADR 0007/0008: polling now, SSE later. One keyset cursor (`?after=<event_id>`)
 * is the poll cursor; screens re-query their own projections when `version` bumps,
 * so only changed data re-renders (no whole-board flash).
 */
@Injectable({ providedIn: 'root' })
export class Poll implements OnDestroy {
  private api = inject(Api);
  private zone = inject(NgZone);
  private cursor = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  version = signal(0);
  lastSync = signal<number>(Date.now());
  /** The new events from the last poll tick — views consume this delta directly
   *  instead of refetching their whole projection (diff-merge, ADR 0008). */
  delta = signal<ProgressEvent[]>([]);
  private inFlight = false;

  start(intervalMs = 4000) {
    if (this.timer) return;
    // start from the tail of the log — never replay history (ADR 0013)
    this.api.eventsCursor().subscribe({
      next: (c) => {
        this.cursor = c.cursor;
        this.version.update((v) => v + 1);
        this.lastSync.set(Date.now());
      },
      error: () => this.version.update((v) => v + 1),
    });
    this.zone.runOutsideAngular(() => {
      this.timer = setInterval(() => this.tickOnce(), intervalMs);
    });
  }

  private tickOnce() {
    if (this.inFlight) return; // a stalled backend must not queue a refetch burst
    this.inFlight = true;
    this.api.events({ after: this.cursor }).subscribe({
      next: (evs) => {
        this.inFlight = false;
        if (evs.length) {
          this.cursor = evs[evs.length - 1].id;
          this.zone.run(() => {
            this.delta.set(evs);
            this.version.update((v) => v + 1);
            this.lastSync.set(Date.now());
          });
        } else {
          this.zone.run(() => this.lastSync.set(Date.now()));
        }
      },
      error: () => {
        this.inFlight = false; // the next tick retries; lastSync ages visibly in the header
      },
    });
  }

  /** Force an immediate re-sync (used after optimistic actions). */
  nudge() {
    this.version.update((v) => v + 1);
  }

  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
