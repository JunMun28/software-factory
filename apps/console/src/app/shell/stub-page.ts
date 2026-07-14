import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ConsoleShell } from './console-shell';

@Component({
  selector: 'sf-stub-page',
  imports: [ConsoleShell],
  template: `<sf-console-shell [active]="active()"
    ><section>
      <p class="eyebrow">Coming in the next slice</p>
      <h1>{{ title() }}</h1>
      <p>{{ copy() }}</p>
    </section></sf-console-shell
  >`,
  styles: `
    section {
      padding: 72px 0;
    }
    h1 {
      font-size: clamp(30px, 5vw, 48px);
    }
    p {
      max-width: 560px;
      color: var(--muted);
    }
    .eyebrow {
      color: var(--accent-tx);
      font: 600 12px var(--mono);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
  `,
})
export class StubPage {
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  active = computed(() =>
    this.router.url.startsWith('/library')
      ? 'library'
      : this.router.url.startsWith('/studio')
        ? 'studio'
        : 'dossier',
  );
  title = computed(() =>
    this.active() === 'library'
      ? 'Library'
      : this.active() === 'studio'
        ? 'Studio'
        : `Request ${this.route.snapshot.paramMap.get('id')}`,
  );
  copy = computed(() =>
    this.active() === 'library'
      ? 'Every request will live here. The current slice establishes its new home.'
      : this.active() === 'studio'
        ? 'Apps and operator settings will move here in a later slice.'
        : 'The full Dossier arrives in the next slice. This route is ready for deep links now.',
  );
}
