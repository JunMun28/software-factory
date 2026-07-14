import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Api, AppEntry, FactoryRequest, Poll, Theme } from '@sf/shared';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { routes } from '../app.routes';
import { Session } from '../core/session.service';
import { Store } from '../core/store.service';

const request = (over: Partial<FactoryRequest> = {}): FactoryRequest => ({
  id: 87,
  ref: 'SF-0087',
  title: 'Export payroll summary',
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
  stage: 'build',
  status: 'approved',
  gate: null,
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
  last_event: 'Implementation in progress',
  ...over,
});

const apps: AppEntry[] = [
  {
    id: 1,
    key: 'payroll',
    name: 'Payroll',
    owner: 'People Systems',
    repo: 'acme/payroll',
    provisioning: 'Manual',
    muted: false,
    open_requests: 1,
    unread: false,
  },
  {
    id: 2,
    key: 'vendor',
    name: 'Vendor Portal',
    owner: 'Procurement',
    repo: 'acme/vendor',
    provisioning: 'GitHub App',
    muted: false,
    open_requests: 0,
    unread: false,
  },
];

describe('Library URL filters', () => {
  const allRequests = signal<FactoryRequest[]>([
    request(),
    request({
      id: 88,
      title: 'Ship vendor onboarding',
      app_id: 2,
      app_name: 'Vendor Portal',
      app_key: 'vendor',
      stage: 'done',
      status: 'done',
    }),
    request({ id: 89, title: 'Cancelled payroll cleanup', status: 'cancelled' }),
  ]);

  beforeEach(async () => {
    TestBed.resetTestingModule();
    const operator = {
      id: 7,
      name: 'Avery Stone',
      initials: 'AS',
      hue: '#0F766E',
      email: 'avery@example.com',
      created_at: '2026-07-13T00:00:00Z',
    };
    await TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: Store, useValue: { requests: allRequests, apps: signal(apps) } },
        {
          provide: Api,
          useValue: {
            health: () =>
              of({
                status: 'ok',
                brain: 'scripted',
                runner: 'sim',
                cli: 'codex',
                smtp: 'log-only',
              }),
            tick: () => of({ moved: [] }),
          },
        },
        {
          provide: Poll,
          useValue: { start: vi.fn(), nudge: vi.fn(), version: signal(0) },
        },
        {
          provide: Theme,
          useValue: { resolved: signal<'light' | 'dark'>('light'), set: vi.fn() },
        },
        {
          provide: Session,
          useValue: {
            operator: signal(operator),
            operatorId: signal(operator.id),
            resolve: () => of(operator),
            select: vi.fn(),
          },
        },
      ],
    }).compileComponents();
  });

  it('mounts a shared link with app and state filters on first load', async () => {
    const harness = await RouterTestingHarness.create('/library?app=payroll&state=in-flight');
    harness.detectChanges();
    const host = harness.routeNativeElement!;

    expect(host.querySelectorAll('.library-row')).toHaveLength(1);
    expect(host.textContent).toContain('Export payroll summary');
    expect(host.textContent).not.toContain('Ship vendor onboarding');
    expect(host.textContent).not.toContain('Cancelled payroll cleanup');
  });

  it('shows every request when filters are empty and links each row to its Dossier', async () => {
    const harness = await RouterTestingHarness.create('/library');
    harness.detectChanges();
    const rows = harness.routeNativeElement!.querySelectorAll<HTMLAnchorElement>('.library-row');

    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute('href')).toBe('/requests/87');
  });

  it('writes filter changes to query params while preserving the other filter', async () => {
    const harness = await RouterTestingHarness.create('/library?app=payroll&state=in-flight');
    harness.detectChanges();
    harness
      .routeNativeElement!.querySelector<HTMLButtonElement>('button[data-state="shipped"]')!
      .click();
    await harness.fixture.whenStable();

    expect(TestBed.inject(Router).url).toBe('/library?app=payroll&state=shipped');
  });
});
