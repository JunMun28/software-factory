import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Api, FactoryRequest, MissionGate, MissionOut, RunState, Poll, Theme } from '@sf/shared';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { Session } from '../core/session.service';
import { Store } from '../core/store.service';
import { FloorContent } from './floor-content';
import { FloorPage } from './floor-page';
import { LineView } from './line-view';
import { RowActions } from './row-actions';
import {
  DISPLAY_STAGES,
  deriveOverview,
  deriveRow,
  deriveTallies,
  displayStageIndex,
  laneRows,
  progressGroups,
  progressSegs,
  rowActions,
} from './floor-view';

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
  fixture.detectChanges();
  return fixture;
}

describe('Five-stage display mapping', () => {
  it('folds the agent review loop into BUILD and gives the requester preview its own REVIEW lane', () => {
    expect(displayStageIndex('intake')).toBe(0);
    expect(displayStageIndex('spec')).toBe(0);
    expect(displayStageIndex('architecture')).toBe(1);
    expect(displayStageIndex('build')).toBe(2);
    expect(displayStageIndex('review')).toBe(2);
    expect(displayStageIndex('preview')).toBe(3);
    expect(displayStageIndex('deploy')).toBe(4);
    expect(displayStageIndex('done')).toBe(5);
  });

  it('names the five stages with their owning agents and gates', () => {
    expect(DISPLAY_STAGES.map((s) => s.label)).toEqual([
      'Spec',
      'Arch',
      'Build',
      'Review',
      'Deploy',
    ]);
    expect(DISPLAY_STAGES.map((s) => s.agent)).toEqual([
      'requirements-analyst',
      'architect',
      'implementer',
      'requester',
      'deployer',
    ]);
    expect(DISPLAY_STAGES.map((s) => s.gate)).toEqual([
      'Spec approval',
      'ADR sign-off',
      'Merge approval',
      'Requester feedback',
      'Deploy approval',
    ]);
  });
});

describe('Row derivation', () => {
  it('overlays a live run as step-of and a real activity line', () => {
    const row = deriveRow(request({ stage: 'build', status: 'approved', gate: null }), run());
    expect(row).toMatchObject({ kind: 'active', needsHuman: false, queueKind: null });
    expect(row.state).toBe('drafting PLAN.md · 2/4');
    expect(row.activity).toBe('drafting PLAN.md · 2/4');
    expect(row.segs).toEqual(['done', 'done', 'current', 'todo', 'todo']);
  });

  it('never fakes activity — a quiet run falls back to the last event', () => {
    const row = deriveRow(
      request({ stage: 'build', status: 'approved', gate: null, last_event: 'green 42/68' }),
      run({ health: 'no_signal', label: null }),
    );
    expect(row.state).toContain('Quiet');
    expect(row.activity).toBe('green 42/68');
  });

  it('parks a merge gate in the BUILD lane and offers approve + send back', () => {
    const row = deriveRow(request({ stage: 'review', gate: 'approve_merge' }), null);
    expect(row).toMatchObject({ kind: 'gate', queueKind: 'gate', stageIndex: 2 });
    expect(row.state).toBe('Holding for merge approval');
    expect(rowActions(row)).toEqual(['approve', 'sendBack']);
  });

  it('treats the requester preview as an amber wait, not an admin gate', () => {
    const row = deriveRow(request({ stage: 'preview', gate: 'accept_preview' }), null);
    expect(row).toMatchObject({ kind: 'wait', needsHuman: false, queueKind: null, stageIndex: 3 });
    expect(row.state).toContain('requester');
    expect(rowActions(row)).toEqual([]);
  });

  it('flags needs-human as stuck with the recorded reason and the recovery verbs', () => {
    const row = deriveRow(
      request({ needs_human: true, needs_human_reason: 'Review timed out', gate: null }),
      null,
    );
    expect(row).toMatchObject({ kind: 'stuck', queueKind: 'stalled', state: 'Review timed out' });
    expect(rowActions(row)).toEqual(['retry', 'sendBackToStage', 'takeOver', 'cancel']);
  });

  it('keeps a human-owned request actionable with only Cancel', () => {
    const row = deriveRow(request({ status: 'human_owned', gate: null }), null);
    expect(row).toMatchObject({ kind: 'owned', queueKind: 'owned' });
    expect(rowActions(row)).toEqual(['cancel']);
  });

  it('shows a shipped row fully filled with no stage age', () => {
    const row = deriveRow(request({ status: 'done', stage: 'done', gate: null }), null);
    expect(row.kind).toBe('done');
    expect(row.state).toContain('Shipped');
    expect(row.age).toBeNull();
    expect(row.segs).toEqual(['done', 'done', 'done', 'done', 'done']);
  });
});

