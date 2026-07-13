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

export interface Operator {
  id: number;
  name: string;
  initials: string;
  hue: string;
  email: string;
  created_at: string;
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
  bug_where: string | null;
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
    | 'human_owned'
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

export interface Attachment {
  id: number;
  filename: string;
  mime: string;
  kind: 'image' | 'doc';
  size: number;
  source: 'describe' | 'interview';
  created_at: string;
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
  attachments?: Attachment[];
  /** Prototype step (new-app only) — the current mock + status, so Review renders it inline. */
  prototype_html?: string | null;
  prototype_status?: 'none' | 'draft' | 'edited' | 'skipped';
}

export interface InterviewState {
  done: boolean;
  asked: number;
  total: number;
  /** the next question is generating in the background — poll until it lands */
  thinking: boolean;
  question: string | null;
  sub: string | null;
  options: { t: string; d: string }[] | null;
  final: boolean;
  turns: Turn[];
}

/** One titled section of the structured Review spec. */
export interface SpecSection {
  title: string;
  items: string[];
}

/** The AI-written Review-step spec: an overview + structured sections. `thinking` → still
 *  generating; poll until it lands. */
export interface ReviewSummary {
  overview: string | null;
  sections: SpecSection[];
  thinking: boolean;
}

/** A point-to-edit marker: the DOM element the user pointed at, to scope the next edit. */
export interface PrototypeAnnotation {
  pid: string | null;
  selector: string | null;
  tag?: string | null;
  textSnippet?: string | null;
  outerHTML?: string | null;
  rect?: { x: number; y: number; w: number; h: number } | null;
}

/** One prototype exchange in the chat thread (the html rides on PrototypeState). */
export interface PrototypeTurn {
  order: number;
  instruction: string | null;
  annotation: PrototypeAnnotation | null;
  mode: 'pending' | 'rewrite' | 'patch' | 'chat';
  note: string | null;
  /** this turn produced a document (offer undo to it) */
  revision: boolean;
}

/** The Prototype step's live state: the current self-contained HTML mock + the chat thread. */
export interface PrototypeState {
  html: string | null;
  status: 'none' | 'draft' | 'edited' | 'skipped';
  /** a revision is generating in the background — poll or open the stream */
  thinking: boolean;
  turns: PrototypeTurn[];
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
  steer: SteerState | null;
}

export interface SteerState {
  state: 'queued' | 'heard';
  note: string;
  at_step: number | null;
  acked_at: string | null;
}

export interface MissionHumanOwned {
  request: FactoryRequest;
  taken_over_by: string;
  taken_over_at: string;
}

/** One poll for the Mission control home (spec §6). */
export interface MissionOut {
  gates: MissionGate[];
  runs: MissionRun[];
  stalled: FactoryRequest[];
  human_owned: MissionHumanOwned[];
  recent: MissionRecent[];
  cursor: number;
}

export interface MissionRecent {
  request: FactoryRequest;
  outcome: string;
  decided_by: string;
  decided_at: string;
}
