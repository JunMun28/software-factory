import { FactoryRequest } from './models';

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

/** Stages that only exist after the spec gate cleared (factory owns the work). */
export const POST_APPROVAL_STAGES: readonly string[] = ['architecture', 'build', 'review', 'done'];

/** Stages where agents are actively working — post-approval, not yet done. */
export const IN_FLIGHT_STAGES: readonly string[] = ['architecture', 'build', 'review'];

/** True once the request is past the spec gate (approved or already in a later stage). */
export function postApproval(r: FactoryRequest): boolean {
  return ['approved', 'done'].includes(r.status) || POST_APPROVAL_STAGES.includes(r.stage);
}

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
