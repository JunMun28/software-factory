import { FactoryRequest, MissionOut, RunState, timeAgo } from '@sf/shared';

/* ── The five displayed stages ──
   A DISPLAY-only projection over the backend's finer stage machine. The agent
   code-review loop is folded into BUILD (backend stage `review`); the requester
   preview becomes its own REVIEW lane (backend stage `preview`). Nothing here
   writes back — request.stage and the append-only log are untouched. */

export interface DisplayStageDef {
  key: 'spec' | 'arch' | 'build' | 'review' | 'deploy';
  label: string;
  /** the agent that owns the stage — a mono name plate on the lane */
  agent: string;
  /** the single human moment that ends the stage */
  gate: string;
}

export const DISPLAY_STAGES: readonly DisplayStageDef[] = [
  { key: 'spec', label: 'Spec', agent: 'requirements-analyst', gate: 'Spec approval' },
  { key: 'arch', label: 'Arch', agent: 'architect', gate: 'ADR sign-off' },
  { key: 'build', label: 'Build', agent: 'implementer', gate: 'Merge approval' },
  { key: 'review', label: 'Review', agent: 'requester', gate: 'Requester feedback' },
  { key: 'deploy', label: 'Deploy', agent: 'deployer', gate: 'Deploy approval' },
];

/** Backend stage → displayed lane index. `done` returns 5 (shipped, not a lane).
 *  Fixes the prior STAGE_INDEX gap that had no `preview` entry — it fell back to
 *  0 (Spec), so a requester-preview request wrongly showed at the start of the
 *  line. `review` (the agent code-review loop) folds into BUILD; `preview` (the
 *  requester preview) is the REVIEW lane. */
const DISPLAY_INDEX: Record<FactoryRequest['stage'], number> = {
  intake: 0,
  spec: 0,
  architecture: 1,
  build: 2,
  review: 2,
  preview: 3,
  deploy: 4,
  done: 5,
};

export function displayStageIndex(stage: FactoryRequest['stage']): number {
  return DISPLAY_INDEX[stage] ?? 0;
}

/** Which of the three Overview bodies is showing; mirrored to the URL query.
 *  Named for what the operator sees, not for the factory metaphor: "line" is
 *  already the whole pipeline elsewhere in the console ("the factory line is
 *  stalled", "24 on the line"), so it cannot also name one view of it. */
export type OverviewView = 'list' | 'board' | 'progress';

export type SegState = 'done' | 'current' | 'todo';
/** How a request reads right now — drives its colour in every view. */
export type RowKind = 'active' | 'gate' | 'wait' | 'stuck' | 'owned' | 'draft' | 'done';
/** How the page routes an inline action; null → nothing for a human to do here. */
export type QueueKind = 'gate' | 'stalled' | 'owned';

export interface OverviewRow {
  id: number;
  ref: string;
  title: string;
  app: string;
  /** displayed lane, 0..4 live, 5 = shipped */
  stageIndex: number;
  kind: RowKind;
  /** a person must act (admin gate, stall, or hand-off) */
  needsHuman: boolean;
  queueKind: QueueKind | null;
  /** right-hand status text, in the admin's words */
  state: string;
  /** live activity line for the Board view — real run/last_event only, never faked */
  activity: string | null;
  /** compact time in current stage, e.g. "4h" — null for shipped rows */
  age: string | null;
  /** one SegState per displayed stage */
  segs: SegState[];
  /** sort keys, not rendered */
  enteredMs: number;
  updatedMs: number;
  /** carried so inline actions can address the request without a second lookup */
  request: FactoryRequest;
}

/** How many shipped requests stay visible under the live rows. */
const SHIPPED_SHOWN = 5;

const KIND_RANK: Record<RowKind, number> = {
  stuck: 0,
  gate: 1,
  owned: 2,
  wait: 3,
  active: 4,
  draft: 5,
  done: 6,
};

function segStates(stageIndex: number): SegState[] {
  return DISPLAY_STAGES.map((_, i) => {
    if (stageIndex >= 5) return 'done';
    if (i < stageIndex) return 'done';
    if (i === stageIndex) return 'current';
    return 'todo';
  });
}

/** The live activity line for a running request — real data only. A healthy run
 *  reports its step; otherwise we fall back to the last recorded event, quietly.
 *  No simulator, no random text. */
function liveActivity(r: FactoryRequest, run: RunState | null): string | null {
  if (run && run.health !== 'no_signal') {
    if (run.label) return run.of ? `${run.label} · ${run.step}/${run.of}` : run.label;
  }
  return r.last_event ?? null;
}

