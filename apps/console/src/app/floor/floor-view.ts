import {
  Evidence,
  EvidenceBit,
  FactoryRequest,
  MissionOut,
  RunState,
  evidenceBits,
  timeAgo,
} from '@sf/shared';

/* ── The line: every request as one track across five stages ──
   The two human gates live in the geometry: a ◆ joint between
   Intake & Spec → Architecture (build approval) and between
   Review & Preview → Deploy (deploy approval). Everything between
   the joints runs on its own. */

export interface StageDef {
  key: 'intake' | 'architecture' | 'build' | 'review' | 'deploy';
  label: string;
  /** Non-null → a human approval opens this stage; drawn as a ◆ joint on the track. */
  gate: string | null;
}

export const STAGES: readonly StageDef[] = [
  { key: 'intake', label: 'Intake & Spec', gate: null },
  { key: 'architecture', label: 'Architecture', gate: 'Build approval' },
  { key: 'build', label: 'Build', gate: null },
  { key: 'review', label: 'Review & Preview', gate: null },
  { key: 'deploy', label: 'Deploy', gate: 'Deploy approval' },
];

const STAGE_INDEX: Record<FactoryRequest['stage'], number> = {
  intake: 0,
  spec: 0,
  architecture: 1,
  build: 2,
  review: 3,
  deploy: 4,
  done: 5,
};

export type SegState = 'done' | 'current' | 'todo';
export type GateState = 'todo' | 'waiting' | 'passed';
export type RowTone = 'run' | 'wait' | 'gate' | 'human' | 'owned' | 'draft' | 'done';

export interface TrackRow {
  id: number;
  ref: string;
  title: string;
  app: string;
  tone: RowTone;
  /** one entry per stage; 'current' is where the request sits right now */
  segs: SegState[];
  /** the two approval joints: [build approval, deploy approval] */
  gates: [GateState, GateState];
  /** in-stage progress 0..1, only when a live run reports steps */
  progress: number | null;
  /** right-hand status text, in the admin's words */
  state: string;
  glyph: 'dotted' | 'ring' | 'check' | 'flag' | null;
  /** compact time in current stage, e.g. "4h" — null for shipped rows */
  age: string | null;
  /** sort keys, not rendered */
  stageIndex: number;
  enteredMs: number;
  updatedMs: number;
}

export interface LineView {
  /** live rows, closest-to-shipping first */
  rows: TrackRow[];
  /** recently shipped, newest first (capped) */
  shipped: TrackRow[];
  /** live requests sitting in each of the five stages */
  counts: number[];
  /** requests parked at [build approval, deploy approval] right now */
  gateCounts: [number, number];
}

/** How many shipped requests stay visible under the live rows. */
const SHIPPED_SHOWN = 5;

const TONE_RANK: Record<RowTone, number> = {
  human: 0,
  gate: 1,
  owned: 2,
  run: 3,
  wait: 4,
  draft: 5,
  done: 6,
};

function gateStates(r: FactoryRequest, stageIndex: number): [GateState, GateState] {
  const atGate1 = r.gate === 'approve_spec';
  const atGate2 = r.gate === 'approve_merge' || r.gate === 'approve_deploy';
  const gate1: GateState = atGate1 ? 'waiting' : stageIndex >= 1 ? 'passed' : 'todo';
  const gate2: GateState = atGate2
    ? 'waiting'
    : stageIndex >= 5 || (stageIndex === 4 && !r.gate)
      ? 'passed'
      : 'todo';
  return [gate1, gate2];
}

function segStates(stageIndex: number, parkedAtGate: boolean): SegState[] {
  return STAGES.map((_, i) => {
    if (stageIndex >= 5) return 'done';
    if (i < stageIndex) return 'done';
    if (i === stageIndex) return parkedAtGate ? 'done' : 'current';
    return 'todo';
  });
}

