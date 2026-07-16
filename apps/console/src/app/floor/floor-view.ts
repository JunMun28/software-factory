import {
  Evidence,
  EvidenceBit,
  FactoryRequest,
  MissionOut,
  RunState,
  evidenceBits,
  timeAgo,
} from '@sf/shared';

/* ── Pipeline board: five fixed columns, two approval boundaries ──
   The two human gates live in the geometry: Architecture opens only by
   spec approval, Deploy only by merge approval. Everything between runs
   on its own. */

export interface BoardColumnDef {
  key: 'intake' | 'architecture' | 'build' | 'review' | 'deploy';
  label: string;
  sub: string;
  /** Non-null → entering this column requires a human approval. */
  gate: string | null;
}

export const BOARD_COLUMNS: readonly BoardColumnDef[] = [
  { key: 'intake', label: 'Intake & Spec', sub: 'interview → grounded spec', gate: null },
  {
    key: 'architecture',
    label: 'Architecture',
    sub: 'plan from the approved spec',
    gate: 'spec approval',
  },
  { key: 'build', label: 'Build', sub: 'failing tests → green → refactor', gate: null },
  { key: 'review', label: 'Review & Preview', sub: 'independent read of the diff', gate: null },
  { key: 'deploy', label: 'Deploy', sub: 'merge → image → live pod', gate: 'merge approval' },
];

/** How many shipped requests the Deploy column keeps visible under the live ones. */
const SHIPPED_SHOWN = 5;

export type CardTone = 'run' | 'wait' | 'gate' | 'human' | 'owned' | 'draft' | 'done';

export interface BoardCard {
  id: number;
  ref: string;
  title: string;
  app: string;
  tone: CardTone;
  /** sf-glyph type; gates render their own ◆ marker instead. */
  glyph: 'dotted' | 'ring' | 'check' | 'flag' | null;
  state: string;
  /** in-stage progress 0..1, only when a live run reports steps */
  progress: number | null;
  /** compact time in current stage, e.g. "4h" — null for shipped cards */
  age: string | null;
  /** sort keys, not rendered */
  enteredMs: number;
  updatedMs: number;
}

export interface BoardColumn extends BoardColumnDef {
  cards: BoardCard[];
  count: number;
}

const COLUMN_OF: Record<FactoryRequest['stage'], BoardColumnDef['key'] | 'done'> = {
  intake: 'intake',
  spec: 'intake',
  architecture: 'architecture',
  build: 'build',
  review: 'review',
  deploy: 'deploy',
  done: 'done',
};

export function deriveCard(r: FactoryRequest, run: RunState | null): BoardCard {
  const base = {
    id: r.id,
    ref: r.ref,
    title: r.title,
    app: r.app_name || r.new_app_name || 'New app',
    progress: null as number | null,
    age: r.stage_entered_at ? timeAgo(r.stage_entered_at) : null,
    enteredMs: r.stage_entered_at ? Date.parse(r.stage_entered_at) : 0,
    updatedMs: Date.parse(r.updated_at) || 0,
  };
  if (r.status === 'done')
    return {
      ...base,
      tone: 'done',
      glyph: 'check',
      state: `Shipped · ${timeAgo(r.updated_at)}`,
      age: null,
    };
  if (r.needs_human)
    return {
      ...base,
      tone: 'human',
      glyph: 'flag',
      state: r.needs_human_reason || 'Needs a human',
    };
  if (r.status === 'human_owned')
    return { ...base, tone: 'owned', glyph: 'flag', state: 'Human-owned · automation off' };
  if (r.gate === 'approve_spec')
    return { ...base, tone: 'gate', glyph: null, state: 'Approval starts the build' };
  if (r.gate === 'approve_merge')
    return { ...base, tone: 'gate', glyph: null, state: 'Approval deploys it' };
  if (r.gate === 'approve_deploy')
    return { ...base, tone: 'gate', glyph: null, state: 'Approval deploys it' };
  if (r.status === 'sent_back')
    return { ...base, tone: 'wait', glyph: 'dotted', state: 'With the submitter · question open' };
  if (r.status === 'draft')
    return { ...base, tone: 'draft', glyph: 'dotted', state: 'Draft · not submitted yet' };
  if (run) {
    const quiet = run.health !== 'healthy';
    return {
      ...base,
      tone: 'run',
      glyph: 'ring',
      state: quiet
        ? `Quiet · no signal recently`
        : `${run.label || 'Working'} · ${run.step}/${run.of}`,
      progress: run.of ? Math.min(1, run.step / run.of) : null,
    };
  }
  if (r.stage === 'deploy')
    return {
      ...base,
      tone: 'run',
      glyph: 'ring',
      state: r.last_event || 'Building image · deploying',
    };
  if (r.stage === 'intake' || r.stage === 'spec')
    return {
      ...base,
      tone: 'wait',
      glyph: 'dotted',
      state: r.status === 'submitted' ? 'Interview in progress' : 'Drafting the spec',
    };
  return { ...base, tone: 'run', glyph: 'ring', state: r.last_event || 'Working' };
}

