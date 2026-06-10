import { FactoryRequest } from './models';

export function timeAgo(iso: string): string {
  const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'now';
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 10) return `${Math.round(d)}d`;
  return `${Math.round(d / 7)}w`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export const STAGE_LABEL: Record<string, string> = {
  intake: 'Intake', spec: 'Spec', architecture: 'Architecture',
  build: 'Build', review: 'Review', done: 'Done',
};

export const TYPE_LABEL: Record<string, string> = { bug: 'Bug fix', enh: 'Enhancement', new: 'New app', other: 'Other' };
export const TYPE_SHORT: Record<string, string> = { bug: 'Bug', enh: 'Enh', new: 'New', other: 'Other' };

/** Submitter plain-stage vocabulary (CONTEXT.md: Submitters never see Control-center words). */
export function plainStage(r: FactoryRequest): { label: string; glyph: string; tone: string; fill?: number } {
  if (r.status === 'cancelled') return { label: 'Cancelled', glyph: 'strike', tone: 'neutral' };
  if (r.status === 'sent_back') return { label: 'Needs your input', glyph: 'flag', tone: 'amber' };
  if (r.status === 'done') return { label: 'Deployed', glyph: 'check', tone: 'green' };
  if (r.status === 'submitted' && r.stage === 'intake') return { label: 'Submitted', glyph: 'dotted', tone: 'neutral' };
  if (r.status === 'pending_approval') return { label: 'Spec drafted', glyph: 'dotted', tone: 'neutral' };
  if (r.stage === 'review') return { label: 'In review', glyph: 'ring', tone: 'purple', fill: 0.6 };
  if (r.status === 'approved') return { label: 'Building', glyph: 'ring', tone: 'purple', fill: 0.3 };
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
