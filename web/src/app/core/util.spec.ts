import { describe, expect, it } from 'vitest';

import { FactoryRequest } from './models';
import { boardGlyph, clock, gateLabel, plainStage, timeAgo, utc } from './util';

function req(over: Partial<FactoryRequest> = {}): FactoryRequest {
  return {
    id: 1, ref: 'REQ-1', title: 't', description: '', type: 'enh', urgency: 'normal', priority: 'Normal',
    app_id: 1, app_name: 'App', app_key: 'app', repo: null, new_app_name: null,
    stage: 'intake', status: 'submitted', gate: null, needs_human: false, needs_human_reason: null,
    reporter: 'J', reporter_initials: 'JD', assignee: null, assignee_initials: null, assignee_color: null,
    labels: null, send_back_question: null, send_back_response: null, send_back_rounds: 0,
    repo_ready: false, spec_pr_open: false, stage2_fired: false, spec_open_note: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    stage_entered_at: null, last_event: null,
    ...over,
  };
}

describe('utc', () => {
  it('re-tags naive SQLite timestamps as UTC', () => {
    const naive = '2026-06-10T12:00:00';
    expect(utc(naive).getTime()).toBe(new Date(naive + 'Z').getTime());
  });
  it('leaves explicit offsets alone', () => {
    const tagged = '2026-06-10T12:00:00+08:00';
    expect(utc(tagged).getTime()).toBe(new Date(tagged).getTime());
  });
});

describe('timeAgo', () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  it('reads now under 90s', () => expect(timeAgo(at(30_000))).toBe('now'));
  it('reads minutes under an hour', () => expect(timeAgo(at(45 * 60_000))).toBe('45m'));
  it('flips to hours at 60m', () => expect(timeAgo(at(64 * 60_000))).toBe('1h'));
  it('reads days then weeks', () => {
    expect(timeAgo(at(3 * 86_400_000))).toBe('3d');
    expect(timeAgo(at(21 * 86_400_000))).toBe('3w');
  });
});

describe('plainStage — the Submitter vocabulary (CONTEXT.md)', () => {
  it('maps the lifecycle to plain labels', () => {
    expect(plainStage(req()).label).toBe('Submitted');
    expect(plainStage(req({ status: 'pending_approval', stage: 'spec' })).label).toBe('Spec drafted');
    expect(plainStage(req({ status: 'sent_back', stage: 'spec' })).label).toBe('Needs your input');
    expect(plainStage(req({ status: 'approved', stage: 'build' })).label).toBe('Building');
    expect(plainStage(req({ status: 'approved', stage: 'review' })).label).toBe('In review');
    expect(plainStage(req({ status: 'done', stage: 'done' })).label).toBe('Deployed');
    expect(plainStage(req({ status: 'cancelled' })).label).toBe('Cancelled');
  });
  it('never leaks Control-center words', () => {
    const statuses: FactoryRequest['status'][] = ['submitted', 'pending_approval', 'approved', 'sent_back', 'cancelled', 'done'];
    for (const status of statuses) {
      const label = plainStage(req({ status })).label.toLowerCase();
      for (const word of ['spec gate', 'work item', 'triage', 'merge', 'escalat']) {
        expect(label).not.toContain(word);
      }
    }
  });
});

describe('boardGlyph — status by shape, colour layered on top', () => {
  it('escalation always wins as the red flag', () => {
    const g = boardGlyph(req({ needs_human: true, status: 'approved', stage: 'build' }));
    expect(g.glyph).toBe('flag');
    expect(g.color).toContain('red');
  });
  it('intake is the dotted triage circle', () => expect(boardGlyph(req()).glyph).toBe('dotted'));
  it('done is the green check', () => {
    const g = boardGlyph(req({ stage: 'done', status: 'done' }));
    expect(g.glyph).toBe('check');
    expect(g.color).toContain('green');
  });
  it('the ring fills as stages progress', () => {
    const spec = boardGlyph(req({ stage: 'spec', status: 'pending_approval' }));
    const review = boardGlyph(req({ stage: 'review', status: 'approved' }));
    expect(spec.glyph).toBe('ring');
    expect(review.fill).toBeGreaterThan(spec.fill);
  });
});

describe('gateLabel', () => {
  it('names the two human gates and nothing else', () => {
    expect(gateLabel(req({ gate: 'approve_spec' }))).toBe('Approve spec');
    expect(gateLabel(req({ gate: 'approve_merge' }))).toBe('Approve merge');
    expect(gateLabel(req())).toBeNull();
  });
});

describe('clock', () => {
  it('renders a wall-clock time without throwing on naive input', () => {
    expect(clock('2026-06-10T01:02:03')).toBeTruthy();
  });
});
