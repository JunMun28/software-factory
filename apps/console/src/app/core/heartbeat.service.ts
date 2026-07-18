import { Injectable, NgZone, OnDestroy, computed, inject, signal } from '@angular/core';
import { Api, type Health } from '@sf/shared';

export type HeartbeatState = 'healthy' | 'buffering' | 'stalled' | 'unknown';

/**
 * Keeps the operator-facing factory heartbeat fresh independently of event traffic.
 * The timer mirrors Poll's zoneless, non-overlapping polling pattern.
 */
@Injectable({ providedIn: 'root' })
export class Heartbeat implements OnDestroy {
  private api = inject(Api);
  private zone = inject(NgZone);
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private latest = signal<Health | null>(null);
  private failed = signal(false);

  health = this.latest.asReadonly();
  fetchFailed = this.failed.asReadonly();
  state = computed<HeartbeatState>(() => {
    if (this.failed()) return 'stalled';
    const age = this.latest()?.tick_age_s;
    if (age == null) return 'unknown';
    if (age < 15) return 'healthy';
    if (age > 30) return 'stalled';
    return 'buffering';
  });

  start(intervalMs = 10_000) {
    if (this.timer) return;
    this.checkOnce();
    this.zone.runOutsideAngular(() => {
      this.timer = setInterval(() => this.checkOnce(), intervalMs);
    });
  }

  private checkOnce() {
    if (this.inFlight) return;
    this.inFlight = true;
    this.api.health().subscribe({
      next: (health) => {
        this.inFlight = false;
        this.zone.run(() => {
          this.latest.set(health);
          this.failed.set(false);
        });
      },
      error: () => {
        this.inFlight = false;
        this.zone.run(() => this.failed.set(true));
      },
    });
  }

  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
