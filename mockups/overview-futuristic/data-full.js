/* SYNTHETIC — not from the API. A healthy factory, for judging layout only.
 *
 * The live set (data.js) is a degenerate distribution: 20 of 28 requests are
 * jammed in Spec, three stages are empty, and NOTHING is `active` — so the
 * working state and the flow idea never render at all. This set fills every
 * stage and exercises every status, so a composition can be judged against a
 * factory that is actually running.
 *
 * App names and stage semantics match the real ones. Never present as live.
 */
const REQS_FULL = [
  // ── Spec (0) ─────────────────────────────────────────────────────────────
  { ref: 'REQ-2151', title: 'Bulk-approve expenses under the receipt threshold', app: 'Northwind Expenses', stage: 0, kind: 'active', age: '3h' },
  { ref: 'REQ-2149', title: 'Let technicians attach photos from the job screen', app: 'FieldOps', stage: 0, kind: 'active', age: '6h' },
  { ref: 'REQ-2147', title: 'Warn before a vendor record is deleted', app: 'Vendor Portal', stage: 0, kind: 'gate', age: '1d' },
  { ref: 'REQ-2144', title: 'Weekly digest of overdue maintenance jobs', app: 'Maintenance Planner', stage: 0, kind: 'gate', age: '2d' },
  { ref: 'REQ-2141', title: 'Search the parts catalogue by supplier code', app: 'Inventory Sync', stage: 0, kind: 'gate', age: '4d' },
  { ref: 'REQ-2139', title: 'A shared shopping list our whole floor can edit', app: 'No app yet', stage: 0, kind: 'wait', age: '2d' },
  { ref: 'REQ-2137', title: 'Track which fridge items expire this week', app: 'PantryPal', stage: 0, kind: 'wait', age: '5d' },

  // ── Arch (1) ─────────────────────────────────────────────────────────────
  { ref: 'REQ-2134', title: 'Move receipt storage off the app server', app: 'Northwind Expenses', stage: 1, kind: 'active', age: '2h' },
  { ref: 'REQ-2131', title: 'Offline job queue for vans without signal', app: 'FieldOps', stage: 1, kind: 'active', age: '9h' },
  { ref: 'REQ-2129', title: 'Single sign-on across the three finance apps', app: 'Billing Portal', stage: 1, kind: 'gate', age: '1d' },
  { ref: 'REQ-2126', title: 'Split the reporting database from the write path', app: 'Headcount Dashboard', stage: 1, kind: 'gate', age: '3d' },
  { ref: 'REQ-2124', title: 'Audit trail for every supplier record change', app: 'Supplier Onboarding', stage: 1, kind: 'wait', age: '2d' },

  // ── Build (2) ────────────────────────────────────────────────────────────
  { ref: 'REQ-2121', title: 'Export expenses to the payroll CSV format', app: 'Northwind Expenses', stage: 2, kind: 'active', age: '40m' },
  { ref: 'REQ-2119', title: 'Downtime reasons as a picklist, not free text', app: 'Downtime logger', stage: 2, kind: 'active', age: '2h' },
  { ref: 'REQ-2117', title: 'Reassign a job without reopening it', app: 'Maintenance Planner', stage: 2, kind: 'active', age: '5h' },
  { ref: 'REQ-2115', title: 'Show stock levels on the vendor order form', app: 'Vendor Portal', stage: 2, kind: 'active', age: '8h' },
  { ref: 'REQ-2113', title: 'Approve or reject straight from the email', app: 'Billing Portal', stage: 2, kind: 'gate', age: '1d' },
  { ref: 'REQ-2111', title: 'Filter the roster by shift and team', app: 'No app yet', stage: 2, kind: 'gate', age: '2d' },
  { ref: 'REQ-2109', title: 'Chase overdue approvals automatically', app: 'Northwind Expenses', stage: 2, kind: 'gate', age: '3d' },
  { ref: 'REQ-2107', title: 'Sync parts pricing from the supplier feed', app: 'Inventory Sync', stage: 2, kind: 'stuck', age: '6d' },

  // ── Review (3) — the requester has the preview ───────────────────────────
  { ref: 'REQ-2105', title: 'Machine downtime summary for the morning stand-up', app: 'Downtime logger', stage: 3, kind: 'wait', age: '1d' },
  { ref: 'REQ-2103', title: 'Photo evidence attached to completed jobs', app: 'FieldOps', stage: 3, kind: 'wait', age: '2d' },
  { ref: 'REQ-2101', title: 'Headcount by cost centre, not just by team', app: 'Headcount Dashboard', stage: 3, kind: 'wait', age: '4d' },
  { ref: 'REQ-2099', title: 'Onboard a supplier without leaving the portal', app: 'Supplier Onboarding', stage: 3, kind: 'active', age: '3h' },

  // ── Deploy (4) ───────────────────────────────────────────────────────────
  { ref: 'REQ-2097', title: 'Faster expense export for month end', app: 'Northwind Expenses', stage: 4, kind: 'active', age: '25m' },
  { ref: 'REQ-2095', title: 'Tea-break roster for the lab team', app: 'No app yet', stage: 4, kind: 'active', age: '1h' },
  { ref: 'REQ-2093', title: 'Retire the legacy vendor import script', app: 'Vendor Portal', stage: 4, kind: 'gate', age: '1d' },

  // ── Done (5) ─────────────────────────────────────────────────────────────
  { ref: 'REQ-2091', title: 'Fix typo in the approval email', app: 'Northwind Expenses', stage: 5, kind: 'done', age: '1d' },
  { ref: 'REQ-2089', title: 'Monthly expense CSV', app: 'Northwind Expenses', stage: 5, kind: 'done', age: '2d' },
  { ref: 'REQ-2087', title: 'Vendors get an email when onboarding completes', app: 'Vendor Portal', stage: 5, kind: 'done', age: '3d' },
  { ref: 'REQ-2085', title: 'Category report no longer crashes on blank category', app: 'Northwind Expenses', stage: 5, kind: 'done', age: '5d' },
  { ref: 'REQ-2083', title: 'Login button alignment on iPad', app: 'FieldOps', stage: 5, kind: 'done', age: '1w' },
  { ref: 'REQ-2081', title: 'Guitar course video playback on mobile', app: 'guitar learning platform', stage: 5, kind: 'done', age: '2w' },
];
