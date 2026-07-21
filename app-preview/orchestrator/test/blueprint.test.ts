import { describe, expect, it } from 'vitest';

import { deriveBuildTasks } from '../src/blueprints/derive-tasks.js';
import type { DashboardBlueprint } from '../src/blueprints/types.js';
import { validateBlueprint } from '../src/blueprints/validate.js';

/**
 * Builds a fully valid blueprint, then shallow-merges `overrides` on top.
 * `overrides` is intentionally loosely typed so tests can construct
 * structurally-invalid fixtures (e.g. a metric missing `expected`) to
 * exercise validation rules -- the same way malformed JSON from an
 * untrusted source would arrive at `validateBlueprint` in production.
 */
function blueprint(overrides: Partial<Record<keyof DashboardBlueprint, unknown>> = {}): DashboardBlueprint {
  const base: DashboardBlueprint = {
    version: 1,
    title: 'Sales Dashboard',
    goal: 'Track revenue and order volume for the sales team',
    users: ['sales-manager'],
    pages: [{ id: 'overview', title: 'Overview', path: '/' }],
    entities: [
      {
        name: 'order',
        fields: [
          { name: 'id', type: 'text' },
          { name: 'total', type: 'number' },
          { name: 'placedAt', type: 'date' },
        ],
      },
    ],
    metrics: [
      { id: 'revenue', label: 'Revenue', formula: 'sum(order.total)', format: 'currency', expected: 12_000 },
    ],
    charts: [
      { id: 'revenue-trend', title: 'Revenue Trend', kind: 'line', measure: 'revenue', dimension: 'order.placedAt' },
    ],
    filters: [{ id: 'date-filter', label: 'Date', field: 'order.placedAt', control: 'date-range' }],
    states: ['loading', 'empty', 'error', 'narrow'],
    seed: { id: 'default', scenarios: [{ name: 'typical-month', description: 'A typical month of orders' }] },
    journeys: [
      {
        id: 'view-overview',
        title: 'View overview',
        viewport: { width: 1280, height: 800 },
        actions: [{ kind: 'goto', path: '/' }],
        assertions: [{ kind: 'text', testId: 'revenue-value', value: '$12,000' }],
      },
    ],
  };

  return { ...base, ...overrides } as unknown as DashboardBlueprint;
}

function validBlueprint(): DashboardBlueprint {
  return blueprint();
}

describe('dashboard blueprint', () => {
  it('rejects a KPI without a seeded expected value', () => {
    const result = validateBlueprint(blueprint({
      metrics: [{ id: 'revenue', label: 'Revenue', formula: 'sum(order.total)', format: 'currency' }],
    }));
    expect(result).toEqual({ ok: false, errors: [{ path: 'metrics.0.expected', message: 'Expected seeded value is required' }] });
  });

  it('derives vertical slices in dependency order', () => {
    expect(deriveBuildTasks(validBlueprint()).map((task) => task.kind)).toEqual([
      'data', 'api', 'shell', 'visualization', 'interaction', 'resilience',
    ]);
  });

  it('accepts a fully valid blueprint', () => {
    const result = validateBlueprint(validBlueprint());
    expect(result).toEqual({ ok: true, blueprint: validBlueprint() });
  });

  it('requires at least one page, entity, metric, chart, seed scenario, and journey', () => {
    const result = validateBlueprint(blueprint({
      pages: [],
      entities: [],
      metrics: [],
      charts: [],
      filters: [],
      seed: { id: 'default', scenarios: [] },
      journeys: [],
    }));
    expect(result).toEqual({
      ok: false,
      errors: [
        { path: 'pages', message: 'At least one page is required' },
        { path: 'entities', message: 'At least one entity is required' },
        { path: 'metrics', message: 'At least one metric is required' },
        { path: 'charts', message: 'At least one chart is required' },
        { path: 'seed.scenarios', message: 'At least one seed scenario is required' },
        { path: 'journeys', message: 'At least one journey is required' },
      ],
    });
  });

  it('rejects duplicate ids within a collection', () => {
    const result = validateBlueprint(blueprint({
      pages: [
        { id: 'overview', title: 'Overview', path: '/' },
        { id: 'overview', title: 'Overview Again', path: '/again' },
      ],
    }));
    expect(result).toEqual({
      ok: false,
      errors: [{ path: 'pages.1.id', message: 'Duplicate id "overview" in pages' }],
    });
  });

  it('rejects duplicate entity names', () => {
    const result = validateBlueprint(blueprint({
      entities: [
        { name: 'order', fields: [{ name: 'id', type: 'text' }, { name: 'total', type: 'number' }, { name: 'placedAt', type: 'date' }] },
        { name: 'order', fields: [{ name: 'id', type: 'text' }, { name: 'total', type: 'number' }, { name: 'placedAt', type: 'date' }] },
      ],
    }));
    expect(result).toEqual({
      ok: false,
      errors: [{ path: 'entities.1.name', message: 'Duplicate name "order" in entities' }],
    });
  });

  it('rejects a chart measure that does not reference a metric', () => {
    const result = validateBlueprint(blueprint({
      charts: [{ id: 'revenue-trend', title: 'Revenue Trend', kind: 'line', measure: 'nonexistent', dimension: 'order.placedAt' }],
    }));
    expect(result).toEqual({
      ok: false,
      errors: [{ path: 'charts.0.measure', message: 'Chart measure must reference a metric id' }],
    });
  });

  it('rejects a filter field that does not resolve to an entity field', () => {
    const result = validateBlueprint(blueprint({
      filters: [{ id: 'date-filter', label: 'Date', field: 'order.nonexistent', control: 'date-range' }],
    }));
    expect(result).toEqual({
      ok: false,
      errors: [{ path: 'filters.0.field', message: 'Filter field must resolve to an entity field' }],
    });
  });

  it('rejects a non-finite metric expected value', () => {
    const result = validateBlueprint(blueprint({
      metrics: [{ id: 'revenue', label: 'Revenue', formula: 'sum(order.total)', format: 'currency', expected: Number.POSITIVE_INFINITY }],
    }));
    expect(result).toEqual({
      ok: false,
      errors: [{ path: 'metrics.0.expected', message: 'Expected seeded value is required' }],
    });
  });

  it('omits inapplicable task kinds while preserving dependency order', () => {
    const kinds = deriveBuildTasks(blueprint({
      filters: [],
      states: [],
      journeys: [
        {
          id: 'view-overview',
          title: 'View overview',
          viewport: { width: 1280, height: 800 },
          actions: [{ kind: 'goto', path: '/' }],
          assertions: [{ kind: 'text', testId: 'revenue-value', value: '$12,000' }],
        },
      ],
    })).map((task) => task.kind);

    expect(kinds).toEqual(['data', 'api', 'shell', 'visualization']);
  });

  it('never omits an applicable task and every task carries acceptance criteria', () => {
    const tasks = deriveBuildTasks(validBlueprint());
    for (const task of tasks) {
      expect(task.acceptance.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic for the same blueprint', () => {
    const input = validBlueprint();
    expect(deriveBuildTasks(input)).toEqual(deriveBuildTasks(input));
  });
});
