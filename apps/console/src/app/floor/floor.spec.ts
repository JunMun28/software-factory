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
import { STAGES, deriveLine, deriveQueue, deriveTrack } from './floor-view';

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

const stats = (over: Partial<MissionOut['stats']> = {}): MissionOut['stats'] => ({
  cycle_median_h: null,
  gate_wait_median_h: null,
  shipped_7d: 0,
  oldest_gate_h: null,
  ...over,
});

const mission = (over: Partial<MissionOut> = {}): MissionOut => ({
  gates: [],
  runs: [],
  stalled: [],
  human_owned: [],
  recent: [],
  stats: stats(),
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
  fixture.componentRef.setInput('queue', deriveQueue(m));
  fixture.detectChanges();
  return fixture;
}

describe('Track derivation', () => {
  it('overlays a live run as step-of and in-stage progress', () => {
    const track = deriveTrack(
      request({ stage: 'architecture', status: 'approved', gate: null }),
      run(),
    );
    expect(track).toMatchObject({
      tone: 'run',
      glyph: 'ring',
      state: 'drafting PLAN.md · 2/4',
      progress: 0.5,
    });
    expect(track.segs).toEqual(['done', 'current', 'todo', 'todo', 'todo']);
    expect(track.gates).toEqual(['passed', 'todo']);
  });

  it('parks a spec gate at the build-approval joint', () => {
    const track = deriveTrack(request({ stage: 'spec', gate: 'approve_spec' }), null);
    expect(track).toMatchObject({ tone: 'gate', state: 'Holding for build approval' });
    expect(track.segs).toEqual(['done', 'todo', 'todo', 'todo', 'todo']);
    expect(track.gates).toEqual(['waiting', 'todo']);
  });

  it('parks a merge gate at the deploy-approval joint', () => {
    const track = deriveTrack(request({ stage: 'review', gate: 'approve_merge' }), null);
    expect(track).toMatchObject({ tone: 'gate', state: 'Holding for deploy approval' });
    expect(track.segs).toEqual(['done', 'done', 'done', 'done', 'todo']);
    expect(track.gates).toEqual(['passed', 'waiting']);
  });

  it('flags needs-human with the recorded reason', () => {
    const track = deriveTrack(
      request({ needs_human: true, needs_human_reason: 'Review timed out', gate: null }),
      null,
    );
    expect(track).toMatchObject({ tone: 'human', glyph: 'flag', state: 'Review timed out' });
  });

  it('shows a shipped track fully filled with no stage age', () => {
    const track = deriveTrack(request({ status: 'done', stage: 'done', gate: null }), null);
    expect(track.tone).toBe('done');
    expect(track.glyph).toBe('check');
    expect(track.state).toContain('Shipped');
    expect(track.age).toBeNull();
    expect(track.segs).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(track.gates).toEqual(['passed', 'passed']);
  });

  it('states an honest quiet line when a run loses signal', () => {
    const track = deriveTrack(
      request({ stage: 'build', status: 'approved', gate: null }),
      run({ health: 'no_signal', label: null }),
    );
    expect(track.state).toContain('Quiet');
  });
});

describe('Line derivation', () => {
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

  it('orders live rows closest-to-shipping first and keeps shipped separate', () => {
    const line = deriveLine(requests, new Map());
    expect(line.rows.map((row) => row.ref)).toEqual([
      'SF-6',
      'SF-5',
      'SF-4',
      'SF-3',
      'SF-2',
      'SF-1',
    ]);
    expect(line.shipped.map((row) => row.ref)).toEqual(['SF-7']);
  });

  it('excludes cancelled requests entirely', () => {
    const line = deriveLine(requests, new Map());
    expect(line.rows.map((row) => row.ref)).not.toContain('SF-8');
    expect(line.shipped.map((row) => row.ref)).not.toContain('SF-8');
  });

  it('counts live requests per stage and waiting requests per gate', () => {
    const line = deriveLine(requests, new Map());
    expect(line.counts).toEqual([2, 1, 1, 1, 1]);
    expect(line.gateCounts).toEqual([1, 1]);
  });

  it('breaks same-stage ties by longest-in-stage first', () => {
    const line = deriveLine(
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
    expect(line.rows.map((row) => row.ref)).toEqual(['SF-11', 'SF-10']);
  });

  it('marks exactly the architecture and deploy stages as approval-gated', () => {
    expect(STAGES.filter((stage) => stage.gate).map((stage) => stage.key)).toEqual([
      'architecture',
      'deploy',
    ]);
    expect(STAGES.filter((stage) => stage.gate).map((stage) => stage.gate)).toEqual([
      'Build approval',
      'Deploy approval',
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
    expect(queue[1].facts.map((fact) => fact.text)).toContain('42/42 tests pass');
  });

  it('surfaces the deploy gate (Plan B4) with go-live wording', () => {
    const queue = deriveQueue(mission({ gates: [gate({ id: 3, gate: 'approve_deploy' })] }));
    expect(queue[0].headline).toBe('Approve to go live');
  });

  it('orders gates by priority, then longest-waiting first (gap #3)', () => {
    const queue = deriveQueue(
      mission({
        gates: [
          gate({ id: 1, priority: 'Normal', stage_entered_at: '2026-07-11T01:00:00Z' }),
          gate({ id: 2, priority: 'Critical', stage_entered_at: '2026-07-11T03:00:00Z' }),
          gate({ id: 3, priority: 'Normal', stage_entered_at: '2026-07-10T01:00:00Z' }),
        ],
      }),
    );
    expect(queue.map((item) => item.request.id)).toEqual([2, 3, 1]);
  });

  it('carries an aging signal so old gates read loud', () => {
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const queue = deriveQueue(mission({ gates: [gate({ stage_entered_at: old })] }));
    expect(queue[0].aged).toBe(true);
    expect(queue[0].age).toBeTruthy();
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

  it('renders a gate card with evidence facts and both decisions', async () => {
    const fixture = await renderContent(mission({ gates: [gate()] }), [request()]);
    const card = fixture.nativeElement.querySelector('.need.is-gate');
    expect(card.textContent).toContain('Deploy approval');
    expect(card.textContent).toContain('Approve to deploy');
    expect(card.textContent).toContain('42/42 tests pass');
    expect(card.textContent).toContain('diff +214 −38 · 6 files');
    expect(card.textContent).toContain('waiting');
    expect(card.textContent).toContain('Send back');
  });

  it('renders all four recovery verbs on a stalled card', async () => {
    const stalled = request({
      stage: 'review',
      status: 'approved',
      gate: null,
      needs_human: true,
      needs_human_reason: 'Review timed out',
    });
    const fixture = await renderContent(mission({ stalled: [stalled] }), [stalled]);
    const actions = fixture.nativeElement.querySelector('.need.is-stalled .n-actions').textContent;
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
    const card = fixture.nativeElement.querySelector('.need.is-owned');
    expect(card.textContent).toContain('Human-owned');
    expect(card.textContent).toContain('Avery Stone is finishing this by hand in the PR.');
    expect(card.textContent).toContain('Cancel');
  });

  it('draws the five stages with both approval joints named in the header', async () => {
    const fixture = await renderContent(mission(), []);
    const names = [...fixture.nativeElement.querySelectorAll('.lhead .sname')].map((el) =>
      (el as HTMLElement).textContent?.trim(),
    );
    expect(names).toHaveLength(5);
    ['Intake & Spec', 'Architecture', 'Build', 'Review & Preview', 'Deploy'].forEach((label, i) =>
      expect(names[i]).toContain(label),
    );
    const gates = [...fixture.nativeElement.querySelectorAll('.lhead .gname')].map((el) =>
      (el as HTMLElement).textContent?.trim(),
    );
    expect(gates[0]).toContain('Build approval');
    expect(gates[1]).toContain('Deploy approval');
  });

  it('draws one track row per live request with its state', async () => {
    const fixture = await renderContent(mission(), [
      request({ id: 21, ref: 'SF-21', stage: 'build', status: 'approved', gate: null }),
      request({
        id: 22,
        ref: 'SF-22',
        stage: 'spec',
        status: 'pending_approval',
        gate: 'approve_spec',
      }),
    ]);
    const rows = [...fixture.nativeElement.querySelectorAll('a.lrow.live')] as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('SF-21');
    expect(rows[1].textContent).toContain('Holding for build approval');
    expect(rows[1].querySelectorAll('.dia.hot')).toHaveLength(1);
  });

  it('renders the server-computed gauges in the header pulse', async () => {
    const fixture = await renderContent(
      mission({ stats: stats({ shipped_7d: 1, cycle_median_h: 52, gate_wait_median_h: 4.2 }) }),
      [],
    );
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('1 shipped this week');
    expect(text).toContain('median cycle 2d');
    expect(text).toContain('gates answered in ~4h');
  });
});

describe('Overview conflict outcomes', () => {
  it('renders a mocked 409 with the winner and local time on the rail card', async () => {
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
    const outcome = fixture.nativeElement.querySelector('.need .action-outcome');
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
      ...fixture.nativeElement.querySelectorAll('.need .n-actions button'),
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

  it('renders a mocked take-over 409 on the stalled card', async () => {
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