describe('Overview model', () => {
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
    request({ id: 6, ref: 'SF-6', stage: 'preview', status: 'approved', gate: 'accept_preview' }),
    request({ id: 7, ref: 'SF-7', stage: 'deploy', status: 'approved', gate: null }),
    request({ id: 8, ref: 'SF-8', stage: 'done', status: 'done', gate: null }),
    request({ id: 9, ref: 'SF-9', stage: 'build', status: 'cancelled', gate: null }),
  ];

  it('orders live rows closest-to-shipping first and keeps shipped separate', () => {
    const model = deriveOverview(requests, new Map());
    expect(model.rows.map((r) => r.ref)).toEqual([
      'SF-7', // deploy (4)
      'SF-6', // preview (3)
      'SF-5', // review gate — build lane (2), gate outranks active
      'SF-4', // build (2)
      'SF-3', // architecture (1)
      'SF-2', // spec (0)
      'SF-1', // intake (0)
    ]);
    expect(model.shipped.map((r) => r.ref)).toEqual(['SF-8']);
  });

  it('excludes cancelled requests entirely', () => {
    const model = deriveOverview(requests, new Map());
    expect(model.rows.map((r) => r.ref)).not.toContain('SF-9');
    expect(model.shipped.map((r) => r.ref)).not.toContain('SF-9');
  });

  it('counts live requests per displayed stage', () => {
    const model = deriveOverview(requests, new Map());
    expect(model.counts).toEqual([2, 1, 2, 1, 1]);
  });

  it('buckets rows into lanes with active chips before waiting chips', () => {
    const lanes = laneRows(deriveOverview(requests, new Map()).rows);
    // BUILD lane (index 2): active SF-4 sorts above the SF-5 merge gate
    expect(lanes[2].map((r) => r.ref)).toEqual(['SF-4', 'SF-5']);
  });
});

describe('Progress projection', () => {
  it('marks completed segments done, the current stage saturated, the rest future', () => {
    const gateRow = deriveRow(request({ stage: 'review', gate: 'approve_merge' }), null);
    expect(progressSegs(gateRow)).toEqual(['done', 'done', 'gate', 'future', 'future']);
    const stuck = deriveRow(request({ stage: 'build', needs_human: true, gate: null }), null);
    expect(progressSegs(stuck)).toEqual(['done', 'done', 'stuck', 'future', 'future']);
    const working = deriveRow(
      request({ stage: 'architecture', status: 'approved', gate: null }),
      run(),
    );
    expect(progressSegs(working)).toEqual(['done', 'work', 'future', 'future', 'future']);
  });

  it('groups rows by app, most-advanced first within a group', () => {
    const rows = deriveOverview(
      [
        request({ id: 1, app_name: 'Payroll', stage: 'spec', gate: 'approve_spec' }),
        request({ id: 2, app_name: 'Payroll', stage: 'deploy', status: 'approved', gate: null }),
        request({ id: 3, app_name: 'Vendor', stage: 'build', status: 'approved', gate: null }),
      ],
      new Map(),
    ).rows;
    const groups = progressGroups(rows);
    // Payroll leads — its deploy row is furthest along
    expect(groups[0].app).toBe('Payroll');
    expect(groups[0].rows.map((r) => r.id)).toEqual([2, 1]);
    expect(groups[1].app).toBe('Vendor');
  });
});

describe('Health tallies', () => {
  it('reads the server gauges and counts client-side', () => {
    const t = deriveTallies(
      mission({
        gates: [gate({ id: 1 }), gate({ id: 2 })],
        stalled: [request({ id: 3, needs_human: true })],
        stats: stats({ shipped_7d: 4, cycle_median_h: 52, gate_wait_median_h: 4.2 }),
      }),
      [request({ id: 1 }), request({ id: 2 }), request({ id: 3 })],
    );
    expect(t).toMatchObject({ open: 3, deciding: 2, attention: 1, shipped: 4 });
    expect(t.cycle).toBe('2d');
    expect(t.gateWait).toBe('4h');
  });
});

