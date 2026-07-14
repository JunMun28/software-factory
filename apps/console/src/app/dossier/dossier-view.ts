import { ProgressEvent, groupTrace } from '@sf/shared';

export type DossierChapterKind =
  | 'stage'
  | 'gate'
  | 'decision'
  | 'escalation'
  | 'recovery'
  | 'steer'
  | 'comment';
type ConsequentialChapterKind = Exclude<DossierChapterKind, 'stage'>;

export interface DossierChapter {
  id: string;
  kind: DossierChapterKind;
  label: string;
  title: string;
  glyph: '●' | '◆' | '▲' | '✓' | '↳' | '“';
  statusWord: string;
  events: ProgressEvent[];
  decidedBy: string | null;
  decidedAt: string | null;
  steerState: { state: 'queued' | 'heard'; atStep: number | null } | null;
}

const CONSEQUENTIAL_KIND: Partial<Record<ProgressEvent['kind'], ConsequentialChapterKind>> = {
  escalation: 'escalation',
  recovery_action: 'recovery',
  steer_note: 'steer',
  comment: 'comment',
};

const CHAPTER_META: Record<
  ConsequentialChapterKind,
  { label: string; glyph: DossierChapter['glyph']; statusWord: string }
> = {
  gate: { label: 'Gate', glyph: '◆', statusWord: 'Waiting for approval' },
  decision: { label: 'Human decision', glyph: '✓', statusWord: 'Gate decision' },
  escalation: { label: 'Escalation', glyph: '▲', statusWord: 'Needs human' },
  recovery: { label: 'Recovery action', glyph: '✓', statusWord: 'Action taken' },
  steer: { label: 'Steering note', glyph: '↳', statusWord: 'Operator note' },
  comment: { label: 'Comment', glyph: '“', statusWord: 'Discussion' },
};

/**
 * Turn the shared stage-grouped trace into the Dossier's narrative chapters.
 * Raw events stay attached verbatim so the evidence drawer never relies on a
 * second, lossy projection.
 */
export function buildDossierChapters(events: ProgressEvent[]): DossierChapter[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const ordered = groupTrace(events).flatMap((group) =>
    group.rows.map((row) => byId.get(row.id)).filter((event): event is ProgressEvent => !!event),
  );
  const chapters: DossierChapter[] = [];

  for (const event of ordered) {
    const kind =
      event.kind === 'gate_event'
        ? event.bot
          ? 'gate'
          : 'decision'
        : CONSEQUENTIAL_KIND[event.kind];
    if (kind) {
      const meta = CHAPTER_META[kind];
      chapters.push({
        id: `chapter-${event.id}`,
        kind,
        label: meta.label,
        title: event.title,
        glyph: meta.glyph,
        statusWord: meta.statusWord,
        events: [event],
        decidedBy: kind === 'gate' ? null : event.actor,
        decidedAt: kind === 'gate' ? null : event.created_at,
        steerState: kind === 'steer' ? steerState(event.id, events) : null,
      });
      continue;
    }

    const last = chapters[chapters.length - 1];
    if (last?.kind === 'stage' && last.events[0].stage === event.stage) {
      last.events.push(event);
      last.title = event.title || last.title;
      if (event.kind === 'verification') {
        last.glyph = '✓';
        last.statusWord = 'Verified';
      }
      continue;
    }
    const stageLabel = groupTrace([event])[0]?.label ?? event.stage;
    chapters.push({
      id: `chapter-${event.id}`,
      kind: 'stage',
      label: `${stageLabel} stage`,
      title: event.title,
      glyph: '●',
      statusWord: event.kind === 'verification' ? 'Verified' : 'In progress',
      events: [event],
      decidedBy: null,
      decidedAt: null,
      steerState: null,
    });
  }

  return chapters;
}

function steerState(
  steerId: number,
  events: ProgressEvent[],
): { state: 'queued' | 'heard'; atStep: number | null } {
  const acknowledgement = events.find(
    (event) =>
      event.kind === 'step_summary' &&
      Array.isArray(event.payload?.['acked_steer_ids']) &&
      (event.payload?.['acked_steer_ids'] as unknown[]).includes(steerId),
  );
  const step = acknowledgement?.payload?.['step'];
  return acknowledgement
    ? { state: 'heard', atStep: typeof step === 'number' ? step : null }
    : { state: 'queued', atStep: null };
}
