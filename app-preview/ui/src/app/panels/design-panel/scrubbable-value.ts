export interface ScrubOptions {
  step: number;
  min?: number;
  max?: number;
}

const NUMERIC_TOKEN = /-?(?:\d+(?:\.\d*)?|\.\d+)/g;

export function canScrubValue(value: string): boolean {
  return /-?(?:\d+(?:\.\d*)?|\.\d+)/.test(value);
}

export function adjustScrubbableValue(
  value: string,
  stepCount: number,
  options: ScrubOptions,
): string {
  if (!canScrubValue(value) || stepCount === 0) return value;

  return value.replace(NUMERIC_TOKEN, (token) => {
    const precision = Math.min(
      6,
      Math.max(decimalPlaces(token), decimalPlaces(String(options.step))),
    );
    let next = Number(token) + stepCount * options.step;
    if (options.min !== undefined) next = Math.max(options.min, next);
    if (options.max !== undefined) next = Math.min(options.max, next);
    next = Number(next.toFixed(precision));
    if (Object.is(next, -0)) next = 0;
    return precision > 0 ? next.toFixed(precision) : String(next);
  });
}

function decimalPlaces(value: string): number {
  return value.includes('.') ? value.length - value.indexOf('.') - 1 : 0;
}
