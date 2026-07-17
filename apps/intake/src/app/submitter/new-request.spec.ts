import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
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
      updateRequest: vi.fn(() => of({})),
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

  /** let the un-awaited finishInBackground chain settle */
  const flush = () => new Promise((r) => setTimeout(r));

  it('creates the request immediately as a New app and navigates before classify resolves', async () => {
    api.classify.mockReturnValue(new Subject()); // never resolves during the test
    const draft = TestBed.inject(IntakeDraft);
    draft.desc = 'the export button is broken';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    await (f.componentInstance as any).continue_();

    // navigation didn't wait for the classification
    expect(api.createRequest.mock.calls[0][0].type).toBe('new');
    expect(TestBed.inject(Router).navigateByUrl).toHaveBeenCalledWith('/submit/71/interview');
  });

  it('background classification refines the provisional type and PATCHes it', async () => {
    const draft = TestBed.inject(IntakeDraft);
    draft.desc = 'the export button is broken';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    await (f.componentInstance as any).continue_();
    await flush();

    expect(api.classify).toHaveBeenCalledWith('the export button is broken');
    expect(draft.type).toBe('bug');
    expect(draft.typeConfidence).toBe(0.9);
    expect(api.updateRequest).toHaveBeenCalled();
    expect(api.updateRequest.mock.calls[0][1].type).toBe('bug');
  });

  it("a type the user picked meanwhile beats the classifier's late guess", async () => {
    const classify$ = new Subject<{ type: string; confidence: number }>();
    api.classify.mockReturnValue(classify$);
    const draft = TestBed.inject(IntakeDraft);
    draft.desc = 'the export button is broken';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    await (f.componentInstance as any).continue_();

    // the user answers the type question in Basics before classify returns
    draft.type = 'enh';
    draft.typeConfidence = 1;
    classify$.next({ type: 'bug', confidence: 0.9 });
    classify$.complete();
    await flush();

    expect(draft.type).toBe('enh');
    expect(api.updateRequest).not.toHaveBeenCalled();
  });

  it('leaves the provisional New app standing when classify fails', async () => {
    api.classify.mockReturnValue(throwError(() => new Error('boom')));
    const draft = TestBed.inject(IntakeDraft);
    draft.desc = 'something is wrong';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    await (f.componentInstance as any).continue_();
    await flush();

    expect(draft.type).toBe('new');
    expect(draft.typeConfidence).toBe(0);
    expect(api.createRequest.mock.calls[0][0].type).toBe('new');
    expect(api.updateRequest).not.toHaveBeenCalled();
  });
});
