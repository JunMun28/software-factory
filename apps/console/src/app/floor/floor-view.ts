import { MissionRun } from '@sf/shared';

export const FLOOR_STAGES = ['Spec', 'Plan', 'Build', 'Review', 'Merge', 'Ship'] as const;

export interface FloorLane {
  id: number;
  title: string;
  app: string;
  stage: (typeof FLOOR_STAGES)[number];
  step: number;
  of: number;
  label: string;
  healthLabel: string;
  quiet: boolean;
  progress: number;
}

const stageIndex = (item: MissionRun): number => {
  if (item.request.status === 'done') return 5;
  if (item.request.gate === 'approve_merge') return 4;
  return { intake: 0, spec: 0, architecture: 1, build: 2, review: 3, done: 5 }[item.request.stage];
};

export function elapsed(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} m`;
  return `${Math.round(seconds / 3600)} h`;
}

export function deriveLane(item: MissionRun): FloorLane {
  const index = stageIndex(item);
  const waiting = item.request.gate !== null;
  const quiet = item.run.health !== 'healthy';
  const healthLabel = waiting
    ? `◆ waiting on ${item.request.gate === 'approve_merge' ? 'merge' : 'spec'} approval`
    : quiet
      ? `▲ quiet for ${elapsed(item.run.seconds_since_event)}`
      : '● steady';
  const withinStage = item.run.of ? Math.min(1, item.run.step / item.run.of) : 0;

  return {
    id: item.request.id,
    title: item.request.title,
    app: item.request.app_name || item.request.new_app_name || 'New app',
    stage: FLOOR_STAGES[index],
    step: item.run.step,
    of: item.run.of,
    label: item.run.label || item.request.last_event || 'Working through this stage',
    healthLabel,
    quiet,
    progress: Math.min(100, Math.round(((index + withinStage) / (FLOOR_STAGES.length - 1)) * 100)),
  };
}
