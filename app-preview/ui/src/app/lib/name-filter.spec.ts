import { describe, expect, it } from 'vitest';

import { filterByName } from './name-filter';

describe('filterByName', () => {
  const projects = [{ name: 'Local workspace' }, { name: 'Client Portal' }];

  it('returns the original collection for a blank query', () => {
    expect(filterByName(projects, '  ')).toBe(projects);
  });

  it('matches project names case-insensitively', () => {
    expect(filterByName(projects, 'client')).toEqual([{ name: 'Client Portal' }]);
  });
});