export function deriveRow(r: FactoryRequest, run: RunState | null): OverviewRow {
  const stageIndex = displayStageIndex(r.stage);
  const base = {
    id: r.id,
    ref: r.ref,
    title: r.title,
    app: r.app_name || r.new_app_name || 'New app',
    stageIndex,
    segs: segStates(stageIndex),
    age: r.stage_entered_at ? timeAgo(r.stage_entered_at) : null,
    enteredMs: r.stage_entered_at ? Date.parse(r.stage_entered_at) : 0,
    updatedMs: Date.parse(r.updated_at) || 0,
    request: r,
  };
  const done = (kind: RowKind, extra: Partial<OverviewRow>): OverviewRow => ({
    ...base,
    kind,
    needsHuman: false,
    queueKind: null,
    activity: null,
    state: '',
    ...extra,
  });

  if (r.status === 'done')
    return done('done', { state: `Shipped · ${timeAgo(r.updated_at)}`, age: null });
  if (r.needs_human)
    return done('stuck', {
      needsHuman: true,
      queueKind: 'stalled',
      state: r.needs_human_reason || 'Needs a human',
    });
  if (r.status === 'human_owned')
    return done('owned', {
      needsHuman: true,
      queueKind: 'owned',
      state: 'Human-owned · automation off',
    });
  if (r.gate === 'approve_spec')
    return done('gate', {
      needsHuman: true,
      queueKind: 'gate',
      state: 'Holding for spec approval',
    });
  if (r.gate === 'approve_architecture')
    return done('gate', { needsHuman: true, queueKind: 'gate', state: 'Holding for ADR sign-off' });
  if (r.gate === 'approve_merge')
    return done('gate', {
      needsHuman: true,
      queueKind: 'gate',
      state: 'Holding for merge approval',
    });
  if (r.gate === 'approve_deploy')
    return done('gate', {
      needsHuman: true,
      queueKind: 'gate',
      state: 'Holding for deploy approval',
    });
  // The requester's preview feedback is an amber wait, not an admin gate — no
  // approve/send-back here; the requester acts from their own app.
  if (r.gate === 'accept_preview')
    return done('wait', { state: 'Preview live · awaiting requester feedback' });
  if (r.status === 'sent_back')
    return done('wait', { state: 'With the submitter · question open' });
  if (r.status === 'draft') return done('draft', { state: 'Draft · not submitted yet' });
  if (run) {
    const quiet = run.health !== 'healthy';
    return done('active', {
      state: quiet
        ? 'Quiet · no signal recently'
        : `${run.label || 'Working'} · ${run.step}/${run.of}`,
      activity: liveActivity(r, run),
    });
  }
  if (r.stage === 'deploy')
    return done('active', {
      state: r.last_event || 'Building image · deploying',
      activity: liveActivity(r, null),
    });
  // The intake interview is the submitter's turn (amber wait); drafting the spec
  // is the analyst agent working (green), so the two must not share a colour.
  if (r.stage === 'intake' || r.stage === 'spec')
    return r.status === 'submitted'
      ? done('wait', { state: 'Interview in progress' })
      : done('active', { state: 'Drafting the spec', activity: liveActivity(r, null) });
  return done('active', { state: r.last_event || 'Working', activity: liveActivity(r, null) });
}

export interface OverviewModel {
  /** live rows, closest-to-shipping first */
  rows: OverviewRow[];
  /** recently shipped, newest first (capped) */
  shipped: OverviewRow[];
  /** live requests sitting in each of the five displayed stages */
  counts: number[];
}

/** The whole board from the requests projection + mission run overlays. */
export function deriveOverview(
  requests: FactoryRequest[],
  runs: Map<number, RunState>,
): OverviewModel {
  const open = requests.filter((r) => r.status !== 'cancelled');
  const rows: OverviewRow[] = [];
  const shipped: OverviewRow[] = [];
  const counts = DISPLAY_STAGES.map(() => 0);
  for (const r of open) {
    const row = deriveRow(r, runs.get(r.id) ?? null);
    if (row.kind === 'done') {
      shipped.push(row);
      continue;
    }
    counts[Math.min(row.stageIndex, 4)] += 1;
    rows.push(row);
  }
  // Closest to shipping on top; urgency breaks ties; then longest in stage.
  rows.sort(
    (a, b) =>
      b.stageIndex - a.stageIndex ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.enteredMs - b.enteredMs,
  );
  shipped.sort((a, b) => b.updatedMs - a.updatedMs);
  return { rows, shipped: shipped.slice(0, SHIPPED_SHOWN), counts };
}

/** Live rows bucketed into the five lanes — active chips first, waiting/stuck
 *  chips piled after (they settle at the lane's edge). Shipped rows excluded. */
export function laneRows(rows: OverviewRow[]): OverviewRow[][] {
  const lanes = DISPLAY_STAGES.map(() => [] as OverviewRow[]);
  for (const row of rows) if (row.stageIndex < 5) lanes[Math.min(row.stageIndex, 4)].push(row);
  for (const lane of lanes) {
    lane.sort(
      (a, b) =>
        Number(a.needsHuman) - Number(b.needsHuman) ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        b.enteredMs - a.enteredMs,
    );
  }
  return lanes;
}

