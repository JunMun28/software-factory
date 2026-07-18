/*
 * Public API Surface of @sf/shared.
 *
 * Per-symbol exports — no `export *` (deepening candidate 2, D10). Every name
 * below is a deliberate, grep-able contract with the intake and console apps;
 * adding one widens the surface the shared-gate CI (ADR 0017) defends, so do
 * it consciously. lib/public-surface.spec.ts locks the value surface.
 */

// ---- domain models (types only) ----
export type {
  AppDeploy,
  AppEntry,
  AppRollback,
  AppSubscription,
  Attachment,
  AuditItem,
  ClassifyResult,
  CommentItem,
  Evidence,
  FactoryRequest,
  InterviewState,
  MissionGate,
  MissionHumanOwned,
  MissionOut,
  MissionRecent,
  MissionRun,
  MissionStats,
  Operator,
  PreviewFeedbackItem,
  PreviewStatus,
  ProgressEvent,
  PrototypeAnnotation,
  PrototypeState,
  PrototypeTurn,
  RequestDetail,
  ReviewSummary,
  RollbackEnqueue,
  RunState,
  SpecLine,
  SpecSection,
  SteerState,
  Turn,
  User,
} from './lib/models';

// ---- label tables + pure helpers ----
export {
  STAGE_LABEL,
  TYPE_LABEL,
  TYPE_SHORT,
  adminStateLine,
  boardGlyph,
  clock,
  confirmSteps,
  elapsedShort,
  evidenceBits,
  gateLabel,
  groupTrace,
  healthLine,
  inFlight,
  liveStatus,
  loadStoredUser,
  missionRowLabel,
  missionSubtitle,
  missionSummary,
  plainActivity,
  plainStage,
  prototypeSrcdoc,
  timeAgo,
  utc,
} from './lib/util';
export type { EvidenceBit, TraceGroup, TraceRow } from './lib/util';

// ---- services ----
export { Api } from './lib/api.service';
export { FactoryAuth, shouldAttachToken } from './lib/auth.service';
export type { AuthConfig, FactoryAppName } from './lib/auth.service';
export { factoryAuthInterceptor } from './lib/auth.interceptor';
export { Poll } from './lib/poll.service';
export { Theme } from './lib/theme.service';
export type { ThemeChoice } from './lib/theme.service';

// ---- UI kit primitives ----
export { Autofocus, Avatar, Glyph, Icon, Mark, Pill, Sig, TrackChip, TypeChip } from './lib/kit';
