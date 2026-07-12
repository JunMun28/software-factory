import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Api, FactoryRequest, Poll } from '@sf/shared';
import { Session } from '../core/session.service';
import { MyRequests } from './my-requests';

// SubShell (rendered by MyRequests) injects Theme, which reads matchMedia on
// construction — not present in the test DOM.
beforeAll(() => {
  globalThis.matchMedia ??= (() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof globalThis.matchMedia;
});

function req(over: Partial<FactoryRequest>): FactoryRequest {
  return {
    id: 1,
    ref: 'REQ-1',
    title: 'A request',
    description: '',
    type: 'new',
    urgency: 'normal',
    reach: null,
    impact_metric: null,
    impact_value: null,
    bug_where: null,
    priority: 'normal',
    app_id: null,
    app_name: '',
    app_key: null,
    repo: null,
    prospective_repo: null,
    new_app_name: null,
    stage: 'intake',
    status: 'submitted',
    gate: null,
    needs_human: false,
    needs_human_reason: null,
    reporter: 'Jordan D.',
    reporter_initials: 'JD',
    labels: null,
    send_back_question: null,
    send_back_response: null,
    send_back_rounds: 0,
    repo_ready: false,
    spec_pr_open: false,
    stage2_fired: false,
    spec_open_note: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    stage_entered_at: null,
    last_event: null,
    ...over,
  };
}

const SAMPLE: FactoryRequest[] = [
  req({
    id: 1,
    title: 'Sent back',
    status: 'sent_back',
    stage: 'spec',
    send_back_question: 'Which one?',
  }),
  req({ id: 2, title: 'Building', status: 'approved', stage: 'build' }),
  req({ id: 3, title: 'In review', status: 'approved', stage: 'review' }),
  req({ id: 4, title: 'Spec drafted', status: 'pending_approval', stage: 'spec' }),
  req({ id: 5, title: 'Submitted', status: 'submitted', stage: 'intake' }),
  req({ id: 6, title: 'Deployed', status: 'done', stage: 'done' }),
  req({ id: 7, title: 'Cancelled', status: 'cancelled', stage: 'intake' }),
  req({ id: 8, title: 'Someone else', reporter: 'Dana L.', status: 'approved', stage: 'build' }),
];

describe('MyRequests', () => {
  let respond: ReturnType<typeof vi.fn>;

  function make(requests: FactoryRequest[] = SAMPLE) {
    respond = vi.fn(() => of({}));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: Api,
          useValue: { requests: vi.fn(() => of(requests)), respond },
        },
        {
          provide: Poll,
          useValue: { start: vi.fn(), nudge: vi.fn(), version: () => 0 },
        },
        {
          provide: Session,
          useValue: { user: () => ({ name: 'Jordan D.', initials: 'JD' }) },
        },
      ],
    });
    const fixture = TestBed.createComponent(MyRequests);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('scopes to the signed-in reporter', () => {
    const c = make();
    expect(c.all().map((r) => r.id)).not.toContain(8); // Dana L.'s request
    expect(c.all()).toHaveLength(7);
  });

  it('puts sent-back requests in the Your turn zone', () => {
    const c = make();
    expect(c.turnItems().map((r) => r.id)).toEqual([1]);
    expect(c.pendingCount()).toBe(1);
  });

  it('sorts active requests into plain-stage groups', () => {
    const c = make();
    const byKey = Object.fromEntries(c.groups().map((g) => [g.key, g.items.map((r) => r.id)]));
    expect(byKey['building']).toEqual([2]);
    expect(byKey['review']).toEqual([3]);
    expect(byKey['wait']).toEqual(expect.arrayContaining([4, 5]));
    expect(byKey['shipped']).toEqual([6]);
    // sent_back and cancelled never appear in the feed
    expect(c.groups().flatMap((g) => g.items.map((r) => r.id))).not.toContain(1);
    expect(c.groups().flatMap((g) => g.items.map((r) => r.id))).not.toContain(7);
  });

  it('lists cancelled requests separately', () => {
    const c = make();
    expect(c.cancelledRows().map((r) => r.id)).toEqual([7]);
  });

  it('sends the reply through api.respond and pins the answered card', () => {
    const c = make();
    c.setReply(1, '  Only their own  ');
    c.respond(SAMPLE[0]);

    expect(respond).toHaveBeenCalledWith(1, 'Only their own', 'Jordan D.');
    // answered request stays in the Your turn zone but no longer counts as pending
    expect(c.answered().has(1)).toBe(true);
    expect(c.turnItems().map((r) => r.id)).toContain(1);
    expect(c.pendingCount()).toBe(0);
    // and it is excluded from the feed groups (no duplicate)
    expect(c.groups().flatMap((g) => g.items.map((r) => r.id))).not.toContain(1);
  });

  it('ignores an empty reply', () => {
    const c = make();
    c.setReply(1, '   ');
    c.respond(SAMPLE[0]);
    expect(respond).not.toHaveBeenCalled();
  });
});
