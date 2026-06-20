import { InjectionToken } from '@angular/core';

/**
 * Base origin of the standalone Intake app (ADR 0017). The console no longer
 * owns the submit/* routes — its "New request" action deep-links out to the
 * Intake app instead. This token is the single, per-environment config point:
 * the local-dev default matches `make dev`'s intake port (:4201) and is
 * overridden without a code change (a different provider per environment, or
 * an `INTAKE_URL` provider in a unit test).
 */
export const INTAKE_URL = new InjectionToken<string>('INTAKE_URL', {
  providedIn: 'root',
  factory: () => 'http://localhost:4201',
});

/**
 * Pure config→URL mapper: given the Intake app's base origin, resolve the
 * absolute URL of its "new request" route. A trailing slash on the base is
 * tolerated so a misconfigured origin never yields `//submit/new`. Kept pure
 * (no Angular deps) so the deep-link contract is unit-testable in isolation.
 */
export function intakeNewRequestUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/submit/new`;
}
