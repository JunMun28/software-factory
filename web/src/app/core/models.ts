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
  priority: string;
  app_id: number | null;
  app_name: string;
  app_key: string | null;
  repo: string | null;
  new_app_name: string | null;
  stage: 'intake' | 'spec' | 'architecture' | 'build' | 'review' | 'done';
  status: 'draft' | 'submitted' | 'pending_approval' | 'approved' | 'sent_back' | 'cancelled' | 'done';
  gate: 'approve_spec' | 'approve_merge' | null;
  needs_human: boolean;
  needs_human_reason: string | null;
  reporter: string;
  reporter_initials: string;
  assignee: string | null;
  assignee_initials: string | null;
  assignee_color: string | null;
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
  kind: 'milestone_summary' | 'gate_event' | 'escalation' | 'recovery_action';
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
