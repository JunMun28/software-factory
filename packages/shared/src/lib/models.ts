export interface AppEntry {
  id: number;
  key: string;
  name: string;
  owner: string;
  repo: string;
  provisioning: string;
  muted: boolean;
  open_requests: number;
  unread: boolean;
}

/** The signed-in person (mock until real Entra auth). Intake → submitter, console → admin. */
export interface User {
  name: string;
  initials: string;
  color: string;
  email: string;
  role: 'submitter' | 'admin';
}

export interface Turn {
  order: number;
  question: string;
  sub: string | null;
  options: { t: string; d: string }[] | null;
  answer: string | null;
  skipped: boolean;
}

export interface SpecLine {
  text: string;
  prov: string | null;
  assume: boolean;
}

export interface CommentItem {
  id: number;
  author: string;
  initials: string;
  color: string;
  body: string;
  created_at: string;
}

export interface AuditItem {
  actor: string;
  action: string;
  note: string | null;
  created_at: string;
}

export interface FactoryRequest {
  id: number;
  ref: string;
  title: string;
  description: string;
  type: 'bug' | 'enh' | 'new' | 'other';
  urgency: string;
  reach: string | null; // me | team | dept | wider | free text
  impact_metric: 'hours' | 'cost' | 'other' | null;
  impact_value: string | null;
  priority: string;
  app_id: number | null;
  app_name: string;
  app_key: string | null;
  repo: string | null;
  /** Server-derived repo an Approve will create for app-less requests; null when the request has a real app. */
  prospective_repo: string | null;
  new_app_name: string | null;
  stage: 'intake' | 'spec' | 'architecture' | 'build' | 'review' | 'done';
  status:
    | 'draft'
    | 'submitted'
    | 'pending_approval'
    | 'approved'
    | 'sent_back'
    | 'cancelled'
    | 'done';
  gate: 'approve_spec' | 'approve_merge' | null;
  needs_human: boolean;
  needs_human_reason: string | null;
  reporter: string;
  reporter_initials: string;
  labels: { name: string; color: string }[] | null;
  send_back_question: string | null;
  send_back_response: string | null;
  send_back_rounds: number;
  repo_ready: boolean;
  spec_pr_open: boolean;
  stage2_fired: boolean;
  spec_open_note: string | null;
  created_at: string;
  updated_at: string;
  stage_entered_at: string | null;
  last_event: string | null;
}

export interface RequestDetail extends FactoryRequest {
  turns: Turn[];
  spec_lines: SpecLine[];
  comments: CommentItem[];
  audit: AuditItem[];
  duplicate: { ref: string; title: string; id: number } | null;
  /** Live run state — present only while a build is in-flight (Plan 1). */
  run: RunState | null;
  /** Gate evidence — present only while parked at a gate (Plan 1). */
  evidence: Evidence | null;
}

export interface InterviewState {
  done: boolean;
  asked: number;
  total: number;
  question: string | null;
  sub: string | null;
  options: { t: string; d: string }[] | null;
  final: boolean;
  turns: Turn[];
}

export interface ProgressEvent {
  id: number;
  request_id: number | null;
  subject_id: number | null;
  kind:
    | 'milestone_summary'
    | 'gate_event'
    | 'escalation'
    | 'recovery_action'
    | 'comment'
    | 'step_summary'
    | 'steer_note'
    | 'verification';
  stage: string;
  actor: string;
  bot: boolean;
  broadcast: boolean;
  title: string;
  body: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  request_ref: string | null;
  request_title: string | null;
}

/** Derived run-state for an in-flight build (ADR 0014 — computed server-side, never stored). */
export interface RunState {
  step: number;
  of: number;
  label: string | null;
  health: 'healthy' | 'slow' | 'no_signal';
  seconds_since_event: number;
}

/** What the admin sees before approving (spec §6 evidence strip). */
export interface Evidence {
  kind: 'spec' | 'merge';
  grounded_lines: number | null;
  total_lines: number | null;
  interview_count: number | null;
  tests_passed: number | null;
  tests_total: number | null;
  diff_added: number | null;
  diff_removed: number | null;
  files_changed: number | null;
  reviewer_verdict: string | null;
  assumptions: string[];
}

export interface MissionGate {
  request: FactoryRequest;
  /** null → render "no evidence recorded" (legacy/pre-revamp gates). */
  evidence: Evidence | null;
}

export interface MissionRun {
  request: FactoryRequest;
  run: RunState;
}

/** One poll for the Mission control home (spec §6). */
export interface MissionOut {
  gates: MissionGate[];
  runs: MissionRun[];
  stalled: FactoryRequest[];
  recent: FactoryRequest[];
  cursor: number;
}
