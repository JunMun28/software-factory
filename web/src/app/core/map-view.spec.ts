import { describe, expect, it } from 'vitest';

import { FactoryRequest, MissionOut, RequestDetail } from './models';
import {
  deliveryGates,
  deliveryStages,
  factoryColumns,
  MAP_STAGES,
  MapCard,
  sortedExceptions,
} from './map-view';

/** Minimal FactoryRequest factory — only the fields the map reads. */
function req(over: Partial<FactoryRequest>): FactoryRequest {
  return {
    id: 1,
    ref: 'REQ-1',
    title: 'T',
    description: '',
    type: 'enh',
    urgency: 'normal',
    reach: null,
    impact_metric: null,
    impact_value: null,
    priority: 'Normal',
    app_id: 1,
    app_name: 'App',
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
    created_at: '2026-06-14T00:00:00Z',
    updated_at: '2026-06-14T00:00:00Z',
    stage_entered_at: null,
    last_event: null,
    ...over,
  };
}

function mission(over: Partial<MissionOut> = {}): MissionOut {
  return { gates: [], runs: [], stalled: [], recent: [], cursor: 0, ...over };
}

describe('factoryColumns', () => {
  it('returns all 6 stages in order', () => {
    const v = factoryColumns([], mission());
    expect(v.columns.map((c) => c.key)).toEqual(MAP_STAGES.map((s) => s.key));
  });

  it('places a gate request in its stage column with state "gate"', () => {
    const r = req({ id: 41, stage: 'spec', status: 'pending_approval', gate: 'approve_spec' });
    const v = factoryColumns([r], mission());
    const spec = v.columns.find((c) => c.key === 'spec')!;
    expect(spec.cards).toHaveLength(1);
    expect(spec.cards[0].state).toBe('gate');
  });

  it('marks needs_human as "stalled" even when a gate is set', () => {
    const r = req({
      id: 43,
      stage: 'spec',
      status: 'submitted',
      needs_human: true,
      gate: 'approve_spec',
    });
    const v = factoryColumns([r], mission());
    expect(v.columns.find((c) => c.key === 'spec')!.cards[0].state).toBe('stalled');
  });

  it('attaches run step/of from mission.runs for an in-flight build', () => {
    const r = req({ id: 29, stage: 'build', status: 'approved' });
    const m = mission({
      runs: [
        {
          request: r,
          run: { step: 3, of: 6, label: 'x', health: 'healthy', seconds_since_event: 0 },
        },
      ],
    });
    const card = factoryColumns([r], m).columns.find((c) => c.key === 'build')!.cards[0];
    expect(card.state).toBe('run');
    expect(card.step).toBe(3);
    expect(card.of).toBe(6);
  });

  it('excludes cancelled requests from the map', () => {
    const r = req({ id: 30, stage: 'intake', status: 'cancelled' });
    const v = factoryColumns([r], mission());
    expect(v.columns.flatMap((c) => c.cards)).toHaveLength(0);
  });

  it('counts requests waiting at each human gate', () => {
    const reqs = [
      req({ id: 41, stage: 'spec', gate: 'approve_spec', status: 'pending_approval' }),
      req({ id: 42, stage: 'spec', gate: 'approve_spec', status: 'pending_approval' }),
    ];
    const v = factoryColumns(reqs, mission());
    expect(v.gates.find((g) => g.key === 'approve_spec')!.waiting).toBe(2);
    expect(v.gates.find((g) => g.key === 'approve_merge')!.waiting).toBe(0);
  });
});

function detail(over: Partial<RequestDetail>): RequestDetail {
  return {
    ...req({}),
    turns: [],
    spec_lines: [],
    comments: [],
    audit: [],
    duplicate: null,
    run: null,
    evidence: null,
    ...over,
  } as RequestDetail;
}

describe('deliveryStages', () => {
  it('marks passed stages done, current stage running, later stages todo', () => {
    const d = detail({
      stage: 'build',
      status: 'approved',
      run: {
        step: 3,
        of: 6,
        label: 'implementing the change',
        health: 'healthy',
        seconds_since_event: 0,
      },
    });
    const s = deliveryStages(d);
    const at = (k: string) => s.find((x) => x.key === k)!;
    expect(at('intake').state).toBe('done');
    expect(at('intake').pct).toBe(100);
    expect(at('spec').state).toBe('done');
    expect(at('architecture').state).toBe('done');
    expect(at('build').state).toBe('run');
    expect(at('build').pct).toBe(50); // 3/6
    expect(at('review').state).toBe('todo');
    expect(at('review').pct).toBe(0);
    expect(at('done').state).toBe('todo');
  });

  it('labels each stage with its Artifact', () => {
    const s = deliveryStages(
      detail({ stage: 'spec', status: 'pending_approval', gate: 'approve_spec' }),
    );
    expect(s.find((x) => x.key === 'spec')!.artifact).toBe('SPEC.md');
    expect(s.find((x) => x.key === 'build')!.artifact).toBe('Tests → implementation');
  });

  it('shows the current stage as gate when parked at a gate', () => {
    const s = deliveryStages(
      detail({ stage: 'spec', status: 'pending_approval', gate: 'approve_spec' }),
    );
    expect(s.find((x) => x.key === 'spec')!.state).toBe('gate');
  });
});

describe('deliveryGates', () => {
  it('passes earlier gates and leaves later ones pending', () => {
    const g = deliveryGates(detail({ stage: 'build', status: 'approved' }));
    expect(g.find((x) => x.label === 'Spec approval')!.state).toBe('passed');
    expect(g.find((x) => x.label === 'Merge gate')!.state).toBe('pending');
  });

  it('marks the active gate as awaiting', () => {
    const g = deliveryGates(detail({ stage: 'review', status: 'approved', gate: 'approve_merge' }));
    expect(g.find((x) => x.label === 'Merge gate')!.state).toBe('await');
  });
});

/** Minimal MapCard factory */
function card(id: number, state: MapCard['state']): MapCard {
  return { id, ref: `REQ-${id}`, title: `T${id}`, app: 'App', type: 'enh', state };
}

describe('sortedExceptions', () => {
  it('sorts by severity: stalled first, done last', () => {
    const cards = [
      card(1, 'done'),
      card(2, 'run'),
      card(3, 'stalled'),
      card(4, 'gate'),
      card(5, 'triage'),
      card(6, 'sent'),
    ];
    const sorted = sortedExceptions(cards);
    expect(sorted.map((c) => c.state)).toEqual(['stalled', 'gate', 'sent', 'run', 'triage']);
  });

  it('caps at the given limit', () => {
    const cards = [
      card(1, 'stalled'),
      card(2, 'gate'),
      card(3, 'run'),
      card(4, 'run'),
      card(5, 'run'),
      card(6, 'done'),
    ];
    expect(sortedExceptions(cards, 3)).toHaveLength(3);
  });

  it('returns fewer than cap when input is smaller', () => {
    const cards = [card(1, 'gate'), card(2, 'run')];
    expect(sortedExceptions(cards, 5)).toHaveLength(2);
  });

  it('does not mutate the input array', () => {
    const cards = [card(1, 'done'), card(2, 'stalled')];
    const copy = [...cards];
    sortedExceptions(cards, 5);
    expect(cards).toEqual(copy);
  });

  it('returns empty array for empty input', () => {
    expect(sortedExceptions([], 5)).toEqual([]);
  });

  it('default cap is 5', () => {
    const cards = Array.from({ length: 8 }, (_, i) => card(i + 1, 'run'));
    expect(sortedExceptions(cards)).toHaveLength(5);
  });
});
