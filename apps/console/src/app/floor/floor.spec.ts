import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Api, FactoryRequest, MissionGate, MissionOut, Poll, Theme } from '@sf/shared';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Session } from '../core/session.service';
import { FloorGateCard } from './floor-gate-card';
import { FloorContent } from './floor-content';
import { FloorPage } from './floor-page';
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
  human_owned: [],
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

describe('Floor recently outcomes', () => {
  it('renders the server-signed operator and decision time', async () => {
    await TestBed.configureTestingModule({
      imports: [FloorContent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(FloorContent);
    fixture.componentRef.setInput(
      'mission',
      mission({
        recent: [
          {
            request: request({ status: 'cancelled' }),
            outcome: 'approved',
            decided_by: 'Avery Stone',
            decided_at: '2026-07-11T02:00:00Z',
          },
        ],
      }),
    );
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('.recent li');
    expect(row.textContent).toContain('Approved');
    expect(row.textContent).toContain('by Avery Stone');
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe('2026-07-11T02:00:00Z');
  });

  it('labels a merge outcome as a shipped success and counts it', async () => {
    await TestBed.configureTestingModule({
      imports: [FloorContent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(FloorContent);
    fixture.componentRef.setInput(
      'mission',
      mission({
        recent: [
          {
            request: request({ status: 'done' }),
            outcome: 'approved_merge',
            decided_by: 'Avery Stone',
            decided_at: '2026-07-11T02:00:00Z',
          },
        ],
      }),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.recent .outcome.shipped')?.textContent).toContain(
      'Shipped',
    );
    expect(fixture.nativeElement.textContent).toContain('1 shipped this week');
  });
});

describe('Floor conflict outcomes', () => {
  it('renders a mocked 409 with the winner and local time on the request card', async () => {
    const actedAt = '2026-07-11T06:02:00Z';
    const api = {
      mission: vi.fn(() => of(mission({ gates: [gate()] }))),
      approve: vi.fn(() =>
        throwError(
          () =>
            new HttpErrorResponse({
              status: 409,
              error: {
                detail: 'Already acted on by Kim Park',
                acted_by: 'Kim Park',
                acted_at: actedAt,
                resulting_state: 'done',
              },
            }),
        ),
      ),
    };
    const poll = { version: signal(0), nudge: vi.fn(), start: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [FloorPage],
      providers: [
        provideRouter([]),
        { provide: Api, useValue: api },
        { provide: Poll, useValue: poll },
        {
          provide: Session,
          useValue: { operatorId: () => 7, operator: () => null },
        },
        {
          provide: Theme,
          useValue: { resolved: () => 'light', set: vi.fn() },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(FloorPage);
    fixture.detectChanges();

    fixture.componentInstance.approve(request());
    fixture.detectChanges();

    const localTime = new Date(actedAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    const outcome = fixture.nativeElement.querySelector('.action-outcome');
    expect(outcome?.textContent).toContain(`Already approved by Kim Park at ${localTime}`);
    expect(poll.nudge).toHaveBeenCalledOnce();
  });
});

describe('Floor scoped recovery', () => {
  it('renders all four recovery verbs on a stalled triage card', async () => {
    await TestBed.configureTestingModule({
      imports: [FloorContent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(FloorContent);
    fixture.componentRef.setInput(
      'mission',
      mission({
        stalled: [
          request({
            stage: 'review',
            status: 'approved',
            gate: null,
            needs_human: true,
            needs_human_reason: 'Review timed out',
          }),
        ],
      }),
    );
    fixture.detectChanges();

    const actions = fixture.nativeElement.querySelector('.triage .actions').textContent;
    expect(actions).toContain('Retry this stage');
    expect(actions).toContain('Send back to…');
    expect(actions).toContain('Take over');
    expect(actions).toContain('Cancel');
    expect(actions).not.toContain('Open dossier');
  });

  it('keeps a human-owned request in Needs you with owner and Cancel visible', async () => {
    await TestBed.configureTestingModule({
      imports: [FloorContent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(FloorContent);
    fixture.componentRef.setInput(
      'mission',
      mission({
        human_owned: [
          {
            request: request({ status: 'human_owned', gate: null }),
            taken_over_by: 'Avery Stone',
            taken_over_at: '2026-07-11T02:00:00Z',
          },
        ],
      }),
    );
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('.human-owned');
    expect(card.textContent).toContain('Human-owned');
    expect(card.textContent).toContain('Avery Stone is finishing this request by hand in the PR.');
    expect(card.textContent).toContain('Cancel');
  });

  it('offers only earlier pipeline stages in the send-back picker and states the blast radius', async () => {
    const stalled = request({
      stage: 'review',
      status: 'approved',
      gate: null,
      needs_human: true,
    });
    const api = { mission: vi.fn(() => of(mission({ stalled: [stalled] }))) };
    const poll = { version: signal(0), nudge: vi.fn(), start: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [FloorPage],
      providers: [
        provideRouter([]),
        { provide: Api, useValue: api },
        { provide: Poll, useValue: poll },
        { provide: Session, useValue: { operatorId: () => 7, operator: () => null } },
        { provide: Theme, useValue: { resolved: () => 'light', set: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(FloorPage);
    fixture.detectChanges();

    const buttons = [
      ...fixture.nativeElement.querySelectorAll('.triage .actions button'),
    ] as HTMLButtonElement[];
    buttons.find((button) => button.textContent?.includes('Send back'))?.click();
    fixture.detectChanges();

    const modal = fixture.nativeElement.querySelector('sf-send-back-stage-modal');
    const choices = [...modal.querySelectorAll('.stage-choice')] as HTMLElement[];
    expect(choices.map((choice) => choice.textContent?.trim())).toEqual(['Architecture', 'Build']);
    expect(modal.textContent).not.toContain('Review stage');
    choices[1].click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Discards the work after Build and redoes that stage.',
    );
  });

  it('renders a mocked take-over 409 on the triage card', async () => {
    const actedAt = '2026-07-11T06:02:00Z';
    const stalled = request({ status: 'approved', gate: null, needs_human: true });
    const api = {
      mission: vi.fn(() => of(mission({ stalled: [stalled] }))),
      takeOver: vi.fn(() =>
        throwError(
          () =>
            new HttpErrorResponse({
              status: 409,
              error: {
                detail: 'Already acted on by Kim Park',
                acted_by: 'Kim Park',
                acted_at: actedAt,
                resulting_state: 'human_owned',
              },
            }),
        ),
      ),
    };
    const poll = { version: signal(0), nudge: vi.fn(), start: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [FloorPage],
      providers: [
        provideRouter([]),
        { provide: Api, useValue: api },
        { provide: Poll, useValue: poll },
        { provide: Session, useValue: { operatorId: () => 7, operator: () => null } },
        { provide: Theme, useValue: { resolved: () => 'light', set: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(FloorPage);
    fixture.detectChanges();

    fixture.componentInstance.takeOver(stalled);
    fixture.detectChanges();

    const localTime = new Date(actedAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(fixture.nativeElement.querySelector('.action-outcome')?.textContent).toContain(
      `Already taken over by Kim Park at ${localTime}`,
    );
  });
});
