import { FactoryRequest, MissionOut, RequestDetail } from './models';

/** The 6 real stages (api/app/models.py:35). Deploy is folded into `done`. */
export const MAP_STAGES: { key: string; label: string }[] = [
  { key: 'intake', label: 'Intake' },
  { key: 'spec', label: 'Spec' },
  { key: 'architecture', label: 'Architecture' },
  { key: 'build', label: 'Build' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
];

/** Stages where agents run autonomously (CONTEXT.md / util.ts IN_FLIGHT_STAGES). */
const RUN_STAGES = ['architecture', 'build', 'review'];

export type MapState = 'gate' | 'stalled' | 'run' | 'sent' | 'triage' | 'done';

export interface MapCard {
  id: number;
  ref: string;
  title: string;
  app: string;
  type: string;
  state: MapState;
  step?: number;
  of?: number;
}
export interface MapColumn {
  key: string;
  label: string;
  cards: MapCard[];
}
export interface MapGate {
  key: 'approve_spec' | 'approve_merge';
  label: string;
  afterStage: string;
  waiting: number;
}
export interface FactoryMapView {
  columns: MapColumn[];
  gates: MapGate[];
}

/** Card state from a Request's lifecycle fields (priority order matters). */
function cardState(r: FactoryRequest): MapState {
  if (r.needs_human) return 'stalled';
  if (r.gate) return 'gate';
  if (r.status === 'sent_back') return 'sent';
  if (r.status === 'done' || r.stage === 'done') return 'done';
  if (r.status === 'approved' && RUN_STAGES.includes(r.stage)) return 'run';
  return 'triage';
}

/** Group every (non-cancelled) Work item into its stage column; overlay run-state
 *  (step/of) from the Mission poll; derive the two human-gate waiting counts. */
export function factoryColumns(
  requests: FactoryRequest[],
  mission: MissionOut | null,
): FactoryMapView {
  const runById = new Map<number, { step: number; of: number }>();
  for (const mr of mission?.runs ?? []) runById.set(mr.request.id, { step: mr.run.step, of: mr.run.of });

  const columns: MapColumn[] = MAP_STAGES.map((s) => ({ key: s.key, label: s.label, cards: [] }));
  const byKey = new Map(columns.map((c) => [c.key, c]));

  for (const r of requests) {
    if (r.status === 'cancelled') continue;
    const col = byKey.get(r.stage);
    if (!col) continue;
    const run = runById.get(r.id);
    col.cards.push({
      id: r.id, ref: r.ref, title: r.title, app: r.app_name, type: r.type,
      state: cardState(r), step: run?.step, of: run?.of,
    });
  }

  const gates: MapGate[] = [
    { key: 'approve_spec', label: 'Spec approval', afterStage: 'spec',
      waiting: requests.filter((r) => r.gate === 'approve_spec').length },
    { key: 'approve_merge', label: 'Merge gate', afterStage: 'review',
      waiting: requests.filter((r) => r.gate === 'approve_merge').length },
  ];

  return { columns, gates };
}

export type StageState = 'done' | 'todo' | 'run' | 'gate' | 'stalled' | 'sent' | 'triage';

export interface DeliveryStage {
  key: string;
  label: string;
  state: StageState;
  pct: number;
  artifact: string;
  detail: string;
}

/** The Artifact each Stage emits (CONTEXT.md). */
const ARTIFACT: Record<string, string> = {
  intake: 'Request + interview',
  spec: 'SPEC.md',
  architecture: 'PLAN.md + ADRs',
  build: 'Tests → implementation',
  review: 'Review report',
  done: 'Deployed',
};

/** State + completion of the Work item's *current* stage. */
function currentState(d: RequestDetail): { state: StageState; pct: number; detail: string } {
  const runPct = d.run ? Math.round((d.run.step / Math.max(1, d.run.of)) * 100) : 0;
  if (d.needs_human) return { state: 'stalled', pct: runPct || 40, detail: 'escalated — needs a human' };
  if (d.gate) return { state: 'gate', pct: 90, detail: d.gate === 'approve_merge' ? 'awaiting merge approval' : 'awaiting spec approval' };
  if (d.status === 'sent_back') return { state: 'sent', pct: 30, detail: 'with the submitter' };
  if (d.status === 'done' || d.stage === 'done') return { state: 'done', pct: 100, detail: 'deployed' };
  if (d.run) return { state: 'run', pct: runPct, detail: d.run.label ?? 'working' };
  if (d.status === 'approved') return { state: 'run', pct: 10, detail: 'starting' };
  return { state: 'triage', pct: 20, detail: 'in intake' };
}

/** One Work item's journey across the 6 stages: before = done, current = live, after = todo. */
export function deliveryStages(d: RequestDetail): DeliveryStage[] {
  const cur = MAP_STAGES.findIndex((s) => s.key === d.stage);
  return MAP_STAGES.map((s, j) => {
    if (j < cur) return { key: s.key, label: s.label, state: 'done', pct: 100, artifact: ARTIFACT[s.key], detail: 'artifact committed' };
    if (j > cur) return { key: s.key, label: s.label, state: 'todo', pct: 0, artifact: ARTIFACT[s.key], detail: 'not started' };
    const c = currentState(d);
    return { key: s.key, label: s.label, state: c.state, pct: c.pct, artifact: ARTIFACT[s.key], detail: c.detail };
  });
}

export interface DeliveryGate {
  label: string;
  state: 'passed' | 'await' | 'pending';
}

/** The two human gates for one Work item: passed if already crossed, await if parked here. */
export function deliveryGates(d: RequestDetail): DeliveryGate[] {
  const cur = MAP_STAGES.findIndex((s) => s.key === d.stage);
  const gate = (idx: number, gateVal: string, label: string): DeliveryGate => ({
    label,
    state: cur > idx ? 'passed' : cur === idx && d.gate === gateVal ? 'await' : 'pending',
  });
  // spec is index 1, review is index 4 in MAP_STAGES
  return [gate(1, 'approve_spec', 'Spec approval'), gate(4, 'approve_merge', 'Merge gate')];
}
