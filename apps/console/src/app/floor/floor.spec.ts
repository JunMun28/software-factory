import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Api, FactoryRequest, MissionGate, MissionOut, Poll, RunState, Theme } from '@sf/shared';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { Session } from '../core/session.service';
import { Store } from '../core/store.service';
import { FloorContent } from './floor-content';
import { FloorPage } from './floor-page';
import { BOARD_COLUMNS, deriveBoard, deriveCard, deriveQueue } from './floor-view';

const simulatedHealth = () =>
  of({ status: 'ok', brain: 'scripted', runner: 'sim' as const, cli: 'codex' as const });

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

const gate = (over: Partial<FactoryRequest> = {}): MissionGate => ({
  request: request(over),
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

const run = (over: Partial<RunState> = {}): RunState => ({
  step: 2,
  of: 4,
  label: 'drafting PLAN.md',
  health: 'healthy',
  seconds_since_event: 40,
  ...over,
});

const storeStub = (requests: FactoryRequest[] = []) => ({
  requests: signal(requests),
  apps: signal([]),
  inbox: signal([]),
  refresh: vi.fn(),
});

async function renderContent(m: MissionOut, requests: FactoryRequest[] = []) {
  await TestBed.configureTestingModule({
    imports: [FloorContent],
    providers: [provideRouter([])],
  }).compileComponents();
  const fixture: ComponentFixture<FloorContent> = TestBed.createComponent(FloorContent);
  fixture.componentRef.setInput('mission', m);
  fixture.componentRef.setInput('requests', requests);
  fixture.detectChanges();
  return fixture;
}

describe('Board card derivation', () => {
  it('overlays a live run as step-of and in-stage progress', () => {
    const card = deriveCard(
      request({ stage: 'architecture', status: 'approved', gate: null }),
      run(),
    );
    expect(card).toMatchObject({
      tone: 'run',
      glyph: 'ring',
      state: 'drafting PLAN.md · 2/4',
      progress: 0.5,
    });
  });

  it('speaks the spec gate as the approval that starts the build', () => {
    const card = deriveCard(request({ stage: 'spec', gate: 'approve_spec' }), null);
    expect(card).toMatchObject({ tone: 'gate', state: 'Approval starts the build' });
  });

  it('speaks the merge gate as the approval that deploys', () => {
    const card = deriveCard(request({ stage: 'review', gate: 'approve_merge' }), null);
    expect(card).toMatchObject({ tone: 'gate', state: 'Approval deploys it' });
  });

  it('flags needs-human with the recorded reason', () => {
    const card = deriveCard(
      request({ needs_human: true, needs_human_reason: 'Review timed out', gate: null }),
      null,
    );
    expect(card).toMatchObject({ tone: 'human', glyph: 'flag', state: 'Review timed out' });
  });

  it('shows a shipped card with a check and no stage age', () => {
    const card = deriveCard(request({ status: 'done', stage: 'done', gate: null }), null);
    expect(card.tone).toBe('done');
    expect(card.glyph).toBe('check');
    expect(card.state).toContain('Shipped');
    expect(card.age).toBeNull();
  });

  it('states an honest quiet line when a run loses signal', () => {
    const card = deriveCard(
      request({ stage: 'build', status: 'approved', gate: null }),
      run({ health: 'no_signal', label: null }),
    );
    expect(card.state).toContain('Quiet');
  });
});

describe('Board derivation', () => {
  const requests = [
    request({ id: 1, ref: 'SF-1', stage: 'intake', status: 'submitted', gate: null }),
    request({
      id: 2,
      ref: 'SF-2',
      stage: 'spec',
      status: 'pending_approval',
      gate: 'approve_spec',
    }),
    request({ id: 3, ref: 'SF-3', stage: 'architecture', status: 'approved', gate: null }),
    request({ id: 4, ref: 'SF-4', stage: 'build', status: 'approved', gate: null }),
    request({ id: 5, ref: 'SF-5', stage: 'review', status: 'approved', gate: 'approve_merge' }),
    request({ id: 6, ref: 'SF-6', stage: 'deploy', status: 'approved', gate: null }),
    request({ id: 7, ref: 'SF-7', stage: 'done', status: 'done', gate: null }),
    request({ id: 8, ref: 'SF-8', stage: 'build', status: 'cancelled', gate: null }),
  ];

  it('buckets every open request into the five fixed columns', () => {
    const board = deriveBoard(requests, new Map());
    expect(board.map((col) => col.key)).toEqual([
      'intake',
      'architecture',
      'build',
      'review',
      'deploy',
    ]);
    expect(board[0].cards.map((card) => card.ref)).toEqual(['SF-1', 'SF-2']);
    expect(board[1].cards.map((card) => card.ref)).toEqual(['SF-3']);
    expect(board[2].cards.map((card) => card.ref)).toEqual(['SF-4']);
    expect(board[3].cards.map((card) => card.ref)).toEqual(['SF-5']);
    expect(board[4].cards.map((card) => card.ref)).toEqual(['SF-6', 'SF-7']);
  });

  it('excludes cancelled requests and keeps shipped out of the live deploy count', () => {
    const board = deriveBoard(requests, new Map());
    expect(board.flatMap((col) => col.cards.map((card) => card.ref))).not.toContain('SF-8');
    expect(board[4].count).toBe(1);
  });

  it('sorts a column oldest-in-stage first', () => {
    const board = deriveBoard(
      [
        request({
          id: 10,
          ref: 'SF-10',
          stage: 'build',
          status: 'approved',
          gate: null,
          stage_entered_at: '2026-07-11T05:00:00Z',
        }),
        request({
          id: 11,
          ref: 'SF-11',
          stage: 'build',
          status: 'approved',
          gate: null,
          stage_entered_at: '2026-07-11T01:00:00Z',
        }),
      ],
      new Map(),
    );
    expect(board[2].cards.map((card) => card.ref)).toEqual(['SF-11', 'SF-10']);
  });

  it('marks exactly the architecture and deploy columns as approval-gated', () => {
    expect(BOARD_COLUMNS.filter((col) => col.gate).map((col) => col.key)).toEqual([
      'architecture',
      'deploy',
    ]);
  });
});

describe('Decision queue derivation', () => {
  it('headlines gates with what the approval unlocks', () => {
    const queue = deriveQueue(
      mission({
        gates: [
          gate({ id: 1, gate: 'approve_spec', stage: 'spec' }),
          gate({ id: 2, gate: 'approve_merge' }),
        ],
      }),
    );
    expect(queue.map((item) => item.headline)).toEqual(['Approve to build', 'Approve to deploy']);
    expect(queue[1].consequence).toContain('deploys Payroll');
    expect(queue[1].facts.map((fact) => fact.text)).toContain('42/42 tests pass');
  });

  it('orders gates before stalled before human-owned', () => {
    const queue = deriveQueue(
      mission({
        gates: [gate({ id: 1 })],
        stalled: [request({ id: 2, needs_human: true })],
        human_owned: [
          {
            request: request({ id: 3, status: 'human_owned', gate: null }),
            taken_over_by: 'Avery Stone',
            taken_over_at: '2026-07-11T02:00:00Z',
          },
        ],
      }),
    );
    expect(queue.map((item) => item.kind)).toEqual(['gate', 'stalled', 'owned']);
    expect(queue[2].owner).toBe('Avery Stone');
  });
});

describe('Overview rendering', () => {
  it('renders the calm all-clear line when nothing waits on a human', async () => {
    const fixture = await renderContent(mission(), [
      request({ stage: 'build', status: 'approved', gate: null }),
    ]);
    expect(fixture.nativeElement.textContent).toContain('Nothing is waiting on you');
    expect(fixture.nativeElement.textContent).toContain('1 on the line');
  });

  it('renders a gate row with evidence facts and both decisions', async () => {
    const fixture = await renderContent(mission({ gates: [gate()] }), [request()]);
    const row = fixture.nativeElement.querySelector('.q-row.is-gate');
    expect(row.textContent).toContain('Approve to deploy');
    expect(row.textContent).toContain('42/42 tests pass');
    expect(row.textContent).toContain('diff +214 −38 · 6 files');
    expect(row.textContent).toContain('Approving merges to main and deploys Payroll.');
    expect(row.textContent).toContain('Approve');
    expect(row.textContent).toContain('Send back');
  });

  it('renders all four recovery verbs on a stalled row', async () => {
    const stalled = request({
      stage: 'review',
      status: 'approved',
      gate: null,
      needs_human: true,
      needs_human_reason: 'Review timed out',
    });
    const fixture = await renderContent(mission({ stalled: [stalled] }), [stalled]);
    const actions = fixture.nativeElement.querySelector('.q-row.is-stalled .q-actions').textContent;
    expect(actions).toContain('Retry stage');
    expect(actions).toContain('Send back to…');
    expect(actions).toContain('Take over');
    expect(actions).toContain('Cancel');
    expect(fixture.nativeElement.textContent).toContain('Review timed out');
  });

  it('keeps a human-owned request visible with owner and Cancel', async () => {
    const owned = request({ status: 'human_owned', gate: null });
    const fixture = await renderContent(
      mission({
        human_owned: [
          { request: owned, taken_over_by: 'Avery Stone', taken_over_at: '2026-07-11T02:00:00Z' },
        ],
      }),
      [owned],
    );
    const row = fixture.nativeElement.querySelector('.q-row.is-owned');
    expect(row.textContent).toContain('Human-owned');
    expect(row.textContent).toContain('Avery Stone is finishing this by hand in the PR.');
    expect(row.textContent).toContain('Cancel');
  });

  it('draws the five columns with approval captions on architecture and deploy', async () => {
    const fixture = await renderContent(mission(), []);
    const heads = [...fixture.nativeElement.querySelectorAll('.col-name h3')].map(
      (el) => (el as HTMLElement).textContent,
    );
    expect(heads).toEqual(['Intake & Spec', 'Architecture', 'Build', 'Review & Preview', 'Deploy']);
    const caps = [...fixture.nativeElement.querySelectorAll('.gatecap')].map((el) =>
      (el as HTMLElement).textContent?.trim(),
    );
    expect(caps[0]).toContain('opens by spec approval');
    expect(caps[1]).toContain('opens by merge approval');
  });

  it('counts shipped merges in the header pulse', async () => {
    const fixture = await renderContent(
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
      [],
    );
    expect(fixture.nativeElement.textContent).toContain('1 shipped this week');
  });
});

describe('Overview conflict outcomes', () => {
  it('renders a mocked 409 with the winner and local time on the queue row', async () => {
    const actedAt = '2026-07-11T06:02:00Z';
    const api = {
      health: simulatedHealth,
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
        { provide: Store, useValue: storeStub([request()]) },
        { provide: Session, useValue: { operatorId: () => 7, operator: () => null } },
        { provide: Theme, useValue: { resolved: () => 'light', set: vi.fn() } },
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
    const outcome = fixture.nativeElement.querySelector('.q-row .action-outcome');
    expect(outcome?.textContent).toContain(`Already approved by Kim Park at ${localTime}`);
    expect(poll.nudge).toHaveBeenCalledOnce();
  });
});

describe('Overview scoped recovery', () => {
  it('offers only earlier pipeline stages in the send-back picker and states the blast radius', async () => {
    const stalled = request({
      stage: 'review',
      status: 'approved',
      gate: null,
      needs_human: true,
    });
    const api = {
      health: simulatedHealth,
      mission: vi.fn(() => of(mission({ stalled: [stalled] }))),
    };
    const poll = { version: signal(0), nudge: vi.fn(), start: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [FloorPage],
      providers: [
        provideRouter([]),
        { provide: Api, useValue: api },
        { provide: Poll, useValue: poll },
        { provide: Store, useValue: storeStub([stalled]) },
        { provide: Session, useValue: { operatorId: () => 7, operator: () => null } },
        { provide: Theme, useValue: { resolved: () => 'light', set: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(FloorPage);
    fixture.detectChanges();

    const buttons = [
      ...fixture.nativeElement.querySelectorAll('.q-row .q-actions button'),
    ] as HTMLButtonElement[];
    buttons.find((button) => button.textContent?.includes('Send back to…'))?.click();
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

  it('renders a mocked take-over 409 on the stalled row', async () => {
    const actedAt = '2026-07-11T06:02:00Z';
    const stalled = request({ status: 'approved', gate: null, needs_human: true });
    const api = {
      health: simulatedHealth,
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
        { provide: Store, useValue: storeStub([stalled]) },
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
