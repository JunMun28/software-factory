import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { Api, Poll, ProgressEvent, RequestDetail, Theme } from '@sf/shared';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { Session } from '../core/session.service';
import { DossierPage } from './dossier-page';
import { buildDossierChapters } from './dossier-view';

const event = (
  id: number,
  kind: ProgressEvent['kind'],
  stage: string,
  over: Partial<ProgressEvent> = {},
): ProgressEvent => ({
  id,
  request_id: 42,
  subject_id: 3,
  kind,
  stage,
  actor: 'Factory',
  bot: true,
  broadcast: false,
  title: `${kind} ${id}`,
  body: null,
  payload: {},
  created_at: `2026-07-13T0${id}:00:00Z`,
  request_ref: 'SF-0042',
  request_title: 'Invoice reminder emails',
  ...over,
});

describe('Dossier chapter projection', () => {
  it('groups a mixed trace into ordered story chapters and signs consequential chapters', () => {
    const chapters = buildDossierChapters([
      event(1, 'step_summary', 'architecture', {
        payload: { step: 1, of: 4, label: 'reading SPEC.md' },
      }),
      event(2, 'gate_event', 'architecture', { actor: 'Kim Park', bot: false }),
      event(3, 'escalation', 'build', { actor: 'Factory' }),
      event(4, 'steer_note', 'build', { actor: 'Aisha Rahman', bot: false }),
      event(5, 'comment', 'build', { actor: 'Jun Mun', bot: false }),
      event(6, 'step_summary', 'build', {
        payload: { step: 2, of: 5, label: 'implementing the change' },
      }),
    ]);

    expect(chapters.map((chapter) => chapter.kind)).toEqual([
      'stage',
      'decision',
      'escalation',
      'steer',
      'comment',
      'stage',
    ]);
    expect(chapters.map((chapter) => chapter.events.map((item) => item.id))).toEqual([
      [1],
      [2],
      [3],
      [4],
      [5],
      [6],
    ]);
    expect(chapters.slice(1, 5).map(({ decidedBy, decidedAt }) => [decidedBy, decidedAt])).toEqual([
      ['Kim Park', '2026-07-13T02:00:00Z'],
      ['Factory', '2026-07-13T03:00:00Z'],
      ['Aisha Rahman', '2026-07-13T04:00:00Z'],
      ['Jun Mun', '2026-07-13T05:00:00Z'],
    ]);
  });

  it('keeps an automated gate opening distinct from a signed human decision', () => {
    const [chapter] = buildDossierChapters([
      event(7, 'gate_event', 'review', {
        title: 'Waiting at the merge gate — review passed, approval needed',
        actor: 'Factory',
        bot: true,
      }),
    ]);

    expect(chapter).toMatchObject({
      kind: 'gate',
      label: 'Gate',
      statusWord: 'Waiting for approval',
      decidedBy: null,
      decidedAt: null,
    });
  });

  it('derives heard-at-step for an acknowledged steer and queued for an unacknowledged steer', () => {
    const chapters = buildDossierChapters([
      event(10, 'steer_note', 'build', { title: 'Reuse the existing OAuth client' }),
      event(11, 'step_summary', 'build', {
        payload: { step: 4, of: 7, label: 'implementing', acked_steer_ids: [10] },
      }),
      event(12, 'steer_note', 'build', { title: 'Keep the old parser' }),
    ]);

    expect(chapters.find((chapter) => chapter.events[0].id === 10)?.steerState).toEqual({
      state: 'heard',
      atStep: 4,
    });
    expect(chapters.find((chapter) => chapter.events[0].id === 12)?.steerState).toEqual({
      state: 'queued',
      atStep: null,
    });
  });
});

const detail = (over: Partial<RequestDetail> = {}): RequestDetail =>
  ({
    id: 999,
    ref: 'SF-0042',
    title: 'Invoice reminder emails',
    description: 'Send reminders before invoices become overdue.',
    type: 'enh',
    urgency: 'soon',
    reach: 'team',
    impact_metric: 'hours',
    impact_value: '5',
    bug_where: null,
    priority: 'normal',
    app_id: 3,
    app_name: 'Billing',
    app_key: 'billing',
    repo: 'acme/billing',
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
    created_at: '2026-07-13T01:00:00Z',
    updated_at: '2026-07-13T08:00:00Z',
    stage_entered_at: '2026-07-13T07:00:00Z',
    last_event: 'Waiting at merge gate',
    turns: [],
    spec_lines: [],
    comments: [],
    audit: [],
    duplicate: null,
    run: null,
    evidence: null,
    attachments: [
      {
        id: 7,
        filename: 'verification.txt',
        mime: 'text/plain',
        kind: 'doc',
        size: 23,
        source: 'describe',
        created_at: '2026-07-13T01:00:00Z',
      },
    ],
    ...over,
  }) as RequestDetail;

