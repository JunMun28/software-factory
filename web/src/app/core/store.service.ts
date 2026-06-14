import { Injectable, effect, inject, signal } from '@angular/core';

import { Api } from './api.service';
import { AppEntry, FactoryRequest } from './models';
import { Poll } from './poll.service';

/**
 * The one version-keyed fetch (ADR 0013): the shell-wide projections
 * requests/apps/inbox, fetched HERE once per version bump so views consume
 * computed() slices instead of owning 13 copy-pasted refetch effects. This is
 * also the single seam where a future delta-merge or SSE swap happens without
 * touching any view. Page-specific projections (the heavy mission aggregate,
 * a submitter's own requests) are fetched by their own page, not here.
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
