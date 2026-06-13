import { Evidence, FactoryRequest, MissionOut, ProgressEvent, RunState } from './models';

/** API timestamps are UTC; SQLite round-trips them naive, so re-tag before parsing. */
export function utc(iso: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
}

export function timeAgo(iso: string): string {
  const s = Math.max(1, (Date.now() - utc(iso).getTime()) / 1000);
  if (s < 90) return 'now';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 10) return `${Math.round(d)}d`;
  return `${Math.round(d / 7)}w`;
}

export function clock(iso: string): string {
  return utc(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export const STAGE_LABEL: Record<string, string> = {
  intake: 'Intake',
  spec: 'Spec',
  architecture: 'Architecture',
  build: 'Build',
  review: 'Review',
  done: 'Done',
};

export const TYPE_LABEL: Record<string, string> = {
  bug: 'Bug fix',
  enh: 'Enhancement',
  new: 'New app',
  other: 'Other',
};
export const TYPE_SHORT: Record<string, string> = {
  bug: 'Bug',
  enh: 'Enh',
  new: 'New',
  other: 'Other',
};

/** Submitter plain-stage vocabulary (CONTEXT.md: Submitters never see Control-center words). */
export function plainStage(r: FactoryRequest): {
  label: string;
  glyph: string;
  tone: string;
  fill?: number;
} {
  if (r.status === 'cancelled') return { label: 'Cancelled', glyph: 'strike', tone: 'neutral' };
  if (r.status === 'sent_back') return { label: 'Needs your input', glyph: 'flag', tone: 'amber' };
  if (r.status === 'done') return { label: 'Deployed', glyph: 'check', tone: 'green' };
  if (r.status === 'submitted' && r.stage === 'intake')
    return { label: 'Submitted', glyph: 'dotted', tone: 'neutral' };
  if (r.status === 'pending_approval')
    return { label: 'Spec drafted', glyph: 'dotted', tone: 'neutral' };
  if (r.stage === 'review') return { label: 'In review', glyph: 'ring', tone: 'purple', fill: 0.6 };
  if (r.status === 'approved')
    return { label: 'Building', glyph: 'ring', tone: 'purple', fill: 0.3 };
  return { label: 'Submitted', glyph: 'dotted', tone: 'neutral' };
}

/** Board-card glyph + edge colour (status by shape, colour layered on top). */
export function boardGlyph(r: FactoryRequest): { glyph: string; color: string; fill: number } {
  if (r.needs_human) return { glyph: 'flag', color: 'var(--red)', fill: 0.5 };
  if (r.status === 'cancelled') return { glyph: 'strike', color: 'var(--faint)', fill: 0 };
  if (r.stage === 'done') return { glyph: 'check', color: 'var(--green)', fill: 1 };
  if (r.stage === 'intake') return { glyph: 'dotted', color: '#9A9AA6', fill: 0 };
  const idx = ['spec', 'architecture', 'build', 'review'].indexOf(r.stage);
  return { glyph: 'ring', color: 'var(--a500)', fill: 0.4 + idx * 0.15 };
}

export function gateLabel(r: FactoryRequest): string | null {
  if (r.gate === 'approve_spec') return 'Approve spec';
  if (r.gate === 'approve_merge') return 'Approve merge';
  return null;
}

/** Stages where agents are actively working — post-approval, not yet done. */
const IN_FLIGHT_STAGES: readonly string[] = ['architecture', 'build', 'review'];

/** Agents working with no gate or escalation in the way. */
export function inFlight(r: FactoryRequest): boolean {
  return !r.gate && !r.needs_human && IN_FLIGHT_STAGES.includes(r.stage);
}

/** The irreversible steps an Approve fires — [label, detail] pairs for the confirm modal.
 *  The repo name is server-owned: `prospective_repo` carries the to-be-created repo. */
export function confirmSteps(r: FactoryRequest): [string, string][] {
  if (r.gate === 'approve_merge') {
    return [
      ['Merge the PR to main', r.repo ?? ''],
      ['Promote main → production', 'protected-branch approval'],
      ['Trigger the deploy', 'Stage 6'],
    ];
  }
  return [
    ['Create the GitHub repo', r.repo ?? r.prospective_repo ?? ''],
    ['Open the SPEC.md pull request', 'from the grounded draft'],
    ['Start the Architecture stage', 'hands off to Stage 2'],
  ];
}

/** Compact elapsed time for run rows: 8s · 1m 40s · 2h 30m. */
export function elapsedShort(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export interface EvidenceBit {
  text: string;
  tone: '' | 'green' | 'purple';
}

/** The evidence strip's bits (spec §6): spec gates show grounding, merge gates show
 *  tests/diff/reviewer. null or a verification-less merge gate → "no evidence recorded". */
export function evidenceBits(ev: Evidence | null): EvidenceBit[] {
  const none: EvidenceBit[] = [{ text: 'no evidence recorded', tone: '' }];
  if (!ev) return none;
  if (ev.kind === 'spec') {
    const bits: EvidenceBit[] = [
      {
        text: `${ev.grounded_lines ?? 0} of ${ev.total_lines ?? 0} lines grounded in answers`,
        tone: 'green',
      },
    ];
    if (ev.interview_count)
      bits.push({ text: `spec drafted from interview (${ev.interview_count} Q)`, tone: '' });
    return bits;
  }
  const bits: EvidenceBit[] = [];
  if (ev.tests_total != null)
    bits.push({ text: `${ev.tests_passed}/${ev.tests_total} tests pass`, tone: 'green' });
  if (ev.diff_added != null)
    bits.push({
      text: `diff +${ev.diff_added} −${ev.diff_removed} · ${ev.files_changed} files`,
      tone: '',
    });
  if (ev.reviewer_verdict) bits.push({ text: `reviewer: ${ev.reviewer_verdict}`, tone: 'purple' });
  return bits.length ? bits : none;
}

/** The run row's one-line state: "label · elapsed · health", honest when silent. */
export function healthLine(run: RunState): string {
  if (run.health === 'no_signal' || !run.label)
    return `no signal for ${elapsedShort(run.seconds_since_event)}`;
  return `${run.label} · ${elapsedShort(run.seconds_since_event)} · ${run.health}`;
}

export interface TraceRow {
  id: number;
  kind: ProgressEvent['kind'];
  title: string;
  /** step_summary only */
  step?: number;
  of?: number;
  label?: string;
  why?: string;
  /** this row is a steer note that a later step acknowledged */
  acked?: boolean;
  /** this step_summary consumed one or more steer notes */
  acksSteer?: boolean;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface TraceGroup {
  stage: string;
  label: string;
  rows: TraceRow[];
}

/** Admin step labels → submitter-safe phrases. Anything NOT in this map is
 *  rendered as the generic fallback, so internal/GitHub vocabulary can never
 *  leak to the submitter face (CONTEXT.md). */
const ACTIVITY_WORDS: Record<string, string> = {
  'reading SPEC.md': 'reading your request',
  'drafting PLAN.md': 'planning the work',
  'writing ADRs': 'planning the work',
  'validating plan against SPEC.md': 'checking the plan',
  'authoring failing tests': 'writing tests',
  'running the RED gate': 'writing tests',
  'implementing the change': 'making the change',
  'running the test suite': 'running the tests',
  refactoring: 'tidying up',
  'running the test-isolation gate': 'running the tests',
  'running the review pass': 'reviewing the work',
  'collecting findings': 'reviewing the work',
  'writing the verification report': 'finishing the review',
};

/** The submitter's "what's happening now" line, derived from the live run.
 *  null when nothing is running. Safe by construction — unknown labels become
 *  "working on it", never the raw label. */
export function plainActivity(run: RunState | null): string | null {
  if (!run) return null;
  const phrase = (run.label && ACTIVITY_WORDS[run.label]) || 'working on it';
  if (run.of > 0 && run.step > 0) return `${phrase} · step ${run.step} of ${run.of}`;
  return phrase;
}

/** A concise, screen-reader-friendly status line for the submitter's live region.
 *  Pairs the plain stage label with the live activity while a build is in flight,
 *  so SR users hear progress as polling updates the page. Submitter-safe by
 *  construction — built only from plainStage + plainActivity, which never leak
 *  Control-center vocabulary (CONTEXT.md). */
export function liveStatus(r: FactoryRequest, run: RunState | null): string {
  const base = plainStage(r).label;
  const activity = inFlight(r) ? plainActivity(run) : null;
  return activity ? `${base} — ${activity}` : base;
}

/** Concise, screen-reader-friendly summary of Mission control for an aria-live
 *  region: attention items first (gates, stalled), then the ambient running
 *  count. Re-announced only when a count changes, so it stays low-noise. */
export function missionSummary(m: MissionOut): string {
  const parts: string[] = [];
  const g = m.gates.length;
  const s = m.stalled.length;
  const r = m.runs.length;
  if (g) parts.push(`${g} gate${g === 1 ? '' : 's'} waiting on you`);
  if (s) parts.push(`${s} stalled`);
  if (r) parts.push(`${r} running`);
  return parts.length ? parts.join(' · ') : 'All clear — nothing needs you';
}

/** Flatten the per-request trace into stage-grouped rows for the timeline (ADR 0014).
 *  Steer-note consumption is derived: a step_summary's payload.acked_steer_ids marks both
 *  the consuming step and the consumed notes. */
export function groupTrace(events: ProgressEvent[]): TraceGroup[] {
  const acked = new Set<number>();
  for (const e of events)
    for (const id of (e.payload?.['acked_steer_ids'] as number[] | undefined) ?? []) acked.add(id);

  const groups: TraceGroup[] = [];
  for (const e of events) {
    const p = e.payload ?? {};
    const row: TraceRow = {
      id: e.id,
      kind: e.kind,
      title: e.title,
      payload: e.payload,
      created_at: e.created_at,
      step: p['step'] as number | undefined,
      of: p['of'] as number | undefined,
      label: p['label'] as string | undefined,
      why: p['why'] as string | undefined,
      acked: e.kind === 'steer_note' && acked.has(e.id),
      acksSteer:
        e.kind === 'step_summary' &&
        Array.isArray(p['acked_steer_ids']) &&
        (p['acked_steer_ids'] as unknown[]).length > 0,
    };
    const last = groups[groups.length - 1];
    if (last && last.stage === e.stage) last.rows.push(row);
    else groups.push({ stage: e.stage, label: STAGE_LABEL[e.stage] ?? e.stage, rows: [row] });
  }
  return groups;
}
