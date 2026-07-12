import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FactoryRequest, MissionGate, MissionOut } from '@sf/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { FloorGateCard } from './floor-gate-card';
import { FloorContent } from './floor-content';
import { deriveLane } from './floor-view';

const request = (over: Partial<FactoryRequest> = {}): FactoryRequest => ({
  id: 87,
  ref: 'SF-0087',
  title: 'Export payroll summary as CSV',
  description: '',
  type: 'enh',
  urgency: 'soon',
  reach: 'team',
  impact_metric: 'hours',
  impact_value: '4',
  bug_where: null,
  priority: 'normal',
  app_id: 1,
  app_name: 'Payroll',
  app_key: 'payroll',
  repo: 'acme/payroll',
  prospective_repo: null,
  new_app_name: null,
  stage: 'review',
  status: 'pending_approval',
  gate: 'approve_merge',
  needs_human: false,
  needs_human_reason: null,
  reporter: 'Sarah Lim',
  reporter_initials: 'SL',
  labels: [],
  send_back_question: null,
  send_back_response: null,
  send_back_rounds: 0,
  repo_ready: true,
  spec_pr_open: true,
  stage2_fired: true,
  spec_open_note: null,
  created_at: '2026-07-11T01:00:00Z',
  updated_at: '2026-07-11T02:00:00Z',
  stage_entered_at: '2026-07-11T01:30:00Z',
  last_event: 'Verification passed',
  ...over,
});

const gate = (): MissionGate => ({
  request: request(),
  evidence: {
    kind: 'merge',
    grounded_lines: null,
    total_lines: null,
    interview_count: null,
    tests_passed: 42,
    tests_total: 42,
    diff_added: 214,
    diff_removed: 38,
    files_changed: 6,
    reviewer_verdict: 'approved',
    assumptions: [],
  },
});

const mission = (over: Partial<MissionOut> = {}): MissionOut => ({
  gates: [],
  runs: [],
  stalled: [],
  recent: [],
  cursor: 0,
  ...over,
});

describe('Floor gate card', () => {
  let fixture: ComponentFixture<FloorGateCard>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FloorGateCard],
      providers: [provideRouter([])],
    }).compileComponents();
    fixture = TestBed.createComponent(FloorGateCard);
    fixture.componentRef.setInput('gate', gate());
    fixture.detectChanges();
  });

  it('renders evidence facts, consequence, requester, and gate actions', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('+214 −38 · 6 files');
    expect(text).toContain('42 / 42 passed');
    expect(text).toContain('Approving will merge the approved work into main and deploy Payroll.');
    expect(text).toContain('requested by Sarah Lim');
    expect(text).toContain('Approve');
    expect(text).toContain('Send back with a note');
  });

  it('states failing tests as failures, never as a green success', () => {
    const failing = gate();
    failing.evidence = { ...failing.evidence!, tests_passed: 42, tests_total: 45 };
    fixture.componentRef.setInput('gate', failing);
    fixture.detectChanges();
    const fact = fixture.nativeElement.querySelector('.fact .failure');
    expect(fact?.textContent).toContain('3 of 45 failed');
    expect(fixture.nativeElement.querySelector('.fact .success')).toBeNull();
  });
});

describe('Floor lane derivation', () => {
  it('derives a healthy run stage, step, and shape-plus-word health', () => {
    const lane = deriveLane({
      request: request({ stage: 'architecture', gate: null, status: 'approved' }),
      run: {
        step: 2,
        of: 4,
        label: 'drafting the plan',
        health: 'healthy',
        seconds_since_event: 40,
      },
    });
    expect(lane).toMatchObject({ stage: 'Plan', step: 2, of: 4, healthLabel: '● steady' });
  });

  it('states quiet health with a non-colour shape and elapsed time', () => {
    const lane = deriveLane({
      request: request({ stage: 'build', gate: null, status: 'approved' }),
      run: { step: 3, of: 7, label: null, health: 'slow', seconds_since_event: 24 * 60 },
    });
    expect(lane.healthLabel).toBe('▲ quiet for 24 m');
  });

  it('derives a waiting-at-gate lane when mission data carries a gate', () => {
    const lane = deriveLane({
      request: request({ stage: 'review', gate: 'approve_merge' }),
      run: { step: 7, of: 7, label: null, health: 'healthy', seconds_since_event: 12 },
    });
    expect(lane.healthLabel).toBe('◆ waiting on merge approval');
  });
});

describe('Floor all-clear state', () => {
  it('renders the calm all-clear sentence when nothing needs a human', async () => {
    await TestBed.configureTestingModule({
      imports: [FloorContent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(FloorContent);
    fixture.componentRef.setInput(
      'mission',
      mission({
        runs: [
          {
            request: request({ gate: null, stage: 'build', status: 'approved' }),
            run: { step: 1, of: 3, label: null, health: 'healthy', seconds_since_event: 2 },
          },
        ],
      }),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Nothing needs you — 1 request in motion.');
  });
});
