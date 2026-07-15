import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Api, RequestDetail, ReviewSummary } from '@sf/shared';
import { IntakeDraft } from './intake-draft.service';
import { Review } from './review';

/** A minimal RequestDetail — only the fields Review reads. Cast covers the rest. */
function detail(over: Partial<RequestDetail>): RequestDetail {
  return {
    id: 42,
    type: 'bug',
    app_name: 'Shipping Console',
    reach: null,
    impact_metric: null,
    impact_value: null,
    prototype_html: null,
    ...over,
  } as RequestDetail;
}

const SUMMARY: ReviewSummary = {
  overview: 'The export button fails on large orders.',
  sections: [{ title: 'Steps to reproduce', items: ['Open a big order', 'Click export'] }],
  thinking: false,
};

function setup(req: RequestDetail) {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn() }));
  const api = {
    request: vi.fn(() => of(req)),
    summary: vi.fn(() => of(SUMMARY)),
    submit: vi.fn(() => of({})),
  };
  const draft = { extra: '', hydrateFrom: vi.fn(), reset: vi.fn() };
  TestBed.configureTestingModule({
    imports: [Review],
    providers: [
      provideRouter([]),
      { provide: Api, useValue: api },
      { provide: IntakeDraft, useValue: draft },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => '42' } } } },
    ],
  });
  vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  const fixture = TestBed.createComponent(Review);
  fixture.detectChanges();
  return { fixture, api };
}

describe('Review — track-adaptive layout (ADR 0023)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('wires the summary poll: one read on init, none after (summary not thinking)', () => {
    const { api } = setup(detail({ type: 'bug' }));
    expect(api.summary).toHaveBeenCalledOnce();
  });

  it('renders a compact review for a bug (short track)', () => {
    const { fixture } = setup(detail({ type: 'bug' }));
    const root = fixture.nativeElement as HTMLElement;

    const compact = root.querySelector('.review--compact');
    expect(compact).not.toBeNull();

    expect(root.textContent?.toLowerCase()).toContain('what happens next');
  });

  it('renders the full review for a new app', () => {
    const { fixture } = setup(detail({ type: 'new', app_name: 'Fleet Tracker' }));
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('.review--compact')).toBeNull();
    // full layout still renders the two-column grid
    expect(root.querySelector('.rv-grid')).not.toBeNull();
  });
});
