import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provideRouter, Router } from '@angular/router';
import { Api } from '@sf/shared';
import { NewRequest } from './new-request';
import { IntakeDraft } from './intake-draft.service';
import { Session } from '../core/session.service';

describe('NewRequest continue', () => {
  let api: any;
  beforeEach(async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn() }));
    api = {
      classify: vi.fn(() => of({ type: 'bug', confidence: 0.9 })),
      createRequest: vi.fn(() => of({ id: 71 })),
      apps: vi.fn(() => of([])),
    };
    await TestBed.configureTestingModule({
      imports: [NewRequest],
      providers: [
        provideRouter([]),
        { provide: Api, useValue: api },
        { provide: Session, useValue: { user: () => ({ name: 'Jordan D.', initials: 'JD' }) } },
      ],
    }).compileComponents();
    // provideRouter([]) has no registered routes, so a real navigateByUrl to
    // /submit/:id/interview rejects (NG04002); stub it so continue_() can be
    // awaited end-to-end without an unhandled-rejection escaping the test.
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  });

  it('classifies the description and creates the request with the inferred type', async () => {
    const draft = TestBed.inject(IntakeDraft);
    draft.desc = 'the export button is broken';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    await (f.componentInstance as any).continue_();

    expect(api.classify).toHaveBeenCalledWith('the export button is broken');
    expect(draft.type).toBe('bug');
    expect(draft.typeConfidence).toBe(0.9);
    // request created with the inferred type
    expect(api.createRequest).toHaveBeenCalled();
    expect(api.createRequest.mock.calls[0][0].type).toBe('bug');
  });

  it('falls back to new/low-confidence when classify fails', async () => {
    api.classify.mockReturnValue(throwError(() => new Error('boom')));
    const draft = TestBed.inject(IntakeDraft);
    draft.desc = 'something is wrong';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    await (f.componentInstance as any).continue_();

    expect(draft.type).toBe('new');
    expect(draft.typeConfidence).toBe(0);
    expect(api.createRequest.mock.calls[0][0].type).toBe('new');
  });
});
