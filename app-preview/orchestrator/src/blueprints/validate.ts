import type { DashboardBlueprint } from './types.js';

export interface ValidationError {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; blueprint: DashboardBlueprint }
  | { ok: false; errors: ValidationError[] };

/**
 * Business-rule validation for an already-shaped `DashboardBlueprint`.
 *
 * This does not do structural/JSON-schema validation (that is the concern
 * of whatever later task parses untrusted input into this shape). It does
 * assume the caller may hand it a blueprint that violates its own field
 * types at particular leaves (e.g. a metric missing `expected`) -- that is
 * exactly the class of error this function exists to catch, so it reads
 * fields defensively rather than trusting the static type.
 */
export function validateBlueprint(blueprint: DashboardBlueprint): ValidationResult {
  const errors: ValidationError[] = [];

  requireNonEmpty(blueprint.pages, 'pages', 'At least one page is required', errors);
  requireNonEmpty(blueprint.entities, 'entities', 'At least one entity is required', errors);
  requireNonEmpty(blueprint.metrics, 'metrics', 'At least one metric is required', errors);
  requireNonEmpty(blueprint.charts, 'charts', 'At least one chart is required', errors);
  requireNonEmpty(blueprint.seed?.scenarios, 'seed.scenarios', 'At least one seed scenario is required', errors);
  requireNonEmpty(blueprint.journeys, 'journeys', 'At least one journey is required', errors);

  requireUniqueIds(blueprint.pages, (page) => page.id, 'pages', errors);
  requireUniqueIds(blueprint.entities, (entity) => entity.name, 'entities', errors, 'name');
  requireUniqueIds(blueprint.metrics, (metric) => metric.id, 'metrics', errors);
  requireUniqueIds(blueprint.charts, (chart) => chart.id, 'charts', errors);
  requireUniqueIds(blueprint.filters, (filter) => filter.id, 'filters', errors);
  requireUniqueIds(blueprint.journeys, (journey) => journey.id, 'journeys', errors);

  (blueprint.entities ?? []).forEach((entity, entityIndex) => {
    requireUniqueIds(
      entity.fields,
      (field) => field.name,
      `entities.${entityIndex}.fields`,
      errors,
      'name',
    );
  });

  const metricIds = new Set((blueprint.metrics ?? []).map((metric) => metric.id));
  (blueprint.charts ?? []).forEach((chart, index) => {
    if (!metricIds.has(chart.measure)) {
      errors.push({ path: `charts.${index}.measure`, message: 'Chart measure must reference a metric id' });
    }
  });

  const entityFields = new Set<string>();
  for (const entity of blueprint.entities ?? []) {
    for (const field of entity.fields ?? []) {
      entityFields.add(`${entity.name}.${field.name}`);
    }
  }
  (blueprint.filters ?? []).forEach((filter, index) => {
    if (!entityFields.has(filter.field)) {
      errors.push({ path: `filters.${index}.field`, message: 'Filter field must resolve to an entity field' });
    }
  });

  (blueprint.metrics ?? []).forEach((metric, index) => {
    if (typeof metric.expected !== 'number' || !Number.isFinite(metric.expected)) {
      errors.push({ path: `metrics.${index}.expected`, message: 'Expected seeded value is required' });
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, blueprint };
}

function requireNonEmpty<T>(
  items: T[] | undefined,
  path: string,
  message: string,
  errors: ValidationError[],
): void {
  if (!items || items.length === 0) {
    errors.push({ path, message });
  }
}

function requireUniqueIds<T>(
  items: T[] | undefined,
  getId: (item: T) => string,
  collectionPath: string,
  errors: ValidationError[],
  idField = 'id',
): void {
  const seen = new Set<string>();
  (items ?? []).forEach((item, index) => {
    const id = getId(item);
    if (seen.has(id)) {
      errors.push({
        path: `${collectionPath}.${index}.${idField}`,
        message: `Duplicate ${idField} "${id}" in ${collectionPath}`,
      });
    } else {
      seen.add(id);
    }
  });
}
