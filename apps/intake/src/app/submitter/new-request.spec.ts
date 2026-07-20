import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provideRouter, Router } from '@angular/router';
import { Api } from '@sf/shared';
import { NewRequest } from './new-request';
import { IntakeDraft } from './intake-draft.service';
import { Session } from '../core/session.service';

describe('NewRequest continue', () => {
  let api: any;
  afterEach(() => vi.useRealTimers());

  beforeEach(async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn() }));
    api = {
      classify: vi.fn(() => of({ status: 'pending', type: null, confidence: null })),
      classification: vi.fn(() => of({ status: 'succeeded', type: 'bug', confidence: 0.9 })),
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

  it('polls background classification, refines the provisional type, and PATCHes it', async () => {
    vi.useFakeTimers();
    const draft = TestBed.inject(IntakeDraft);
    draft.desc = 'the export button is broken';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    await (f.componentInstance as any).continue_();
    await vi.advanceTimersByTimeAsync(1000);

    expect(api.classify).toHaveBeenCalledWith('the export button is broken', 71);
    expect(api.classification).toHaveBeenCalledWith(71);
    expect(draft.type).toBe('bug');
    expect(draft.typeConfidence).toBe(0.9);
    expect(api.updateRequest).toHaveBeenCalled();
    expect(api.updateRequest.mock.calls[0][1].type).toBe('bug');
  });

  it('records a successful New-app classification without a redundant PATCH', async () => {
    vi.useFakeTimers();
    api.classification.mockReturnValue(of({ status: 'succeeded', type: 'new', confidence: 0.8 }));
    const draft = TestBed.inject(IntakeDraft);
    draft.desc = 'build a room booking tool';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    await (f.componentInstance as any).continue_();
    await vi.advanceTimersByTimeAsync(1000);

    expect(draft.type).toBe('new');
    expect(draft.typeConfidence).toBe(0.8);
    expect(api.updateRequest).not.toHaveBeenCalled();
  });

  it('polls sequentially until classification reaches a terminal state', async () => {
    vi.useFakeTimers();
    api.classification
      .mockReturnValueOnce(of({ status: 'pending', type: null, confidence: null }))
      .mockReturnValueOnce(of({ status: 'succeeded', type: 'enh', confidence: 0.75 }));
    const draft = TestBed.inject(IntakeDraft);
    draft.desc = 'make the export easier to find';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    await (f.componentInstance as any).continue_();

    await vi.advanceTimersByTimeAsync(1000);
    expect(api.classification).toHaveBeenCalledTimes(1);
    expect(api.updateRequest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);

    expect(api.classification).toHaveBeenCalledTimes(2);
    expect(draft.type).toBe('enh');
    expect(api.updateRequest).toHaveBeenCalledTimes(1);
  });

  it('deduplicates polling when the component is destroyed and recreated', async () => {
    const kick$ = new Subject<{
      status: 'failed';
      type: null;
      confidence: null;
    }>();
    api.classify.mockReturnValue(kick$);
    const draft = TestBed.inject(IntakeDraft);
    draft.requestId = 71;
    draft.type = 'new';
    draft.typeConfidence = 0;
    draft.desc = 'the same request';
    const first = TestBed.createComponent(NewRequest);
    first.detectChanges();
    const firstRun = (first.componentInstance as any).finishInBackground(71);
    first.destroy();
    const recreated = TestBed.createComponent(NewRequest);
    recreated.detectChanges();
    const duplicateRun = (recreated.componentInstance as any).finishInBackground(71);

    expect(api.classify).toHaveBeenCalledTimes(1);
    kick$.next({ status: 'failed', type: null, confidence: null });
    kick$.complete();
    await Promise.all([firstRun, duplicateRun]);
  });

  it('supersedes stale polling when the description changes for the same request', async () => {
    vi.useFakeTimers();
    const oldKick$ = new Subject<{
      status: 'pending';
      type: null;
      confidence: null;
    }>();
    const replacementKick$ = new Subject<{
      status: 'failed';
      type: null;
      confidence: null;
    }>();
    api.classify.mockReturnValueOnce(oldKick$).mockReturnValueOnce(replacementKick$);
    const draft = TestBed.inject(IntakeDraft);
    draft.requestId = 71;
    draft.type = 'new';
    draft.typeConfidence = 0;
    draft.desc = 'the old description';
    const first = TestBed.createComponent(NewRequest);
    first.detectChanges();
    const staleRun = (first.componentInstance as any).finishInBackground(71);

    draft.desc = '  the edited description  ';
    const replacement = TestBed.createComponent(NewRequest);
    replacement.detectChanges();
    const replacementRun = (replacement.componentInstance as any).finishInBackground(71);

    expect(api.classify.mock.calls).toEqual([
      ['the old description', 71],
      ['the edited description', 71],
    ]);
    oldKick$.next({ status: 'pending', type: null, confidence: null });
    oldKick$.complete();
    await vi.advanceTimersByTimeAsync(1000);
    await staleRun;

    expect(api.classification).not.toHaveBeenCalled();
    expect(draft.type).toBe('new');
    expect(draft.typeConfidence).toBe(0);
    expect(api.updateRequest).not.toHaveBeenCalled();

    // The stale run's finally must not clear the replacement's ownership.
    await (replacement.componentInstance as any).finishInBackground(71);
    expect(api.classify).toHaveBeenCalledTimes(2);
    replacementKick$.next({ status: 'failed', type: null, confidence: null });
    replacementKick$.complete();
    await replacementRun;
  });

  it('keeps polling past 125 attempts while it still owns the pending classification', async () => {
    vi.useFakeTimers();
    let polls = 0;
    api.classification.mockImplementation(() => {
      polls += 1;
      return of(
        polls <= 126
          ? { status: 'pending', type: null, confidence: null }
          : { status: 'succeeded', type: 'bug', confidence: 0.85 },
      );
    });
    const draft = TestBed.inject(IntakeDraft);
    draft.requestId = 71;
    draft.type = 'new';
    draft.typeConfidence = 0;
    draft.desc = 'a slow classification that eventually lands';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    const run = (f.componentInstance as any).finishInBackground(71);

    await vi.advanceTimersByTimeAsync(127_000);
    await run;

    expect(api.classification).toHaveBeenCalledTimes(127);
    expect(draft.type).toBe('bug');
    expect(draft.typeConfidence).toBe(0.85);
    expect(api.updateRequest).toHaveBeenCalledWith(71, { type: 'bug' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops before polling when the user picks a type', async () => {
    vi.useFakeTimers();
    const draft = TestBed.inject(IntakeDraft);
    draft.desc = 'the export button is broken';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    await (f.componentInstance as any).continue_();

    // the user answers the type question in Basics before classify returns
    draft.type = 'enh';
    draft.typeConfidence = 1;
    await vi.advanceTimersByTimeAsync(1000);

    expect(draft.type).toBe('enh');
    expect(api.classification).not.toHaveBeenCalled();
    expect(api.updateRequest).not.toHaveBeenCalled();
  });

  it('does not kick classification for a request that is no longer current', async () => {
    const draft = TestBed.inject(IntakeDraft);
    draft.requestId = 72;
    draft.type = 'new';
    draft.typeConfidence = 0;
    draft.desc = 'the old request description';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();

    await (f.componentInstance as any).finishInBackground(71);

    expect(api.classify).not.toHaveBeenCalled();
    expect(api.classification).not.toHaveBeenCalled();
  });

  it("a type the user picked while a poll is in flight beats the classifier's late guess", async () => {
    vi.useFakeTimers();
    const classification$ = new Subject<{
      status: 'succeeded';
      type: 'bug';
      confidence: number;
    }>();
    api.classification.mockReturnValue(classification$);
    const draft = TestBed.inject(IntakeDraft);
    draft.desc = 'the export button is broken';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    await (f.componentInstance as any).continue_();
    await vi.advanceTimersByTimeAsync(1000);

    draft.type = 'enh';
    draft.typeConfidence = 1;
    classification$.next({ status: 'succeeded', type: 'bug', confidence: 0.9 });
    classification$.complete();
    await vi.runAllTimersAsync();

    expect(draft.type).toBe('enh');
    expect(api.updateRequest).not.toHaveBeenCalled();
  });

  it('compensates when a human picks a different type during the classifier PATCH', async () => {
    vi.useFakeTimers();
    const classifierPatch$ = new Subject<object>();
    api.updateRequest.mockReturnValueOnce(classifierPatch$).mockReturnValueOnce(of({}));
    const draft = TestBed.inject(IntakeDraft);
    draft.desc = 'the export button is broken';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    await (f.componentInstance as any).continue_();
    await vi.advanceTimersByTimeAsync(1000);

    expect(api.updateRequest).toHaveBeenCalledTimes(1);
    draft.type = 'enh';
    draft.typeConfidence = 1;
    classifierPatch$.next({});
    classifierPatch$.complete();
    await vi.runAllTimersAsync();

    expect(api.updateRequest.mock.calls).toEqual([
      [71, { type: 'bug' }],
      [71, { type: 'enh' }],
    ]);
  });

  it.each([
    ['the classifier reports failure', of({ status: 'failed', type: null, confidence: null })],
    ['polling errors', throwError(() => new Error('boom'))],
  ])('leaves the provisional New app standing when %s', async (_label, response) => {
    vi.useFakeTimers();
    api.classification.mockReturnValue(response);
    const draft = TestBed.inject(IntakeDraft);
    draft.desc = 'something is wrong';
    const f = TestBed.createComponent(NewRequest);
    f.detectChanges();
    await (f.componentInstance as any).continue_();
    await vi.advanceTimersByTimeAsync(1000);

    expect(draft.type).toBe('new');
    expect(draft.typeConfidence).toBe(0);
    expect(api.createRequest.mock.calls[0][0].type).toBe('new');
    expect(api.updateRequest).not.toHaveBeenCalled();
  });
});
