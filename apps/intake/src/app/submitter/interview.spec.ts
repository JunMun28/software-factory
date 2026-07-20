import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Api, InterviewState, Theme } from '@sf/shared';
import { Session } from '../core/session.service';
import { Interview } from './interview';

/** A minimal InterviewState mid-interview, with a pending escalation proposal (ADR 0023). */
function stateWithEscalation(): InterviewState {
  return {
    done: false,
    asked: 1,
    total: 3,
    thinking: false,
    question: null,
    sub: null,
    options: null,
    final: false,
    turns: [
      {
        order: 0,
        question: 'What broke?',
        sub: null,
        options: null,
        answer: 'the export',
        skipped: false,
      },
    ],
    escalation: { to_type: 'new', why: 'This needs a whole new tool, not a patch.' },
  };
}

describe('Interview escalation (consent-gated type change)', () => {
  let api: any;

  beforeEach(async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn() }));
    // jsdom doesn't implement Element.scrollTo; the thread's scroll-to-end timer calls it.
    Element.prototype.scrollTo = vi.fn();
    api = {
      request: vi.fn(() => of({ id: 71, type: 'bug', title: 'Broken export' })),
      interview: vi.fn(() => of(stateWithEscalation())),
      interviewStreamUrl: vi.fn(() => '/api/requests/71/interview/stream'),
      answer: vi.fn(() => of(stateWithEscalation())),
      reopenInterview: vi.fn(() => of(stateWithEscalation())),
      summary: vi.fn(() => of({ overview: null, sections: [], thinking: false })),
      escalate: vi.fn(() => of({ ...stateWithEscalation(), escalation: null })),
      attachmentRawUrl: vi.fn(() => ''),
    };
    await TestBed.configureTestingModule({
      imports: [Interview],
      providers: [
        provideRouter([]),
        { provide: Api, useValue: api },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => '71' } } } },
        {
          provide: Session,
          useValue: {
            user: () => ({ name: 'Jordan D.', initials: 'JD', email: '', color: '#000' }),
          },
        },
        { provide: Theme, useValue: { resolved: () => 'light', set: vi.fn() } },
      ],
    }).compileComponents();
    // provideRouter([]) has no routes; the finish-effect may navigate — stub it so nothing rejects.
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  afterEach(() => vi.unstubAllGlobals());

  function render() {
    const fixture = TestBed.createComponent(Interview);
    fixture.detectChanges();
    const comp = fixture.componentInstance as Interview;
    comp.st.set(stateWithEscalation()); // pending proposal on the state
    comp.phase.set('full'); // reveal the chat thread (past the basics intro)
    fixture.detectChanges();
    return { fixture, comp };
  }

  function escBubble(root: HTMLElement): HTMLElement | null {
    return root.querySelector('.esc__row');
  }

  it('shows a Switch/Keep-as-is proposal when an escalation is pending', () => {
    const { fixture } = render();
    const row = escBubble(fixture.nativeElement);
    expect(row).not.toBeNull();
    const labels = [...row!.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Switch', 'Keep as is']);
  });

  it('accepting the proposal PATCHes the type via api.escalate(id, true, toType)', () => {
    const { fixture, comp } = render();
    const switchBtn = [...escBubble(fixture.nativeElement)!.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Switch',
    )!;
    switchBtn.click();

    expect(api.escalate).toHaveBeenCalledWith(71, true, 'new');
    // the returned state clears the proposal, so the bubble disappears
    fixture.detectChanges();
    expect(comp.escalation()).toBeNull();
    expect(escBubble(fixture.nativeElement)).toBeNull();
  });

  it('declining records the choice via api.escalate(id, false, toType) and keeps going', () => {
    const { fixture } = render();
    const keepBtn = [...escBubble(fixture.nativeElement)!.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Keep as is',
    )!;
    keepBtn.click();

    expect(api.escalate).toHaveBeenCalledWith(71, false, 'new');
  });

  it('pulses the context Track chip while the proposal is pending', () => {
    const { fixture } = render();
    const chip = fixture.nativeElement.querySelector('sf-track-chip .tchip');
    expect(chip).not.toBeNull();
    expect(chip.classList).toContain('tchip--pulse');
  });

  it('wires the stream: the initial read does not kick generation (gen=false)', () => {
    render();
    expect(api.interview).toHaveBeenCalledWith(71, false);
  });

  it('re-fetches canonical interview state when an answer loses with 409', () => {
    const latest = {
      ...stateWithEscalation(),
      asked: 2,
      question: 'Which export format should work?',
      escalation: null,
    };
    api.answer.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 409, statusText: 'Conflict' })),
    );
    const { comp } = render();
    api.interview.mockClear();
    api.interview.mockReturnValue(of(latest));

    comp.answer('CSV');

    expect(api.answer).toHaveBeenCalledWith(71, { answer: 'CSV' });
    expect(api.interview).toHaveBeenCalledExactlyOnceWith(71, false);
    expect(comp.st()).toEqual(latest);
    expect(comp.busy()).toBe(false);
  });

  it('keeps the current answer error behavior for non-409 failures', () => {
    api.answer.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 503, statusText: 'Unavailable' })),
    );
    const { comp } = render();
    api.interview.mockClear();

    comp.answer('CSV');

    expect(api.interview).not.toHaveBeenCalled();
    expect(comp.busy()).toBe(false);
  });

  it('re-fetches interview and request state when escalation loses with 409', () => {
    const latest = { ...stateWithEscalation(), escalation: null };
    api.escalate.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 409, statusText: 'Conflict' })),
    );
    const { comp } = render();
    const planRefresh = vi.spyOn(comp.planPanel()!, 'refresh');
    api.interview.mockClear();
    api.request.mockClear();
    api.interview.mockReturnValue(of(latest));
    api.request.mockReturnValue(of({ id: 71, type: 'new', title: 'New export app' }));

    comp.acceptEscalation('new');

    expect(api.interview).toHaveBeenCalledExactlyOnceWith(71, false);
    expect(api.request).toHaveBeenCalledExactlyOnceWith(71);
    expect(comp.st()).toEqual(latest);
    expect(comp.req()?.type).toBe('new');
    expect(planRefresh).toHaveBeenCalledOnce();
    expect(comp.busy()).toBe(false);
  });

  it('re-fetches canonical interview state when reopen loses with 409', () => {
    const latest = {
      ...stateWithEscalation(),
      escalation: null,
      question: 'What else should the new flow cover?',
    };
    api.reopenInterview.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 409, statusText: 'Conflict' })),
    );
    const { comp } = render();
    api.interview.mockClear();
    api.interview.mockReturnValue(of(latest));
    comp.st.set({ ...stateWithEscalation(), done: true, question: null, escalation: null });
    comp.msg.set('Also support recurring exports');

    comp.enter();

    expect(api.reopenInterview).toHaveBeenCalledExactlyOnceWith(
      71,
      'Also support recurring exports',
    );
    expect(api.interview).toHaveBeenCalledExactlyOnceWith(71, false);
    expect(comp.st()).toEqual(latest);
    expect(comp.busy()).toBe(false);
  });
});
