import { describe, expect, it } from 'vitest';

import { Evidence, FactoryRequest, MissionOut, RequestDetail } from '@sf/shared';
import {
  adminStateLine,
  boardGlyph,
  clock,
  confirmSteps,
  elapsedShort,
  evidenceBits,
  gateLabel,
  groupTrace,
  healthLine,
  inFlight,
  liveStatus,
  missionRowLabel,
  missionSubtitle,
  missionSummary,
  plainActivity,
  plainStage,
  prototypeSrcdoc,
  timeAgo,
  utc,
} from './util';

function req(over: Partial<FactoryRequest> = {}): FactoryRequest {
  return {
    id: 1,
    ref: 'REQ-1',
    title: 't',
    description: '',
    type: 'enh',
    urgency: 'normal',
    reach: null,
    impact_metric: null,
    impact_value: null,
    bug_where: null,
    priority: 'Normal',
    app_id: 1,
    app_name: 'App',
    app_key: 'app',
    repo: null,
    prospective_repo: null,
    new_app_name: null,
    stage: 'intake',
    status: 'submitted',
    gate: null,
    needs_human: false,
    needs_human_reason: null,
    reporter: 'J',
    reporter_initials: 'JD',
    labels: null,
    send_back_question: null,
    send_back_response: null,
    send_back_rounds: 0,
    repo_ready: false,
    spec_pr_open: false,
    stage2_fired: false,
    spec_open_note: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stage_entered_at: null,
    last_event: null,
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
    expect(plainStage(req({ status: 'pending_approval', stage: 'spec' })).label).toBe(
      'Spec drafted',
    );
    expect(plainStage(req({ status: 'sent_back', stage: 'spec' })).label).toBe('Needs your input');
    expect(plainStage(req({ status: 'approved', stage: 'build' })).label).toBe('Building');
    expect(plainStage(req({ status: 'approved', stage: 'review' })).label).toBe('In review');
    expect(plainStage(req({ status: 'done', stage: 'done' })).label).toBe('Deployed');
    expect(plainStage(req({ status: 'cancelled' })).label).toBe('Cancelled');
  });
  it('never leaks Control-center words', () => {
    const statuses: FactoryRequest['status'][] = [
      'submitted',
      'pending_approval',
      'approved',
      'sent_back',
      'cancelled',
      'done',
    ];
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

describe('confirmSteps — the irreversible steps behind Approve', () => {
  it('spec gate: uses the real repo when the request has one', () => {
    const steps = confirmSteps(req({ gate: 'approve_spec', repo: 'micron/northwind' }));
    expect(steps[0]).toEqual(['Create the GitHub repo', 'micron/northwind']);
    expect(steps).toHaveLength(3);
  });
  it('spec gate: falls back to the server-derived prospective repo for app-less requests', () => {
    const steps = confirmSteps(
      req({ gate: 'approve_spec', repo: null, prospective_repo: 'micron/new-thing' }),
    );
    expect(steps[0][1]).toBe('micron/new-thing');
  });
  it('never derives a repo name client-side', () => {
    const steps = confirmSteps(
      req({ gate: 'approve_spec', repo: null, prospective_repo: null, title: 'Some New App' }),
    );
    expect(steps[0][1]).toBe('');
  });
  it('merge gate: lists merge → promote → deploy against the real repo', () => {
    const steps = confirmSteps(req({ gate: 'approve_merge', repo: 'micron/northwind' }));
    expect(steps[0]).toEqual(['Merge the PR to main', 'micron/northwind']);
    expect(steps[2][1]).toBe('Stage 6');
  });
});

describe('inFlight — agents working stage helper', () => {
  it('inFlight means agents working: post-approval stage, no gate, no escalation', () => {
    expect(inFlight(req({ stage: 'build', status: 'approved' }))).toBe(true);
    expect(inFlight(req({ stage: 'build', status: 'approved', needs_human: true }))).toBe(false);
    expect(inFlight(req({ stage: 'review', status: 'approved', gate: 'approve_merge' }))).toBe(
      false,
    );
    expect(inFlight(req({ stage: 'done', status: 'done' }))).toBe(false);
    expect(inFlight(req())).toBe(false);
  });
});

describe('elapsedShort', () => {
  it('formats seconds under a minute', () => {
    expect(elapsedShort(8)).toBe('8s');
    expect(elapsedShort(59)).toBe('59s');
  });
  it('formats minutes with seconds', () => {
    expect(elapsedShort(60)).toBe('1m 00s');
    expect(elapsedShort(100)).toBe('1m 40s');
    expect(elapsedShort(3599)).toBe('59m 59s');
  });
  it('formats hours above an hour', () => {
    expect(elapsedShort(3600)).toBe('1h');
    expect(elapsedShort(9000)).toBe('2h 30m');
  });
  it('never renders 60m — floors the minutes remainder', () => {
    expect(elapsedShort(7170)).toBe('1h 59m');
  });
});

describe('healthLine', () => {
  it('renders a healthy run', () => {
    expect(
      healthLine({
        step: 3,
        of: 6,
        label: 'implementing the change',
        health: 'healthy',
        seconds_since_event: 100,
      }),
    ).toBe('implementing the change · 1m 40s · healthy');
  });
  it('renders a slow run', () => {
    expect(
      healthLine({
        step: 2,
        of: 9,
        label: 'running the test suite',
        health: 'slow',
        seconds_since_event: 305,
      }),
    ).toBe('running the test suite · 5m 05s · slow');
  });
  it('renders no signal without a label', () => {
    expect(
      healthLine({ step: 0, of: 4, label: null, health: 'no_signal', seconds_since_event: 12 }),
    ).toBe('no signal for 12s');
  });
});

describe('evidenceBits', () => {
  const base = {
    grounded_lines: null,
    total_lines: null,
    interview_count: null,
    tests_passed: null,
    tests_total: null,
    diff_added: null,
    diff_removed: null,
    files_changed: null,
    reviewer_verdict: null,
    assumptions: [] as string[],
  };
  it('null evidence → single "no evidence recorded" bit', () => {
    expect(evidenceBits(null)).toEqual([{ text: 'no evidence recorded', tone: '' }]);
  });
  it('spec gate → grounded-lines + interview bits', () => {
    const bits = evidenceBits({
      ...base,
      kind: 'spec',
      grounded_lines: 3,
      total_lines: 4,
      interview_count: 4,
    } as Evidence);
    expect(bits[0]).toEqual({ text: '3 of 4 lines grounded in answers', tone: 'green' });
    expect(bits[1]).toEqual({ text: 'spec drafted from interview (4 Q)', tone: '' });
  });
  it('spec gate with no interview omits the interview bit', () => {
    const bits = evidenceBits({
      ...base,
      kind: 'spec',
      grounded_lines: 2,
      total_lines: 3,
      interview_count: 0,
    } as Evidence);
    expect(bits).toHaveLength(1);
  });
  it('merge gate → tests + diff + reviewer bits', () => {
    const bits = evidenceBits({
      ...base,
      kind: 'merge',
      tests_passed: 8,
      tests_total: 8,
      diff_added: 412,
      diff_removed: 38,
      files_changed: 9,
      reviewer_verdict: 'no blocking findings',
    } as Evidence);
    expect(bits[0]).toEqual({ text: '8/8 tests pass', tone: 'green' });
    expect(bits[1]).toEqual({ text: 'diff +412 −38 · 9 files', tone: '' });
    expect(bits[2]).toEqual({ text: 'reviewer: no blocking findings', tone: 'purple' });
  });
  it('all tests passing stays green with "pass"', () => {
    const bits = evidenceBits({
      ...base,
      kind: 'merge',
      tests_passed: 8,
      tests_total: 8,
    } as Evidence);
    expect(bits[0]).toEqual({ text: '8/8 tests pass', tone: 'green' });
  });
  it('diverged test counts are not green and do not claim "pass"', () => {
    const bits = evidenceBits({
      ...base,
      kind: 'merge',
      tests_passed: 5,
      tests_total: 8,
    } as Evidence);
    expect(bits[0].tone).not.toBe('green');
    expect(bits[0].text).not.toContain('pass');
    expect(bits[0]).toEqual({ text: '3/8 tests failing', tone: 'red' });
  });
  it('merge gate with no verification fields → no evidence recorded', () => {
    expect(evidenceBits({ ...base, kind: 'merge' } as Evidence)).toEqual([
      { text: 'no evidence recorded', tone: '' },
    ]);
  });
});

describe('groupTrace', () => {
  const ev = (
    id: number,
    kind: string,
    stage: string,
    payload: Record<string, unknown> = {},
    title = '',
  ) =>
    ({
      id,
      kind,
      stage,
      payload,
      title,
      actor: 'Factory',
      bot: true,
      broadcast: false,
      request_id: 1,
      subject_id: 1,
      body: null,
      created_at: '2026-06-12T00:00:00Z',
      request_ref: null,
      request_title: null,
    }) as any;

  it('groups consecutive events by stage in order', () => {
    const g = groupTrace([
      ev(1, 'step_summary', 'architecture', { step: 1, of: 4, label: 'reading SPEC.md' }),
      ev(2, 'step_summary', 'architecture', { step: 2, of: 4, label: 'drafting PLAN.md' }),
      ev(3, 'step_summary', 'build', { step: 1, of: 6, label: 'authoring failing tests' }),
    ]);
    expect(g.map((x) => x.stage)).toEqual(['architecture', 'build']);
    expect(g[0].rows).toHaveLength(2);
    expect(g[1].rows).toHaveLength(1);
  });

  it('marks a step that acknowledges a steer note', () => {
    const g = groupTrace([
      ev(5, 'steer_note', 'build', {}, 'Reuse the CSV parser'),
      ev(6, 'step_summary', 'build', {
        step: 3,
        of: 6,
        label: 'implementing',
        acked_steer_ids: [5],
      }),
    ]);
    const rows = g[0].rows;
    expect(rows.find((r) => r.kind === 'steer_note')?.acked).toBe(true);
    expect(rows.find((r) => r.kind === 'step_summary')?.acksSteer).toBe(true);
  });

  it('keeps gate and verification events as rows', () => {
    const g = groupTrace([
      ev(7, 'verification', 'review', { tests_passed: 8 }, 'Verification report'),
      ev(8, 'gate_event', 'review', { gate: 'approve_merge' }, 'Waiting at the merge gate'),
    ]);
    expect(g[0].rows.map((r) => r.kind)).toEqual(['verification', 'gate_event']);
  });
});

describe('plainActivity', () => {
  const run = (label: string | null, step = 6, of = 9) => ({
    label,
    step,
    of,
    health: 'healthy' as const,
    seconds_since_event: 5,
  });
  it('translates a known admin label to plain words with progress', () => {
    expect(plainActivity(run('authoring failing tests'))).toBe('writing tests · step 6 of 9');
    expect(plainActivity(run('implementing the change'))).toBe('making the change · step 6 of 9');
    expect(plainActivity(run('running the review pass'))).toBe('reviewing the work · step 6 of 9');
  });
  it('NEVER leaks an unknown/internal label — falls back to a safe phrase', () => {
    expect(plainActivity(run('git rebase onto main'))).toBe('working on it · step 6 of 9');
    expect(plainActivity(run('SPEC.md PR #142'))).toBe('working on it · step 6 of 9');
    expect(plainActivity(run(null))).toBe('working on it · step 6 of 9');
  });
  it('omits progress when step/of are missing', () => {
    expect(
      plainActivity({
        label: 'refactoring',
        step: 0,
        of: 0,
        health: 'no_signal',
        seconds_since_event: 1,
      }),
    ).toBe('tidying up');
  });
  it('returns null for no run', () => {
    expect(plainActivity(null)).toBeNull();
  });
});

describe('liveStatus — the submitter aria-live announcement', () => {
  const run = (label: string | null, step = 6, of = 9) => ({
    label,
    step,
    of,
    health: 'healthy' as const,
    seconds_since_event: 5,
  });

  it('pairs the plain stage with the live activity while building', () => {
    expect(
      liveStatus(req({ status: 'approved', stage: 'build' }), run('implementing the change')),
    ).toBe('Building — making the change · step 6 of 9');
  });

  it('pairs the plain stage with the live activity during review', () => {
    expect(
      liveStatus(req({ status: 'approved', stage: 'review' }), run('running the review pass')),
    ).toBe('In review — reviewing the work · step 6 of 9');
  });

  it('falls back to the bare label when nothing is in flight', () => {
    expect(liveStatus(req({ status: 'pending_approval', stage: 'spec' }), null)).toBe(
      'Spec drafted',
    );
    expect(liveStatus(req({ status: 'done', stage: 'done' }), null)).toBe('Deployed');
  });

  it('omits activity when a gate or escalation has paused the agents', () => {
    expect(
      liveStatus(
        req({ status: 'approved', stage: 'build', needs_human: true }),
        run('implementing the change'),
      ),
    ).toBe('Building');
  });

  it('never leaks an internal label into the announcement', () => {
    expect(
      liveStatus(req({ status: 'approved', stage: 'build' }), run('git rebase onto main')),
    ).toBe('Building — working on it · step 6 of 9');
  });
});

describe('missionSummary — the Mission control aria-live summary', () => {
  const mission = (over: Partial<MissionOut> = {}): MissionOut => ({
    gates: [],
    runs: [],
    stalled: [],
    human_owned: [],
    recent: [],
    cursor: 0,
    ...over,
  });
  const gate = () => ({ request: req(), evidence: null });
  const runItem = () => ({
    request: req(),
    run: { label: 'x', step: 1, of: 4, health: 'healthy' as const, seconds_since_event: 1 },
    steer: null,
  });

  it('says all clear when nothing needs the admin', () => {
    expect(missionSummary(mission())).toBe('All clear — nothing needs you');
  });

  it('pluralises gates and leads with the attention items', () => {
    expect(missionSummary(mission({ gates: [gate()] }))).toBe('1 gate waiting on you');
    expect(missionSummary(mission({ gates: [gate(), gate()] }))).toBe('2 gates waiting on you');
  });

  it('joins gates, stalled, and running in consequence order', () => {
    expect(
      missionSummary(
        mission({
          gates: [gate(), gate()],
          stalled: [req()],
          runs: [runItem(), runItem(), runItem()],
        }),
      ),
    ).toBe('2 gates waiting on you · 1 stalled · 3 running');
  });

  it('omits the zero bands — running only', () => {
    expect(missionSummary(mission({ runs: [runItem()] }))).toBe('1 running');
  });
});

describe('missionSubtitle — the Mission header counts', () => {
  const mission = (over: Partial<MissionOut> = {}): MissionOut => ({
    gates: [],
    runs: [],
    stalled: [],
    human_owned: [],
    recent: [],
    cursor: 0,
    ...over,
  });
  const gate = () => ({ request: req(), evidence: null });
  const runItem = () => ({
    request: req(),
    run: { label: 'x', step: 1, of: 4, health: 'healthy' as const, seconds_since_event: 1 },
    steer: null,
  });

  it('keeps the existing wording when nothing is stalled', () => {
    expect(
      missionSubtitle(
        mission({ gates: [gate(), gate()], runs: [runItem(), runItem(), runItem()] }),
      ),
    ).toBe('2 gates waiting on you · 3 builds running');
  });

  it('surfaces the stalled count between gates and builds when present', () => {
    expect(
      missionSubtitle(
        mission({
          gates: [gate(), gate()],
          stalled: [req()],
          runs: [runItem(), runItem(), runItem()],
        }),
      ),
    ).toBe('2 gates waiting on you · 1 stalled · 3 builds running');
  });

  it('singularises gate and build', () => {
    expect(missionSubtitle(mission({ gates: [gate()], runs: [runItem()] }))).toBe(
      '1 gate waiting on you · 1 build running',
    );
  });

  it('shows the zeros when all clear (unchanged from before)', () => {
    expect(missionSubtitle(mission())).toBe('0 gates waiting on you · 0 builds running');
  });
});

describe('missionRowLabel — the Mission row screen-reader label', () => {
  const base = { title: 'CSV import', app_name: 'Vendor Portal', ref: 'REQ-2042' } as const;
  const tail = ' — CSV import, Vendor Portal, REQ-2042';

  it('labels gates by their kind', () => {
    expect(missionRowLabel('gate', req({ ...base, gate: 'approve_spec' }))).toBe(
      `Spec gate, needs your approval${tail}`,
    );
    expect(missionRowLabel('gate', req({ ...base, gate: 'approve_merge' }))).toBe(
      `Merge gate, needs your approval${tail}`,
    );
  });

  it('labels a stalled row', () => {
    expect(missionRowLabel('stalled', req(base))).toBe(`Stalled, needs a human${tail}`);
  });

  it('labels a running row with its stage', () => {
    expect(missionRowLabel('run', req({ ...base, stage: 'build' }))).toBe(`Running build${tail}`);
  });

  it('labels recently-done rows by outcome', () => {
    expect(missionRowLabel('done', req({ ...base, status: 'done' }))).toBe(`Deployed${tail}`);
    expect(missionRowLabel('done', req({ ...base, status: 'cancelled' }))).toBe(`Cancelled${tail}`);
    expect(missionRowLabel('done', req({ ...base, status: 'sent_back' }))).toBe(`Sent back${tail}`);
  });
});

describe('adminStateLine — the admin request-detail live state', () => {
  const detail = (over: Partial<RequestDetail> = {}): RequestDetail => ({
    ...req(),
    turns: [],
    spec_lines: [],
    comments: [],
    audit: [],
    duplicate: null,
    run: null,
    evidence: null,
    ...over,
  });

  it('escalation wins over a gate', () => {
    expect(
      adminStateLine(detail({ needs_human: true, gate: 'approve_merge', status: 'approved' })),
    ).toBe('Stalled — needs a human');
  });

  it('names each gate', () => {
    expect(adminStateLine(detail({ gate: 'approve_spec' }))).toBe('Waiting at the spec gate');
    expect(adminStateLine(detail({ gate: 'approve_merge' }))).toBe('Waiting at the merge gate');
  });

  it('covers the terminal and handed-back states', () => {
    expect(adminStateLine(detail({ status: 'sent_back' }))).toBe('With the submitter');
    expect(adminStateLine(detail({ status: 'done', stage: 'done' }))).toBe('Deployed');
    expect(adminStateLine(detail({ status: 'cancelled' }))).toBe('Cancelled');
  });

  it('shows live build progress when a run is in flight', () => {
    const run = { label: 'x', step: 3, of: 6, health: 'healthy' as const, seconds_since_event: 1 };
    expect(adminStateLine(detail({ status: 'approved', stage: 'architecture', run }))).toBe(
      'Building · Architecture · step 3/6',
    );
  });

  it('shows the building stage when approved with no run yet', () => {
    expect(adminStateLine(detail({ status: 'approved', stage: 'build', run: null }))).toBe(
      'Building · Build',
    );
  });

  it('falls back to the stage label otherwise', () => {
    expect(adminStateLine(detail({ status: 'submitted', stage: 'intake' }))).toBe('Intake');
  });
});

describe('prototypeSrcdoc', () => {
  const CSP = 'Content-Security-Policy';

  it('strips the doc CSP and injects an authoritative one into <head>', () => {
    const doc =
      '<!doctype html><html><head>' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">' +
      '<title>x</title></head><body>hi</body></html>';
    const out = prototypeSrcdoc(doc);
    // exactly one CSP meta remains — the injected one (the doc's was stripped)
    expect(out.match(new RegExp(CSP, 'g'))!.length).toBe(1);
    expect(out).toContain("script-src 'unsafe-inline'"); // inline scripts allowed (mock + inspector)
    expect(out).toContain("connect-src 'none'"); // network blocked
    expect(out.indexOf(CSP)).toBeLessThan(out.indexOf('<title>')); // injected at the top of <head>
  });

  it('handles content-first / unquoted / mixed-case CSP metas', () => {
    const doc =
      '<html><head><META CONTENT=foo HTTP-EQUIV=content-security-policy><title>t</title></head><body></body></html>';
    const out = prototypeSrcdoc(doc);
    expect(out).not.toContain('CONTENT=foo'); // the shipped CSP meta is gone
    expect(out.match(new RegExp(CSP, 'gi'))!.length).toBe(1);
  });

  it('appends extra markup (the inspector) before </body>', () => {
    const out = prototypeSrcdoc('<html><body><p>x</p></body></html>', '<script>1</script>');
    expect(out).toContain('<script>1</script></body>');
  });

  it('injects a CSP even when the doc has no <head>', () => {
    const out = prototypeSrcdoc('<div>bare</div>');
    expect(out).toContain(CSP);
    expect(out.indexOf(CSP)).toBeLessThan(out.indexOf('<div>bare'));
  });
});