/* ── Status language ──
   One vocabulary for all three views, so a request reads the same wherever the
   admin meets it. Neutral is the default; colour is spent only where a human is
   the missing piece (amber gate, red stall, accent hand-off) or where something
   actually shipped (green). An agent merely working stays neutral on purpose —
   otherwise it competes with the gates for the eye. */
const STATE_CLASS: Partial<Record<RowKind, string>> = {
  gate: 'gate',
  stuck: 'stuck',
  owned: 'owned',
  active: 'run',
  done: 'shipped',
};

/** The state-dot class for a row; '' means the neutral hollow default
 *  (`wait` and `draft` — held, but not by us). */
export function stateClass(row: OverviewRow): string {
  return STATE_CLASS[row.kind] ?? '';
}

export type ProgSegClass = 'done' | 'work' | 'gate' | 'wait' | 'stuck' | 'owned' | 'future';

/** The current lane's saturated tone — the row's one loud segment. */
function currentSegClass(kind: RowKind): ProgSegClass {
  if (kind === 'gate') return 'gate';
  if (kind === 'stuck') return 'stuck';
  if (kind === 'wait') return 'wait';
  if (kind === 'owned') return 'owned';
  return 'work';
}

/** Five progress segments for one row: completed are quiet, the current stage is
 *  the only saturated one, future stages are barely there. */
export function progressSegs(row: OverviewRow): ProgSegClass[] {
  return DISPLAY_STAGES.map((_, i) => {
    if (row.stageIndex >= 5 || i < row.stageIndex) return 'done';
    if (i > row.stageIndex) return 'future';
    return currentSegClass(row.kind);
  });
}

/** Progress rows as one flat list — the unit is the request, not the app: a
 *  handful of requests rarely run against the same app at once, so grouping
 *  bought headers and no grouping. Furthest along first, then longest sitting. */
export function progressRows(rows: OverviewRow[]): OverviewRow[] {
  return rows.slice().sort((a, b) => b.stageIndex - a.stageIndex || a.enteredMs - b.enteredMs);
}

export interface ProgressGroup {
  app: string;
  rows: OverviewRow[];
}

/** Progress rows grouped by app, most-advanced first inside each group; groups
 *  ordered by their furthest-along request. */
export function progressGroups(rows: OverviewRow[]): ProgressGroup[] {
  const byApp = new Map<string, OverviewRow[]>();
  for (const row of rows) {
    const list = byApp.get(row.app) ?? [];
    list.push(row);
    byApp.set(row.app, list);
  }
  const groups = [...byApp.entries()].map(([app, list]) => ({
    app,
    rows: list.slice().sort((a, b) => b.stageIndex - a.stageIndex || a.enteredMs - b.enteredMs),
  }));
  groups.sort((a, b) => b.rows[0].stageIndex - a.rows[0].stageIndex || a.app.localeCompare(b.app));
  return groups;
}

/* ── Inline actions ──
   The Overview drops the decision rail, so every action rides on the row it
   belongs to. Which buttons a row offers is a pure function of its kind. The
   action plumbing (api calls + confirm modals) still lives on the page. */

export type RowActionVerb =
  | 'approve'
  | 'sendBack'
  | 'retry'
  | 'sendBackToStage'
  | 'takeOver'
  | 'cancel';

export interface RowAction {
  verb: RowActionVerb;
  request: FactoryRequest;
}

export function rowActions(row: OverviewRow): RowActionVerb[] {
  if (row.queueKind === 'gate') return ['approve', 'sendBack'];
  if (row.queueKind === 'stalled') return ['retry', 'sendBackToStage', 'takeOver', 'cancel'];
  if (row.queueKind === 'owned') return ['cancel'];
  return [];
}

const ACTION_LABEL: Record<RowActionVerb, string> = {
  approve: 'Approve',
  sendBack: 'Send back',
  retry: 'Retry stage',
  sendBackToStage: 'Send back to…',
  takeOver: 'Take over',
  cancel: 'Cancel',
};
export function actionLabel(verb: RowActionVerb): string {
  return ACTION_LABEL[verb];
}

/* ── Compact time helpers (kept from the previous cockpit) ── */

/** Compact hours for the gauge line: <1h · 7h · 3d. */
export function fmtHours(h: number): string {
  if (h < 1) return '<1h';
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

export interface HealthTallies {
  open: number;
  deciding: number;
  attention: number;
  shipped: number;
  cycle: string | null;
  gateWait: string | null;
}

/** The persistent health band's six numbers, computed client-side from the data
 *  the floor already loads — no new endpoint. */
export function deriveTallies(m: MissionOut, requests: FactoryRequest[]): HealthTallies {
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
