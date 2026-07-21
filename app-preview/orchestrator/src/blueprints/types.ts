export interface DashboardBlueprint {
  version: 1;
  title: string;
  goal: string;
  users: string[];
  pages: Array<{ id: string; title: string; path: string }>;
  entities: Array<{ name: string; fields: Array<{ name: string; type: 'text' | 'number' | 'date' | 'boolean' }> }>;
  metrics: Array<{ id: string; label: string; formula: string; format: 'number' | 'currency' | 'percent'; expected: number }>;
  charts: Array<{ id: string; title: string; kind: 'line' | 'bar' | 'area' | 'donut' | 'table'; measure: string; dimension: string }>;
  filters: Array<{ id: string; label: string; field: string; control: 'select' | 'date-range' | 'search' }>;
  states: Array<'loading' | 'empty' | 'error' | 'narrow'>;
  seed: { id: string; scenarios: Array<{ name: string; description: string }> };
  journeys: Array<{
    id: string;
    title: string;
    viewport: { width: number; height: number };
    actions: Array<
      | { kind: 'goto'; path: string }
      | { kind: 'click'; testId: string }
      | { kind: 'fill'; testId: string; value: string }
      | { kind: 'select'; testId: string; value: string }
    >;
    assertions: Array<
      | { kind: 'text'; testId: string; value: string }
      | { kind: 'number'; testId: string; value: number; tolerance?: number }
      | { kind: 'count'; testId: string; value: number }
    >;
  }>;
}

export interface BuildTask {
  id: string;
  kind: 'data' | 'api' | 'shell' | 'visualization' | 'interaction' | 'resilience';
  title: string;
  acceptance: string[];
}