describe('Row action popover', () => {
  async function renderActions(row: ReturnType<typeof deriveRow>) {
    await TestBed.configureTestingModule({
      imports: [RowActions],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(RowActions);
    fixture.componentRef.setInput('row', row);
    fixture.detectChanges();
    return fixture;
  }

  it('renders approve + send back + open dossier for a gate row and emits the verb', async () => {
    const row = deriveRow(request({ stage: 'review', gate: 'approve_merge' }), null);
    const fixture = await renderActions(row);
    const events: string[] = [];
    fixture.componentInstance.act.subscribe((a) => events.push(a.verb));
    const buttons = [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Approve', 'Send back']);
    expect(fixture.nativeElement.textContent).toContain('Open dossier');
    buttons[0].click();
    expect(events).toEqual(['approve']);
  });
});

describe('Overview shell rendering', () => {
  it('renders the persistent health band with all six gauges', async () => {
    const fixture = await renderContent(
      mission({ gates: [gate()], stats: stats({ shipped_7d: 3, cycle_median_h: 52 }) }),
      [request()],
    );
    const band = fixture.nativeElement.querySelector('.band');
    const text = band.textContent;
    expect(text).toContain('On the line');
    expect(text).toContain('Your decision');
    expect(text).toContain('Need attention');
    expect(text).toContain('Shipped / wk');
    expect(text).toContain('Median cycle');
    expect(text).toContain('Gate response');
    expect(text).toContain('2d'); // 52h → 2d
    expect(band.querySelectorAll('.card')).toHaveLength(6);
  });

  it('flags only the gauges a human can act on', async () => {
    const fixture = await renderContent(
      mission({ gates: [gate()], stats: stats({ shipped_7d: 3, cycle_median_h: 52 }) }),
      [request()],
    );
    // one gate waiting, nothing stalled → the decision card is hot, none is bad
    const cards = [...fixture.nativeElement.querySelectorAll('.band .card')] as HTMLElement[];
    const hot = cards.filter((c) => c.classList.contains('hot'));
    expect(hot).toHaveLength(1);
    expect(hot[0].textContent).toContain('Your decision');
    expect(cards.filter((c) => c.classList.contains('bad'))).toHaveLength(0);
  });

  it('offers the Stack | Line | Progress switcher with Stack active by default', async () => {
    const fixture = await renderContent(mission(), [request()]);
    const tabs = [...fixture.nativeElement.querySelectorAll('.seg button')] as HTMLButtonElement[];
    expect(tabs.map((b) => b.textContent?.trim())).toEqual(['Stack', 'Line', 'Progress']);
    expect(tabs.find((b) => b.classList.contains('on'))?.textContent?.trim()).toBe('Stack');
  });

  it('never fills the active segment with the pale purple tint', async () => {
    const fixture = await renderContent(mission(), [request()]);
    const on = fixture.nativeElement.querySelector('.seg button.on') as HTMLElement;
    const bg = getComputedStyle(on).backgroundColor;
    // active = a neutral surface, not var(--a50)
    expect(bg).not.toBe('rgb(251, 233, 254)');
  });

  it('groups Stack rows under the five displayed stages', async () => {
    const fixture = await renderContent(mission(), [
      request({ id: 1, ref: 'SF-1', stage: 'build', status: 'approved', gate: null }),
      request({ id: 2, ref: 'SF-2', stage: 'preview', gate: 'accept_preview' }),
    ]);
    const names = [...fixture.nativeElement.querySelectorAll('.s-name')].map((el) =>
      (el as HTMLElement).textContent?.trim(),
    );
    expect(names).toContain('Build');
    expect(names).toContain('Review');
  });

  it('emits a viewChange when a switcher tab is clicked', async () => {
    const fixture = await renderContent(mission(), [request()]);
    const views: string[] = [];
    fixture.componentInstance.viewChange.subscribe((v) => views.push(v));
    const line = [...fixture.nativeElement.querySelectorAll('.seg button')].find(
      (b) => (b as HTMLElement).textContent?.trim() === 'Line',
    ) as HTMLButtonElement;
    line.click();
    expect(views).toEqual(['line']);
  });

  it('surfaces a conflict outcome as a banner', async () => {
    await TestBed.configureTestingModule({
      imports: [FloorContent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(FloorContent);
    fixture.componentRef.setInput('mission', mission());
    fixture.componentRef.setInput('requests', [request()]);
    fixture.componentRef.setInput('actionOutcomes', {
      87: { kind: 'conflict', message: 'Already approved by Kim Park at 06:02' },
    });
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('.action-outcome.conflict');
    expect(banner?.textContent).toContain('Already approved by Kim Park at 06:02');
  });
});

describe('Line view interaction', () => {
  it('names each lane with its agent and opens the action popover on a chip', async () => {
    await TestBed.configureTestingModule({
      imports: [LineView],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(LineView);
    const rows = [deriveRow(request({ stage: 'review', gate: 'approve_merge' }), null)];
    fixture.componentRef.setInput('rows', rows);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('requirements-analyst');
    expect(fixture.nativeElement.textContent).toContain('deployer');

    const chip = fixture.nativeElement.querySelector('.lchip') as HTMLButtonElement;
    chip.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('sf-row-actions')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Approve');
  });
});

describe('Floor page', () => {
  function providers(
    m: MissionOut,
    requests: FactoryRequest[],
    apiExtra: Record<string, unknown> = {},
  ) {
    return [
      provideRouter([]),
      {
        provide: Api,
        useValue: { health: simulatedHealth, mission: vi.fn(() => of(m)), ...apiExtra },
      },
      { provide: Poll, useValue: { version: signal(0), nudge: vi.fn(), start: vi.fn() } },
      { provide: Store, useValue: storeStub(requests) },
      { provide: Session, useValue: { operatorId: () => 7, operator: signal(null) } },
      { provide: Theme, useValue: { resolved: signal('light'), set: vi.fn() } },
    ];
  }

  it('warns that timings may be stale when the factory heartbeat stalls', async () => {
    const api = {
      health: () =>
        of({
          status: 'ok',
          db: 'ok',
          brain: 'scripted',
          runner: 'sim' as const,
          cli: 'opencode' as const,
          smtp: 'log-only',
          leader: true,
          epoch: 7,
          tick_age_s: 42,
          deploy_enabled: false,
        }),
      mission: vi.fn(() => of(mission())),
    };
    await TestBed.configureTestingModule({
      imports: [FloorPage],
      providers: [
        provideRouter([]),
        { provide: Api, useValue: api },
        { provide: Poll, useValue: { version: signal(0), nudge: vi.fn(), start: vi.fn() } },
        { provide: Store, useValue: storeStub() },
        { provide: Session, useValue: { operatorId: () => 7, operator: signal(null) } },
        { provide: Theme, useValue: { resolved: signal('light'), set: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(FloorPage);
    fixture.detectChanges();
    fixture.detectChanges();
    const warning = fixture.nativeElement.querySelector('.line-stale-warning');
    expect(warning).not.toBeNull();
    expect(warning!.textContent).toContain('The factory line is stalled.');
    expect(warning!.textContent).toContain('Timings and stages may be stale.');
  });

  it('routes an inline approve action into the approve modal', async () => {
    await TestBed.configureTestingModule({
      imports: [FloorPage],
      providers: providers(mission({ gates: [gate()] }), [request()]),
    }).compileComponents();
    const fixture = TestBed.createComponent(FloorPage);
    fixture.detectChanges();

    fixture.componentInstance.handleAction({ verb: 'approve', request: request() });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('sf-approve-modal')).not.toBeNull();
    // evidence came from the mission gate
    expect(fixture.componentInstance.confirming()?.evidence?.tests_passed).toBe(42);
  });

  it('renders a mocked 409 conflict as a banner with winner + local time', async () => {
    const actedAt = '2026-07-11T06:02:00Z';
    const poll = { version: signal(0), nudge: vi.fn(), start: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [FloorPage],
      providers: [
        provideRouter([]),
        {
          provide: Api,
          useValue: {
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
          },
        },
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
    const outcome = fixture.nativeElement.querySelector('.action-outcome');
    expect(outcome?.textContent).toContain(`Already approved by Kim Park at ${localTime}`);
    expect(poll.nudge).toHaveBeenCalledOnce();
  });

  it('offers only earlier pipeline stages in the send-back-to picker', async () => {
    const stalled = request({ stage: 'review', status: 'approved', gate: null, needs_human: true });
    await TestBed.configureTestingModule({
      imports: [FloorPage],
      providers: providers(mission({ stalled: [stalled] }), [stalled]),
    }).compileComponents();
    const fixture = TestBed.createComponent(FloorPage);
    fixture.detectChanges();

    fixture.componentInstance.handleAction({ verb: 'sendBackToStage', request: stalled });
    fixture.detectChanges();

    const modal = fixture.nativeElement.querySelector('sf-send-back-stage-modal');
    const choices = [...modal.querySelectorAll('.stage-choice')] as HTMLElement[];
    expect(choices.map((c) => c.textContent?.trim())).toEqual(['Architecture', 'Build']);
    choices[1].click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Discards the work after Build and redoes that stage.',
    );
  });
});
