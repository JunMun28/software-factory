import { FactoryRequest, MissionOut } from './models';

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
