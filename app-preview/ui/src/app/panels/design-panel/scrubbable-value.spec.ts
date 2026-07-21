import { adjustScrubbableValue, canScrubValue } from './scrubbable-value';

describe('scrubbable CSS values', () => {
  it('adjusts values while preserving units and precision', () => {
    expect(adjustScrubbableValue('30px', 2, { step: 1, min: 0 })).toBe('32px');
    expect(adjustScrubbableValue('1.2em', 1, { step: 0.1, min: 0 })).toBe('1.3em');
    expect(adjustScrubbableValue('-0.5px', 1, { step: 0.1 })).toBe('-0.4px');
    expect(adjustScrubbableValue('10.4px', 1, { step: 1, min: 0 })).toBe('11.4px');
  });

  it('adjusts grouped CSS values and clamps every token', () => {
    expect(
      adjustScrubbableValue('10px 0px 8px', -2, { step: 1, min: 0 }),
    ).toBe('8px 0px 6px');
    expect(adjustScrubbableValue('98%', 1, { step: 5, max: 100 })).toBe('100%');
  });

  it('only enables scrubbing for values with numeric tokens', () => {
    expect(canScrubValue('normal')).toBe(false);
    expect(canScrubValue('30px')).toBe(true);
  });
});