const simulatedHealth = () =>
  of({ status: 'ok', brain: 'scripted', runner: 'sim' as const, cli: 'codex' as const });

async function pageFixture(
  apiOver: Record<string, unknown> = {},
  fragment: string | null = null,
): Promise<{ fixture: ComponentFixture<DossierPage>; api: Record<string, any> }> {
  const trace = [
    event(8, 'verification', 'review', {
      title: 'Verification passed',
      payload: { tests_passed: 42, tests_total: 42 },
    }),
  ];
  const api = {
    health: simulatedHealth,
    request: vi.fn(() => of(detail())),
    trace: vi.fn(() => of({ items: trace, cursor: 8 })),
    comments: vi.fn(() =>
      of([
        {
          id: 4,
          author: 'Kim Park',
          initials: 'KP',
          color: '#520170',
          body: 'Ready for the merge.',
          created_at: '2026-07-13T08:00:00Z',
        },
      ]),
    ),
    attachmentRawUrl: vi.fn((id: number) => `/api/attachments/${id}/raw`),
    ...apiOver,
  };
  const route = {
    snapshot: {
      paramMap: convertToParamMap({ id: '42' }),
      fragment,
    },
    paramMap: of(convertToParamMap({ id: '42' })),
    fragment: of(fragment),
  };
  await TestBed.configureTestingModule({
    imports: [DossierPage],
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: route },
      { provide: Api, useValue: api },
      { provide: Poll, useValue: { version: signal(0), nudge: vi.fn(), start: vi.fn() } },
      {
        provide: Session,
        useValue: {
          operatorId: () => 7,
          operator: () => ({ id: 7, name: 'Jun Mun', initials: 'JM', hue: '#520170' }),
          user: () => ({ name: 'Jun Mun', initials: 'JM', color: '#520170' }),
        },
      },
      { provide: Theme, useValue: { resolved: () => 'light', set: vi.fn() } },
    ],
  }).compileComponents();
  vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  const fixture = TestBed.createComponent(DossierPage);
  fixture.detectChanges();
  return { fixture, api };
}

describe('Dossier evidence drawer', () => {
  it('expands a chapter to show its raw event, payload, and attachments', async () => {
    const { fixture } = await pageFixture();
    const chapter = fixture.nativeElement.querySelector('#chapter-8');
    expect(chapter.querySelector('.evidence-drawer')).toBeNull();

    chapter.querySelector('.chapter-toggle').click();
    fixture.detectChanges();

    expect(chapter.querySelector('.raw-event')?.textContent).toContain('verification');
    expect(chapter.querySelector('pre')?.textContent).toContain('"tests_passed": 42');
    expect(chapter.querySelector('.drawer-attachments')?.textContent).toContain('verification.txt');
  });

  it('opens the fragment-linked chapter on first render', async () => {
    const { fixture } = await pageFixture({}, 'chapter-8');
    const chapter = fixture.nativeElement.querySelector('#chapter-8');
    expect(chapter.querySelector('.evidence-drawer')).not.toBeNull();
    expect(chapter.querySelector('.chapter-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('Dossier actions and explicit comments', () => {
  it('renders the signed winner in place when approve loses a CAS race', async () => {
    const actedAt = '2026-07-13T06:02:00Z';
    const { fixture } = await pageFixture({
      approve: vi.fn(() =>
        throwError(
          () =>
            new HttpErrorResponse({
              status: 409,
              error: {
                acted_by: 'Kim Park',
                acted_at: actedAt,
                resulting_state: 'done',
              },
            }),
        ),
      ),
    });

    fixture.componentInstance.approve();
    fixture.detectChanges();

    const localTime = new Date(actedAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(fixture.nativeElement.querySelector('.action-outcome')?.textContent).toContain(
      `Already approved by Kim Park at ${localTime}`,
    );
  });

  it('posts a comment with the route id, not the request projection id', async () => {
    const comment = vi.fn(() => of({}));
    const { fixture, api } = await pageFixture({ comment });
    fixture.componentInstance.commentText.set('  Please keep the migration note.  ');

    fixture.componentInstance.postComment();
    fixture.detectChanges();

    expect(api['comment']).toHaveBeenCalledWith(42, 'Please keep the migration note.', 7);
    expect(api['comments']).toHaveBeenCalledWith(42);
    expect(api['trace']).toHaveBeenCalledWith(42, 0, 500);
  });
});
