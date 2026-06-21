import { beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { INTAKE_URL, intakeNewRequestUrl } from '../core/intake-url';

/**
 * Deep-link contract (ADR 0017 / DRE-14): the console's "New request" action is
 * a config-driven deep-link to the standalone Intake app, not an in-app route.
 * The single source of truth is `${INTAKE_URL}/submit/new`, where INTAKE_URL is
 * an injectable, per-environment token. These specs pin the pure config→URL
 * mapper and prove an overridden token flows through to the same target — the
 * exact computation the shell's `newRequestUrl()` performs.
 */
describe('console New request deep-link', () => {
  it('maps a configured Intake origin to its new-request route', () => {
    expect(intakeNewRequestUrl('https://intake.example')).toBe('https://intake.example/submit/new');
  });

  it('tolerates a trailing slash on the configured origin', () => {
    expect(intakeNewRequestUrl('https://intake.example/')).toBe(
      'https://intake.example/submit/new',
    );
  });

  describe('through the injectable INTAKE_URL token', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('defaults to the local-dev Intake origin', () => {
      TestBed.configureTestingModule({});
      expect(intakeNewRequestUrl(TestBed.inject(INTAKE_URL))).toBe(
        'http://localhost:4201/submit/new',
      );
    });

    it('resolves the deep-link target from an overridden token', () => {
      TestBed.configureTestingModule({
        providers: [{ provide: INTAKE_URL, useValue: 'https://intake.example' }],
      });
      expect(intakeNewRequestUrl(TestBed.inject(INTAKE_URL))).toBe(
        'https://intake.example/submit/new',
      );
    });
  });
});
