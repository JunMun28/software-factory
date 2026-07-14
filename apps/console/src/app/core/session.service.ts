import { Injectable, computed, inject, signal } from '@angular/core';
import { Api, Operator } from '@sf/shared';
import { Observable, map, shareReplay, tap } from 'rxjs';

const STORAGE_KEY = 'sf-console-operator-id';

/** Console identity seam. Profile picking is one provider of a server-resolved operator. */
@Injectable({ providedIn: 'root' })
export class Session {
  private api = inject(Api);
  private loaded = false;
  private load$?: Observable<Operator | null>;
  operator = signal<Operator | null>(null);
  operatorId = computed(() => this.operator()?.id ?? null);
  user = computed(() => {
    const operator = this.operator();
    return operator
      ? {
          name: operator.name,
          initials: operator.initials,
          color: operator.hue,
          email: operator.email,
          role: 'admin' as const,
        }
      : { name: '', initials: '', color: 'transparent', email: '', role: 'submitter' as const };
  });

  constructor() {
    this.resolve().subscribe();
  }

  resolve(): Observable<Operator | null> {
    if (this.loaded)
      return new Observable((subscriber) => {
        subscriber.next(this.operator());
        subscriber.complete();
      });
    if (!this.load$) {
      this.load$ = this.api.operators().pipe(
        map((operators) => {
          const raw = localStorage.getItem(STORAGE_KEY);
          const selected = raw
            ? (operators.find((operator) => operator.id === Number(raw)) ?? null)
            : null;
          if (raw && !selected) localStorage.removeItem(STORAGE_KEY);
          return selected;
        }),
        tap((operator) => {
          this.operator.set(operator);
          this.loaded = true;
        }),
        shareReplay(1),
      );
    }
    return this.load$;
  }

  select(operator: Operator) {
    localStorage.setItem(STORAGE_KEY, String(operator.id));
    this.operator.set(operator);
    this.loaded = true;
  }
}
