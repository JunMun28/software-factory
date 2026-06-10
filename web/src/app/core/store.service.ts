import { Injectable, effect, inject, signal } from '@angular/core';

import { Api } from './api.service';
import { AppEntry, FactoryRequest } from './models';
import { Poll } from './poll.service';

/**
 * The one version-keyed fetch (ADR 0013). Every view used to own a copy of
 * `effect(() => { poll.version(); api.X().subscribe(...) })` plus a private
 * cache signal — 13 copies, 3–6 HTTP calls per client per tick. The three
 * shared projections are fetched HERE, once per version bump; components
 * consume computed() slices. This is also the single seam where a future
 * delta-merge or SSE swap happens without touching any view.
 */
@Injectable({ providedIn: 'root' })
export class Store {
  private api = inject(Api);
  private poll = inject(Poll);

  requests = signal<FactoryRequest[]>([]);
  apps = signal<AppEntry[]>([]);
  inbox = signal<FactoryRequest[]>([]);

  constructor() {
    effect(() => {
      this.poll.version();
      this.api.requests().subscribe((v) => this.requests.set(v));
      this.api.apps().subscribe((v) => this.apps.set(v));
      this.api.inbox().subscribe((v) => this.inbox.set(v));
    });
  }

  /** Re-sync immediately after a mutation (delegates to the poll loop's nudge). */
  refresh() {
    this.poll.nudge();
  }
}