/** The whole board from the requests projection + mission run overlays. */
export function deriveBoard(
  requests: FactoryRequest[],
  runs: Map<number, RunState>,
): BoardColumn[] {
  const open = requests.filter((r) => r.status !== 'cancelled');
  const columns = BOARD_COLUMNS.map((def) => ({ ...def, cards: [] as BoardCard[], count: 0 }));
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const shipped: BoardCard[] = [];
  for (const r of open) {
    const key = COLUMN_OF[r.stage] ?? 'intake';
    if (key === 'done') {
      shipped.push(deriveCard(r, null));
      continue;
    }
    byKey.get(key)!.cards.push(deriveCard(r, runs.get(r.id) ?? null));
  }
  for (const col of columns) {
    // Oldest in stage first: the card closest to needing attention leads.
    col.cards.sort((a, b) => a.enteredMs - b.enteredMs);
    col.count = col.cards.length;
  }
  shipped.sort((a, b) => b.updatedMs - a.updatedMs);
  const deploy = byKey.get('deploy')!;
  deploy.count = deploy.cards.length;
  deploy.cards = [...deploy.cards, ...shipped.slice(0, SHIPPED_SHOWN)];
  return columns;
}

/* ── Waiting on you: the decision queue ── */

export type QueueKind = 'gate' | 'stalled' | 'owned';

export interface QueueItem {
  kind: QueueKind;
  request: FactoryRequest;
  evidence: Evidence | null;
  /** gate rows only: what an approval unlocks, in the admin's words */
  headline: string | null;
  consequence: string | null;
  facts: EvidenceBit[];
  /** owned rows only */
  owner: string | null;
}

export function deriveQueue(m: MissionOut): QueueItem[] {
  const gates: QueueItem[] = m.gates.map((g) => ({
    kind: 'gate',
    request: g.request,
    evidence: g.evidence,
    headline:
      g.request.gate === 'approve_deploy'
        ? 'Approve to go live'
        : g.request.gate === 'approve_merge'
          ? 'Approve to deploy'
          : 'Approve to build',
    consequence:
      g.request.gate === 'approve_deploy'
        ? `builds and deploys ${g.request.app_name || 'the app'}`
        : g.request.gate === 'approve_merge'
          ? `merges to main and deploys ${g.request.app_name || 'the app'}`
          : 'accepts the spec and starts architecture + build',
    facts: evidenceBits(g.evidence),
    owner: null,
  }));
  const stalled: QueueItem[] = m.stalled.map((request) => ({
    kind: 'stalled',
    request,
    evidence: null,
    headline: null,
    consequence: null,
    facts: [],
    owner: null,
  }));
  const owned: QueueItem[] = m.human_owned.map((o) => ({
    kind: 'owned',
    request: o.request,
    evidence: null,
    headline: null,
    consequence: null,
    facts: [],
    owner: o.taken_over_by,
  }));
  return [...gates, ...stalled, ...owned];
}

/** Header math: the one-line pulse of the factory. */
export function deriveTallies(m: MissionOut, requests: FactoryRequest[]) {
  const open = requests.filter((r) => r.status !== 'cancelled' && r.status !== 'done');
  return {
    open: open.length,
    deciding: m.gates.length,
    attention: m.stalled.length + m.human_owned.length,
    shipped: m.recent.filter((r) => r.outcome === 'approved_merge').length,
  };
}
