import { Injectable, NgZone, OnDestroy, inject, signal } from '@angular/core';
import { catchError, forkJoin, of } from 'rxjs';

import { Api } from './api.service';
import { ProgressEvent } from './models';

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
  private revision = 0;
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
        this.revision = c.revision;
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
    forkJoin({
      evs: this.api.events({ after: this.cursor }),
      // Freshness is additive to ADR 0008's event path: if this lightweight
      // read ever fails, real events still advance and the next tick retries.
      freshness: this.api
        .eventsCursor()
        .pipe(catchError(() => of({ cursor: this.cursor, revision: this.revision }))),
    }).subscribe({
      next: ({ evs, freshness }) => {
        this.inFlight = false;
        const revisionChanged = freshness.revision !== this.revision;
        this.revision = freshness.revision;
        if (evs.length) {
          this.cursor = evs[evs.length - 1].id;
          this.zone.run(() => {
            this.delta.set(evs);
            this.version.update((v) => v + 1);
            this.lastSync.set(Date.now());
          });
        } else if (revisionChanged) {
          this.zone.run(() => {
            this.delta.set([]);
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
