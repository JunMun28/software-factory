import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { Evidence, FactoryRequest } from '@sf/shared';

import {
  ApproveModal,
  CancelConfirm,
  RecoveryConfirm,
  SendBackModal,
  SendBackStageModal,
} from './gate-modals';

function req(over: Partial<FactoryRequest> = {}): FactoryRequest {
  return {
    id: 1,
    ref: 'REQ-1',
    title: 'Fix the export',
    description: '',
    type: 'enh',
    urgency: 'normal',
    reach: null,
    impact_metric: null,
    impact_value: null,
    bug_where: null,
    priority: 'Normal',
    app_id: 1,
    app_name: 'App',
    app_key: 'app',
    repo: null,
    prospective_repo: null,
    new_app_name: null,
    stage: 'spec',
    status: 'pending_approval',
    gate: 'approve_spec',
    needs_human: false,
    needs_human_reason: null,
    reporter: 'Jun',
    reporter_initials: 'JM',
    labels: null,
    send_back_question: null,
    send_back_response: null,
    send_back_rounds: 0,
    repo_ready: false,
    spec_pr_open: false,
    stage2_fired: false,
    spec_open_note: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stage_entered_at: null,
    last_event: null,
    ...over,
  };
}

const MERGE_EVIDENCE: Evidence = {
  kind: 'merge',
  grounded_lines: null,
  total_lines: null,
  interview_count: null,
  tests_passed: 12,
  tests_total: 12,
  diff_added: 40,
  diff_removed: 3,
  files_changed: 2,
  reviewer_verdict: 'approved',
  assumptions: [],
};

@Component({
  imports: [ApproveModal],
  template: `<sf-approve-modal
    [r]="r()"
    [evidence]="evidence()"
    (approved)="approvals = approvals + 1"
    (cancelled)="cancels = cancels + 1"
  />`,
})
class ApproveHost {
  r = signal(req({ gate: 'approve_spec', prospective_repo: 'micron/new-app' }));
  evidence = signal<Evidence | null>(null);
  approvals = 0;
  cancels = 0;
}

@Component({
  imports: [SendBackModal],
  template: `<sf-send-back-modal
    reporter="Jun"
    (sent)="sentNote = $event"
    (cancelled)="cancels = cancels + 1"
  />`,
})
class SendBackHost {
  sentNote = '';
  cancels = 0;
}

@Component({
  imports: [SendBackStageModal],
  template: `<sf-send-back-stage-modal [currentStage]="stage()" (sent)="sentTo = $event" />`,
})
class StageHost {
  stage = signal<FactoryRequest['stage']>('review');
  sentTo: { stage: 'architecture' | 'build' | 'review'; reason: string } | null = null;
}

@Component({
  imports: [RecoveryConfirm],
  template: `<sf-recovery-confirm
    title="Retry the build?"
    consequence="Re-runs the stage from its last checkpoint."
    confirmLabel="Retry"
    (kept)="keeps = keeps + 1"
    (confirmed)="confirms = confirms + 1"
  />`,
})
class RecoveryHost {
  keeps = 0;
  confirms = 0;
}

@Component({
  imports: [CancelConfirm],
  template: `<sf-cancel-confirm
    [r]="r()"
    (kept)="keeps = keeps + 1"
    (confirmed)="confirms = confirms + 1"
  />`,
})
class CancelHost {
  r = signal(req());
  keeps = 0;
  confirms = 0;
}

describe('ApproveModal', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [ApproveHost] }));

  it('renders the spec-gate copy with the irreversible steps', () => {
    const f = TestBed.createComponent(ApproveHost);
    f.detectChanges();
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Approve this spec?');
    expect(text).toContain('Approve & start build');
    expect(text).toContain('Create the GitHub repo');
    expect(text).toContain('micron/new-app'); // prospective_repo via confirmSteps
  });

  it('renders the merge-gate copy when evidence is present', () => {
    const f = TestBed.createComponent(ApproveHost);
    f.componentInstance.r.set(req({ gate: 'approve_merge', repo: 'micron/northwind' }));
    f.componentInstance.evidence.set(MERGE_EVIDENCE);
    f.detectChanges();
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Approve this merge?');
    expect(text).toContain('Approve & deploy');
    expect(text).toContain('micron/northwind');
    expect(text).not.toContain('No evidence is recorded');
  });

  it('says out loud when a merge gate would be approved blind (gap #1)', () => {
    const f = TestBed.createComponent(ApproveHost);
    f.componentInstance.r.set(req({ gate: 'approve_merge', repo: 'micron/northwind' }));
    f.componentInstance.evidence.set(null);
    f.detectChanges();
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('No evidence is recorded for this gate');
    expect(text).toContain('Approve without evidence');
    expect(text).not.toContain('Approve & deploy');
  });

  it('never warns a spec gate about evidence (grounding rides the spec itself)', () => {
    const f = TestBed.createComponent(ApproveHost);
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).not.toContain('No evidence is recorded');
  });

  it('renders the deploy-gate copy (Plan B4: the second human gate)', () => {
    const f = TestBed.createComponent(ApproveHost);
    f.componentInstance.r.set(
      req({ gate: 'approve_deploy', repo: 'micron/northwind', app_key: 'northwind' }),
    );
    f.componentInstance.evidence.set(MERGE_EVIDENCE);
    f.detectChanges();
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Approve this deploy?');
    expect(text).toContain('Approve & deploy');
    expect(text).toContain('Build the image from merged main');
    expect(text).toContain('northwind.localtest.me');
  });

  it('emits approved / cancelled from the two buttons', () => {
    const f = TestBed.createComponent(ApproveHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.btn.primary')!.click();
    el.querySelector<HTMLButtonElement>('.btn:not(.primary)')!.click();
    expect(f.componentInstance.approvals).toBe(1);
    expect(f.componentInstance.cancels).toBe(1);
  });
});

