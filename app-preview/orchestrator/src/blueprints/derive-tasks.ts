import type { BuildTask, DashboardBlueprint } from './types.js';

type Journey = DashboardBlueprint['journeys'][number];
type JourneyAction = Journey['actions'][number];

/**
 * Derives the vertical-slice build tasks for a dashboard blueprint.
 *
 * Pure function of the blueprint: same input always yields the same
 * output, in the fixed dependency order data -> api -> shell ->
 * visualization -> interaction -> resilience. A task kind is only
 * included when the blueprint actually calls for it (e.g. `resilience`
 * is omitted when the blueprint declares no states to handle), but among
 * the included kinds the dependency order is always preserved.
 */
export function deriveBuildTasks(blueprint: DashboardBlueprint): BuildTask[] {
  const tasks: BuildTask[] = [];

  if ((blueprint.entities ?? []).length > 0) {
    tasks.push(deriveDataTask(blueprint));
  }
  if ((blueprint.metrics ?? []).length > 0 || (blueprint.charts ?? []).length > 0) {
    tasks.push(deriveApiTask(blueprint));
  }
  if ((blueprint.pages ?? []).length > 0) {
    tasks.push(deriveShellTask(blueprint));
  }
  if ((blueprint.charts ?? []).length > 0) {
    tasks.push(deriveVisualizationTask(blueprint));
  }
  if (hasInteraction(blueprint)) {
    tasks.push(deriveInteractionTask(blueprint));
  }
  if ((blueprint.states ?? []).length > 0) {
    tasks.push(deriveResilienceTask(blueprint));
  }

  return tasks;
}

function hasInteraction(blueprint: DashboardBlueprint): boolean {
  if ((blueprint.filters ?? []).length > 0) {
    return true;
  }
  return (blueprint.journeys ?? []).some((journey) =>
    journey.actions.some((action) => action.kind !== 'goto'),
  );
}

function deriveDataTask(blueprint: DashboardBlueprint): BuildTask {
  const acceptance = (blueprint.entities ?? []).map(
    (entity) =>
      `Model entity \`${entity.name}\` with fields: ${entity.fields.map((field) => `${field.name} (${field.type})`).join(', ')}`,
  );

  const scenarios = blueprint.seed?.scenarios ?? [];
  if (scenarios.length > 0) {
    acceptance.push(`Seed data for scenario(s): ${scenarios.map((scenario) => scenario.name).join(', ')}`);
  }

  return { id: 'data', kind: 'data', title: 'Data layer: entities and seed data', acceptance };
}

function deriveApiTask(blueprint: DashboardBlueprint): BuildTask {
  const acceptance = [
    ...(blueprint.metrics ?? []).map(
      (metric) =>
        `Compute metric \`${metric.id}\` (${metric.label}) via \`${metric.formula}\`, matching seeded expected value ${metric.expected}`,
    ),
    ...(blueprint.charts ?? []).map(
      (chart) => `Expose chart data for \`${chart.id}\` (measure \`${chart.measure}\` by \`${chart.dimension}\`)`,
    ),
  ];

  return { id: 'api', kind: 'api', title: 'API layer: metrics and chart data', acceptance };
}

function deriveShellTask(blueprint: DashboardBlueprint): BuildTask {
  const acceptance = (blueprint.pages ?? []).map(
    (page) => `Render page \`${page.title}\` at route \`${page.path}\``,
  );

  return { id: 'shell', kind: 'shell', title: 'Page shell and navigation', acceptance };
}

function deriveVisualizationTask(blueprint: DashboardBlueprint): BuildTask {
  const acceptance = (blueprint.charts ?? []).map(
    (chart) => `Render \`${chart.kind}\` chart \`${chart.title}\` plotting \`${chart.measure}\` by \`${chart.dimension}\``,
  );

  return { id: 'visualization', kind: 'visualization', title: 'Chart visualizations', acceptance };
}

function deriveInteractionTask(blueprint: DashboardBlueprint): BuildTask {
  const acceptance = [
    ...(blueprint.filters ?? []).map(
      (filter) => `Wire filter \`${filter.label}\` (\`${filter.control}\`) to field \`${filter.field}\``,
    ),
    ...(blueprint.journeys ?? []).flatMap((journey) =>
      journey.actions
        .filter((action) => action.kind !== 'goto')
        .map((action) => describeInteractionAction(journey, action)),
    ),
  ];

  return { id: 'interaction', kind: 'interaction', title: 'Interactive controls and journeys', acceptance };
}

function describeInteractionAction(journey: Journey, action: JourneyAction): string {
  switch (action.kind) {
    case 'click':
      return `Journey \`${journey.id}\`: click \`${action.testId}\``;
    case 'fill':
      return `Journey \`${journey.id}\`: fill \`${action.testId}\` with \`${action.value}\``;
    case 'select':
      return `Journey \`${journey.id}\`: select \`${action.value}\` in \`${action.testId}\``;
    case 'goto':
      return `Journey \`${journey.id}\`: goto \`${action.path}\``;
  }
}

function deriveResilienceTask(blueprint: DashboardBlueprint): BuildTask {
  const acceptance = (blueprint.states ?? []).map((state) => `Handle \`${state}\` state across pages`);

  return { id: 'resilience', kind: 'resilience', title: 'Resilience states', acceptance };
}