export function deriveTrack(r: FactoryRequest, run: RunState | null): TrackRow {
  const stageIndex = STAGE_INDEX[r.stage] ?? 0;
  const parkedAtGate = r.gate !== null;
  const base = {
    id: r.id,
    ref: r.ref,
    title: r.title,
    app: r.app_name || r.new_app_name || 'New app',
    segs: segStates(stageIndex, parkedAtGate),
    gates: gateStates(r, stageIndex),
    progress: null as number | null,
    age: r.stage_entered_at ? timeAgo(r.stage_entered_at) : null,
    stageIndex,
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
    return { ...base, tone: 'gate', glyph: null, state: 'Holding for build approval' };
  if (r.gate === 'approve_merge' || r.gate === 'approve_deploy')
    return { ...base, tone: 'gate', glyph: null, state: 'Holding for deploy approval' };
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
        ? 'Quiet · no signal recently'
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

/** The whole line from the requests projection + mission run overlays. */
export function deriveLine(requests: FactoryRequest[], runs: Map<number, RunState>): LineView {
  const open = requests.filter((r) => r.status !== 'cancelled');
  const rows: TrackRow[] = [];
  const shipped: TrackRow[] = [];
  const counts = STAGES.map(() => 0);
  const gateCounts: [number, number] = [0, 0];
  for (const r of open) {
    const track = deriveTrack(r, runs.get(r.id) ?? null);
    if (track.tone === 'done') {
      shipped.push(track);
      continue;
    }
    counts[Math.min(track.stageIndex, 4)] += 1;
    if (track.gates[0] === 'waiting') gateCounts[0] += 1;
    if (track.gates[1] === 'waiting') gateCounts[1] += 1;
    rows.push(track);
  }
  // Closest to shipping on top; urgency breaks ties; then longest in stage.
  rows.sort(
    (a, b) =>
      b.stageIndex - a.stageIndex ||
      TONE_RANK[a.tone] - TONE_RANK[b.tone] ||
      a.enteredMs - b.enteredMs,
  );
  shipped.sort((a, b) => b.updatedMs - a.updatedMs);
  return { rows, shipped: shipped.slice(0, SHIPPED_SHOWN), counts, gateCounts };
}

/* ── Needs you: the decision rail ── */

export type QueueKind = 'gate' | 'stalled' | 'owned';

export interface QueueItem {
  kind: QueueKind;
  request: FactoryRequest;
  evidence: Evidence | null;
  /** gate rows only: what an approval unlocks, in the admin's words */
  headline: string | null;
  facts: EvidenceBit[];
  /** owned rows only */
  owner: string | null;
  /** time waiting at this gate/stage — the queue's aging signal */
  age: string | null;
  /** waited past a day: escalate the row visually */
  aged: boolean;
}

/** Urgency captured at intake finally orders the queue (gap #3). */
const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const AGED_AFTER_MS = 24 * 60 * 60 * 1000;

function queueMeta(r: FactoryRequest): { age: string | null; aged: boolean; entered: number } {
  const entered = r.stage_entered_at ? Date.parse(r.stage_entered_at) : 0;
  return {
    age: r.stage_entered_at ? timeAgo(r.stage_entered_at) : null,
    aged: entered > 0 && Date.now() - entered > AGED_AFTER_MS,
    entered,
  };
}

function priorityRank(r: FactoryRequest): number {
  return PRIORITY_RANK[(r.priority || 'normal').toLowerCase()] ?? 2;
}

type Aging = QueueItem & { entered: number };

export function deriveQueue(m: MissionOut): QueueItem[] {
  const gates: Aging[] = m.gates.map((g) => ({
    kind: 'gate' as const,
    request: g.request,
    evidence: g.evidence,
    headline:
      g.request.gate === 'approve_deploy'
        ? 'Approve to go live'
        : g.request.gate === 'approve_merge'
          ? 'Approve to deploy'
          : 'Approve to build',
    facts: evidenceBits(g.evidence),
    owner: null,
    ...queueMeta(g.request),
  }));
  // Highest priority first; ties go to whoever has waited longest.
  gates.sort((a, b) => priorityRank(a.request) - priorityRank(b.request) || a.entered - b.entered);
  const stalled: Aging[] = m.stalled.map((request) => ({
    kind: 'stalled' as const,
    request,
    evidence: null,
    headline: null,
    facts: [],
    owner: null,
    ...queueMeta(request),
  }));
  const owned: Aging[] = m.human_owned.map((o) => ({
    kind: 'owned' as const,
    request: o.request,
    evidence: null,
    headline: null,
    facts: [],
    owner: o.taken_over_by,
    ...queueMeta(o.request),
  }));
  return [...gates, ...stalled, ...owned].map(({ entered: _entered, ...item }) => item);
}

/** The rail chip: which approval (or condition) this card is about. */
export function queueChip(item: QueueItem): string {
  if (item.kind === 'stalled') return 'Needs human';
  if (item.kind === 'owned') return 'Human-owned';
  return item.request.gate === 'approve_spec' ? 'Build approval' : 'Deploy approval';
}

/** Compact hours for the pulse line: <1h · 7h · 3d. */
export function fmtHours(h: number): string {
  if (h < 1) return '<1h';
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/** Header math: the one-line pulse of the factory. */
export function deriveTallies(m: MissionOut, requests: FactoryRequest[]) {
  const open = requests.filter((r) => r.status !== 'cancelled' && r.status !== 'done');
  const stats = m.stats ?? null;
  return {
    open: open.length,
    deciding: m.gates.length,
    attention: m.stalled.length + m.human_owned.length,
    shipped: stats?.shipped_7d ?? m.recent.filter((r) => r.outcome === 'approved_merge').length,
    cycle: stats?.cycle_median_h != null ? fmtHours(stats.cycle_median_h) : null,
    gateWait: stats?.gate_wait_median_h != null ? fmtHours(stats.gate_wait_median_h) : null,
  };
}