describe('SendBackModal', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [SendBackHost] }));

  it('disables Send back until a note is typed, then emits the trimmed note', async () => {
    const f = TestBed.createComponent(SendBackHost);
    f.detectChanges();
    await f.whenStable();
    const el = f.nativeElement as HTMLElement;
    const primary = el.querySelector<HTMLButtonElement>('.btn.primary')!;
    expect(primary.disabled).toBe(true);

    const area = el.querySelector<HTMLTextAreaElement>('textarea')!;
    area.value = '  Which environment does this affect?  ';
    area.dispatchEvent(new Event('input'));
    f.detectChanges();
    await f.whenStable();

    expect(primary.disabled).toBe(false);
    primary.click();
    expect(f.componentInstance.sentNote).toBe('Which environment does this affect?');
  });
});

describe('SendBackStageModal', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [StageHost] }));

  it('offers only strictly-earlier stages from review', () => {
    const f = TestBed.createComponent(StageHost);
    f.detectChanges();
    const labels = Array.from(
      (f.nativeElement as HTMLElement).querySelectorAll('.stage-choice'),
    ).map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Architecture', 'Build']);
  });

  it('explains when there is nothing earlier', () => {
    const f = TestBed.createComponent(StageHost);
    f.componentInstance.stage.set('architecture');
    f.detectChanges();
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('already the earliest stage');
    expect((f.nativeElement as HTMLElement).querySelectorAll('.stage-choice').length).toBe(0);
  });

  it('requires a stage and a reason, then emits both', async () => {
    const f = TestBed.createComponent(StageHost);
    f.detectChanges();
    await f.whenStable();
    const el = f.nativeElement as HTMLElement;

    el.querySelectorAll<HTMLButtonElement>('.stage-choice')[1]!.click(); // Build
    f.detectChanges();
    await f.whenStable();

    const area = el.querySelector<HTMLTextAreaElement>('textarea')!;
    area.value = 'Wrong DB migration.';
    area.dispatchEvent(new Event('input'));
    f.detectChanges();
    await f.whenStable();

    el.querySelector<HTMLButtonElement>('.btn.primary:not(.stage-choice)')!.click();
    expect(f.componentInstance.sentTo).toEqual({ stage: 'build', reason: 'Wrong DB migration.' });
  });
});

describe('RecoveryConfirm', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [RecoveryHost] }));

  it('renders title, consequence and confirm label, and emits both outputs', () => {
    const f = TestBed.createComponent(RecoveryHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const text = el.textContent ?? '';
    expect(text).toContain('Retry the build?');
    expect(text).toContain('last checkpoint');
    el.querySelector<HTMLButtonElement>('.btn.primary')!.click(); // "Retry"
    el.querySelector<HTMLButtonElement>('.btn:not(.primary)')!.click(); // "Keep it stopped"
    expect(f.componentInstance.confirms).toBe(1);
    expect(f.componentInstance.keeps).toBe(1);
  });
});

describe('CancelConfirm', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [CancelHost] }));

  it('names the request and reporter, and emits confirmed from the danger button', () => {
    const f = TestBed.createComponent(CancelHost);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const text = el.textContent ?? '';
    expect(text).toContain('Cancel this request?');
    expect(text).toContain('Fix the export');
    expect(text).toContain('Jun');
    el.querySelector<HTMLButtonElement>('.btn.danger')!.click();
    expect(f.componentInstance.confirms).toBe(1);
  });
});
