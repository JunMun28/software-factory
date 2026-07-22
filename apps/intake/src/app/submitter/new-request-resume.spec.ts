import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Api } from '@sf/shared';
import { Session } from '../core/session.service';
import { IntakeDraft } from './intake-draft.service';
import { NewRequest } from './new-request';

/** Getting back to an intake you walked away from. The answers were never lost —
 *  the server had them all along — but nothing listed the request back to you. */
describe('NewRequest resume', () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    id: 71,
    ref: 'REQ-2100',
    title: 'Shift swap tool',
    type: 'new',
    step: 'interview',
    answered: 3,
    updated_at: '2026-07-22T00:00:00Z',
    ...over,
  });

  async function mount(drafts: unknown, requestIdInHand: number | null = null) {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn() }));
    const api = {
      classify: vi.fn(() => of({ status: 'pending', type: null, confidence: null })),
      classification: vi.fn(() => of({ status: 'succeeded', type: 'bug', confidence: 0.9 })),
      createRequest: vi.fn(() => of({ id: 71 })),
      updateRequest: vi.fn(() => of({})),
      apps: vi.fn(() => of([])),
      draftRequests: vi.fn(() =>
        drafts === 'error' ? throwError(() => new Error('down')) : of(drafts),
      ),
    };
    await TestBed.configureTestingModule({
      imports: [NewRequest],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        { provide: Api, useValue: api },
        { provide: Session, useValue: { user: () => ({ name: 'Ada Lovelace', initials: 'AL' }) } },
      ],
    }).compileComponents();
    TestBed.inject(IntakeDraft).requestId = requestIdInHand;
    const fixture = TestBed.createComponent(NewRequest);
    fixture.detectChanges();
    return { fixture, api };
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('offers an unfinished intake as a way back', async () => {
    const { fixture, api } = await mount([draft()]);
    expect(api.draftRequests).toHaveBeenCalledWith('Ada Lovelace');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Continue where you left off');
    expect(text).toContain('Shift swap tool');
    expect(text).toContain('3 answered');
  });

  it('links each draft to the step the SERVER says it reached', async () => {
    const { fixture } = await mount([draft({ step: 'prototype' })]);
    const link = (fixture.nativeElement as HTMLElement).querySelector('a.resume__item');
    expect(link?.getAttribute('href')).toBe('/submit/71/prototype');
  });

  it('says nothing when there is nothing to resume', async () => {
    const { fixture } = await mount([]);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Continue where you left off');
  });

  it('does not offer the draft you are already in', async () => {
    const { fixture } = await mount([draft({ id: 71 })], 71);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Continue where you left off');
  });

  it('still lets you start a new request when the lookup fails', async () => {
    // This page's job is starting something new; resume is a bonus on top of it.
    const { fixture } = await mount('error');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('What should we build?');
    expect(text).not.toContain('Continue where you left off');
  });
});
