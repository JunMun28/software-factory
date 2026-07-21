// Cross-origin bases for the ng-v0 preview-editing bridge (docs/design/ng-v0-bridge.md).
// Same shape as the factory API base — a module constant, no environments/ dir in this
// app. Dev defaults are wired here; the office swap is a one-line change per host.
//
//   NG_V0_UI_BASE     — the vendored ng-v0 Angular workspace (app-preview/ui), whose
//                       `ng serve` defaults to :4200. "Edit in ng-v0" opens it.
//   ORCHESTRATOR_BASE — the Hono orchestrator (app-preview/orchestrator), default :7071.
//                       "Send back to the factory" reads /chats + exports a version here.
export const NG_V0_UI_BASE = 'http://localhost:4200';
export const ORCHESTRATOR_BASE = 'http://127.0.0.1:7071';
