# World-class control-room and agent-fleet references

This note asks what an internal AIRES should borrow from mature product tools,
incident-response systems, agent observability products, and high-performance control rooms.
It uses only primary material: official documentation, product pages, changelogs, first-party
technical writing, NASA publications, and ISA material. Recommendations are design deductions
for this console, not claims that the source products share its exact operating model.

The strongest recurring idea is progressive disclosure: a calm fleet-level picture answers
“what needs attention?”, a work queue answers “who is handling it?”, and a run detail answers
“what happened and what can I safely do next?” The console should not compress all three jobs
into one dashboard.

## 1. Product-tool craft

### Linear: speed through one interaction grammar
- Linear exposes the same action through visible controls, contextual menus, shortcuts, and a
  context-sensitive command menu; that repetition makes actions discoverable while letting
  practiced users build muscle memory. [Linear conceptual model](https://linear.app/docs/conceptual-model)
- `Cmd/Ctrl K` searches actions applicable to the current view or selection, while patterned
  shortcuts (`G` then a destination, `O` then an object class) make navigation learnable rather
  than a bag of unrelated accelerators. [Linear conceptual model](https://linear.app/docs/conceptual-model)
- Linear supports multi-select, bulk mutation, and undo, a useful model for low-risk factory
  triage actions such as acknowledge, assign, archive, or change priority. [Linear conceptual model](https://linear.app/docs/conceptual-model)
- The same issue collection can be list or board; grouping, ordering, visible fields, and empty
  groups are adjustable without creating a new product surface. [Linear display options](https://linear.app/docs/display-options)
- Display preferences can remain personal or become a workspace default, separating an
  operator's working view from the team's shared operating model. [Linear display options](https://linear.app/docs/display-options)
- Saved filtered views are shareable, ownable, and favorite-able, which turns recurring queries
  into named coordination artifacts rather than duplicated dashboards. [Linear custom views](https://linear.app/docs/custom-views)
- Dense board and list modes retain near-parity in keyboard behavior, so changing visual layout
  does not force operators to relearn the system. [Linear board layout](https://linear.app/docs/board-layout)

**Factory lesson:** keep a small stable IA, then let filters, grouping, saved views, and a
selection-aware command menu carry variation. Keyboard-first is functional when it is a second
path through the same action model; hidden shortcuts alone are fashion.

### Vercel: deployment as a legible object
- Vercel gives each deployment a unique URL and separates Local, Preview, and Production,
  making environment and artifact identity visible rather than implicit. [Vercel deployment overview](https://vercel.com/docs/deployments/overview)
- Project overview emphasizes the latest production deployment, URL, commit details, and logs;
  deployment detail then exposes status, resources, build time, framework, errors, and actions.
  [Vercel deployment overview](https://vercel.com/docs/deployments/overview)
- Deployment history is filterable by branch, status, date range, and environment, and operators
  can inspect, redeploy, or promote from the deployment surface. [Managing deployments](https://vercel.com/docs/deployments/managing-deployments)
- Build failures surface an error status in the deployment list, an error summary on detail,
  and the underlying build log in an expandable section. [Troubleshooting build errors](https://vercel.com/docs/deployments/troubleshoot-a-build)
- Runtime logs are real-time, grouped per request, and inspectable by request metadata, region,
  cache, middleware, function, deployment, event timeline, and chronological messages.
  [Vercel runtime logs](https://vercel.com/docs/logs/runtime)
- New runtime rows are deliberately fetched through “Show New Logs,” making freshness an
  explicit interaction instead of silently moving the operator's reading position.
  [Vercel runtime logs](https://vercel.com/docs/logs/runtime)
- Team activity is a separate chronological audit surface showing actor, event type, account
  type, and time, with exact timestamp on hover. [Vercel activity log](https://vercel.com/docs/activity-log)

**Factory lesson:** make a run a first-class, linkable artifact with environment, source revision,
latest outcome, evidence, and safe actions. Separate machine execution logs from human/team
activity, but correlate both on run detail.

### Datadog: dense monitoring without one fixed dashboard
- Datadog template variables dynamically filter or group widgets and can be saved as views,
  allowing one dashboard definition to answer many scoped questions. [Datadog template variables](https://docs.datadoghq.com/dashboards/template_variables/)
- Variables distinguish filter semantics from group-by semantics and provide defaults and
  available values, useful for explicit scope such as repository, stage, runner, or owner.
  [Datadog template variables](https://docs.datadoghq.com/dashboards/template_variables/)
- Datadog's documented dashboard widgets include timeseries, toplists, tables, query values,
  event streams, service maps, and status summaries; density comes from choosing a representation
  suited to the question, not charting every field. [Datadog widget index](https://docs.datadoghq.com/dashboards/widgets/)
- Dashboard time controls support fixed and relative windows and live refresh, making time scope
  part of the visible analytical state. [Datadog dashboard guide](https://docs.datadoghq.com/dashboards/guide/)

**Factory lesson:** the fleet surface needs an always-visible scope and freshness contract.
Counts without time window, denominator, or last update are decoration rather than operations data.

### Temporal UI: durable execution as history plus current state
- Temporal's UI changelog describes simplified workflow views, live event feeds, direct child
  workflow access, improved performance, and a timeline built to handle large event histories.
  [Temporal UI changelog](https://temporal.io/changelog/product-area/ui)
- The UI offers event-history downloads and has iterated specifically on clarity and flexibility
  of history inspection, reinforcing that raw history is evidence worth preserving alongside
  summarized state. [Temporal UI changelog](https://temporal.io/changelog/product-area/ui)
- Temporal separates workflow executions from child executions and task queues; the useful model
  is an execution hierarchy that operators can traverse rather than a flat log stream.
  [Temporal Web UI repository](https://github.com/temporalio/ui)
- Principal attribution was added to improve accountability and traceability for executions,
  showing that “who initiated this?” belongs in execution history. [Temporal UI changelog](https://temporal.io/changelog/product-area/ui)

**Factory lesson:** preserve append-only run events as the audit substrate, but render a semantic
timeline with stage boundaries, retries, gates, child agents, and evidence. Raw JSON is an escape
hatch, not the primary experience.

### GitHub Actions: run → job → step → line
- GitHub's execution model is explicitly hierarchical: a workflow run contains jobs, jobs may run
  sequentially or in parallel, and each job contains ordered steps. [Understanding GitHub Actions](https://docs.github.com/en/actions/get-started/understand-github-actions)
- The run page offers a summary, jobs or a visualization graph, then expandable step logs; failed
  steps expand automatically, taking the operator to the narrowest useful failure boundary.
  [Using workflow run logs](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs)
- Step duration is visible, logs are searchable, and individual log lines have permalinks for
  team sharing. [Using workflow run logs](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs)
- Completed outcomes distinguish success, failure, canceled, and neutral rather than reducing
  everything to green/red. [Using workflow run logs](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs)
- Recovery actions match scope: operators can rerun a full workflow, all failed jobs, or a
  specific job, and can cancel an in-progress run. [Managing workflow runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs)
- Artifacts persist outputs such as test results, failures, screenshots, logs, and binaries after
  execution ends. [GitHub workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)

**Factory lesson:** show the fleet compactly, but make run detail structurally deep. The first
failed stage and its evidence should be one click away; remediation should target the smallest
safe execution boundary.

## 2. Incident response and equal-team coordination

### Ownership is state, not avatar decoration
- PagerDuty's lifecycle is Triggered → Acknowledged → Resolved; acknowledgement means someone is
  working the incident, claims ownership, and halts escalation. [PagerDuty incidents](https://support.pagerduty.com/main/docs/incidents)
- If nobody acknowledges within the timeout, assignment escalates; if an acknowledged incident
  exceeds its acknowledgement timeout it can retrigger and resume escalation. [PagerDuty incidents](https://support.pagerduty.com/main/docs/incidents)
- Reassignment to an escalation level or policy preserves automatic cycling until somebody
  acknowledges, whereas assigning only an individual removes that fallback. [PagerDuty reassignment](https://support.pagerduty.com/main/docs/reassign-incidents)
- PagerDuty warns that notifying many people at once risks confusion about ownership, which is
  exactly the collision a small equal-role factory team must avoid. [PagerDuty escalation policies](https://support.pagerduty.com/main/docs/escalation-policies)
- Added responders have explicit Pending, Joined, and Declined states, and those transitions are
  also recorded in the incident timeline. [PagerDuty responders](https://support.pagerduty.com/main/docs/add-responders)

**Factory lesson:** “claimed by” must be a visible, atomic run/gate state with age and release;
presence dots alone do not prevent two operators from approving the same gate.

### Lightweight task claiming beats role bureaucracy
- incident.io exposes an “I'm on it!” action to the whole incident channel, enabling fast
  self-assignment without requiring a command structure. [incident.io task tracking](https://docs.incident.io/incidents/task-tracking)
- Its action overview lists action status and owners, while every interaction is added to the
  incident timeline. [incident.io task tracking](https://docs.incident.io/incidents/task-tracking)
- Actions can be assigned, reassigned, unassigned, completed, or converted to post-incident
  follow-ups, separating urgent coordination from durable backlog work. [incident.io actions](https://docs.incident.io/incidents/actions)
- Incident status updates combine optional severity/status changes, a short narrative, and a
  reminder for the next update; the update is posted into the incident's shared conversation.
  [incident.io status updates](https://help.incident.io/articles/3970452937-sharing-status-updates-with-your-team)

**Factory lesson:** equal roles do not imply anonymous action. Offer “I’m on it,” explicit handoff,
and “decided by” records; avoid importing incident-command hierarchy unless the factory later
demonstrates a need for it.

### Timelines are the coordination backbone
- PagerDuty mobile detail combines impacted service, responders, latest status, subscribers, an
  abridged timeline, alerts, and related past incidents, with the full timeline one level deeper.
  [PagerDuty mobile app](https://support.pagerduty.com/main/docs/mobile-app)
- PagerDuty records snooze actions in the incident log and returns an unresolved item to triggered
  state when its timer expires, so temporary suppression remains visible and bounded.
  [Editing PagerDuty incidents](https://support.pagerduty.com/main/docs/edit-incidents)
- incident.io can publish current incidents and subsequent updates to an internal status page,
  creating a calmer audience-specific read model from the same incident state.
  [incident.io internal status pages](https://help.incident.io/articles/8672254556-how-to-publish-an-incident-to-your-internal-status-page)

**Factory lesson:** store one authoritative event history, then present operator detail, team
activity, and calm stakeholder summary as different read models. Every gate decision, steer,
takeover, retry, and claim should name actor and time.

## 3. AI-agent fleet supervision

### Sessions need fleet-level attention routing
- Devin's organization session API exposes title, status, created/updated times, requesting user,
  tags, snapshot, playbook, and pull request, which are the minimum useful fields for a fleet row.
  [Devin list sessions API](https://docs.devin.ai/api-reference/v1/sessions/list-sessions)
- Devin redesigned its sessions list around inline PR previews, message snippets, status indicators,
  sorting, and unread updates; later release notes add pinned/reordered sub-agent sessions and
  sidebar-visible approval state. [Devin release notes](https://docs.devin.ai/release-notes/overview)
- Devin session tools expose Progress, Shell, IDE, and Browser and explicitly support monitoring,
  real-time review, interaction, and human takeover. [Devin session tools](https://docs.devin.ai/work-with-devin/devin-session-tools)
- Archiving an active Devin session warns that the active session and child sessions will sleep,
  making hidden consequences visible before mutation. [Devin release notes](https://docs.devin.ai/release-notes/overview)

**Factory lesson:** fleet rows should answer task, repository, stage, current activity, updated age,
initiator, attention reason, output/PR, and child-run state. “Running” alone is not operationally
useful.

### Trace views should change with the operator's question
- LangSmith separates Threads, Traces, and Runs, and keeps surrounding thread context available
  while opening an individual row in a side panel. [LangSmith trace views](https://docs.langchain.com/langsmith/view-traces)
- Its Messages view supports scanning model output, reasoning, tools, results, and subagents;
  Turns gives a structural overview; Details shows inputs, outputs, timing, tokens, errors, metadata,
  and child runs. [LangSmith trace views](https://docs.langchain.com/langsmith/view-traces)
- Parallel tool calls collapse into a grouped row, thought blocks are collapsed by default, and
  nested subagent activity opens in place, techniques that preserve density without flattening
  execution structure. [LangSmith trace views](https://docs.langchain.com/langsmith/view-traces)
- LangSmith's data model distinguishes project, trace, run/span, and thread and enriches these with
  feedback, tags, and metadata. [LangSmith observability concepts](https://docs.langchain.com/langsmith/observability-concepts)
- Automation can route traces matching filters or samples into annotation queues, datasets,
  webhooks, evaluation, alerts, or extended retention, and provides execution logs for the rules.
  [LangSmith automation rules](https://docs.langchain.com/langsmith/rules)

**Factory lesson:** use an attention router rather than expecting people to watch all traces.
Default to semantic progress, offer a structured turn/stage view, and reserve full tool/event detail
for diagnosis.

### Human approvals belong at consequential boundaries
- OpenAI's Operator guidance says significant actions such as submitting an order or sending an
  email require user confirmation. [Introducing Operator](https://openai.com/index/introducing-operator/)
- OpenAI's API supports tool approval policies of always, never, or filtered by tool/read-only
  properties, and can attach workflow name, group ID, and metadata to a trace for dashboard
  filtering and grouping. [OpenAI Realtime API reference](https://platform.openai.com/docs/api-reference/realtime)
- Anthropic's Claude Code CLI exposes allowed/disallowed tools, permission modes, turn limits,
  streaming output, verbose turns, and resumable session IDs. [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- Claude Code's security model defaults to bounded permissions, asks before consequential tools,
  and supports approval reuse to reduce prompt fatigue. [Claude Code security](https://docs.anthropic.com/en/docs/claude-code/security)
- Braintrust's first-party product description combines trace/tool inspection, search, latency,
  cost, quality, custom views, annotation, human scoring, and release quality gates.
  [Braintrust observability](https://www.braintrust.dev/)

**Factory lesson:** approvals should state requested action, why now, evidence, blast radius,
proposed diff/output, and expiry. Repeated low-risk prompts create approval fatigue; permissions
should be bounded by capability and scope, not blanket trust.

### What is product fashion vs operational function
- Live terminal streaming is useful during focused diagnosis, but the fleet default should be a
  summarized state plus freshness; Devin's Progress/IDE/Shell separation and LangSmith's layered
  views both avoid making raw output the only interface. [Devin session tools](https://docs.devin.ai/work-with-devin/devin-session-tools) [LangSmith trace views](https://docs.langchain.com/langsmith/view-traces)
- Animated agent avatars, glowing topology maps, and faux-terminal decoration have no operational
  value unless they encode ownership, dependency, current action, or abnormal state; ISA defines
  an alarm by the need for operator response. [ISA alarm definition](https://www.isa.org/intech-home/2017/january-february/departments/isa-certified-automation-professional-cap-program)
- Dark mode is a preference, not a control-room strategy; Temporal explicitly ships Night Mode,
  while high-performance HMI guidance focuses on salience and alarm distinction.
  [Temporal UI changelog](https://temporal.io/changelog/product-area/ui) [ISA high-performance HMI overview](https://www.isa.org/getmedia/06130a38-f7af-4b35-8c9c-2c34f25c1977/The-High-Performance-HMI-Overview-v2-01.pdf)

## 4. Mission control and industrial HMI principles

### Mission control is organized responsibility plus shared context
- NASA describes Mission Control as a nerve center where flight controllers monitor different
  mission aspects at individual consoles while large shared screens show common mission context.
  [NASA Houston Mission Control history](https://www.nasa.gov/history/building-on-a-mission-the-houston-mission-control-center/)
- NASA's historical account separates mission operations rooms from offices and conference rooms,
  evidence that active control and deliberative/support work are different spatial and cognitive
  modes. [NASA Houston Mission Control history](https://www.nasa.gov/history/building-on-a-mission-the-houston-mission-control-center/)
- NASA technical work on modern mission-control displays explicitly calls out color perception,
  memory load, and cognitive processing abilities as design factors. [NASA TM-100451](https://ntrs.nasa.gov/citations/19900012897)
- Historic Mission Control paired role-specific consoles with dominant situational-awareness
  displays; its lesson is shared orientation plus specialized workstations, not retro CRT styling.
  [NASA Mission Control restoration](https://www.nasa.gov/news-release/see-nasas-super-guppy-land-deliver-restored-historic-mission-control-consoles/)

**Factory lesson:** the home screen is the shared situation display; run detail is the role-neutral
operator console. Borrow the division of cognitive purpose, not aerospace ornament.

### ISA-101: consistency is infrastructure
- ISA-101's scope includes menu hierarchy, navigation conventions, graphics and color, dynamic
  elements, alarming, security/e-signatures, historical databases, popups, help, and alarm workflows.
  [ISA-101 committee](https://www.isa.org/standards-and-publications/isa-standards/isa-standards-committees/isa101)
- ISA's high-performance HMI overview recommends redundant alarm coding by priority so alarms
  stand out from normal process graphics. [ISA high-performance HMI overview](https://www.isa.org/getmedia/06130a38-f7af-4b35-8c9c-2c34f25c1977/The-High-Performance-HMI-Overview-v2-01.pdf)
- The practical design deduction is a quiet neutral field for normal operation, sparing use of
  saturated color for abnormal actionable state, and a second cue such as icon/shape/text so color
  is never the only carrier. [ISA high-performance HMI overview](https://www.isa.org/getmedia/06130a38-f7af-4b35-8c9c-2c34f25c1977/The-High-Performance-HMI-Overview-v2-01.pdf)

**Factory lesson:** gray does not itself make an HMI high-performance. The function is contrast
budget: normal state recedes; actionable deviation is rare, redundant, and unmistakable.

### ISA-18.2: an alarm must demand action
- ISA defines an alarm as an audible or visible indication of an abnormal condition requiring an
  operator response; a condition requiring no action is an event, not an alarm.
  [ISA alarm definition](https://www.isa.org/intech-home/2017/january-february/departments/isa-certified-automation-professional-cap-program)
- ISA-18.2 covers a lifecycle from philosophy and identification through rationalization, design,
  implementation, operation, maintenance, monitoring, change management, and audit.
  [ISA-18 series](https://www.isa.org/standards-and-publications/isa-standards/isa-18-series-of-standards)
- ISA says structured prioritization and monitoring reduce alarm overload and keep alarms meaningful
  and actionable. [ISA-18 series](https://www.isa.org/standards-and-publications/isa-standards/isa-18-series-of-standards)
- Alarm performance can deteriorate as process conditions change, so ongoing measurement, audit,
  and management of change matter as much as initial design. [ISA alarm lifecycle](https://www.isa.org/intech-home/2018/march-april/features/alarm-management-life-cycle)

**Factory lesson:** “needs human” is an alarm class; informational activity is an event. Every
attention item needs cause, consequence, expected response, priority, owner, age, and clear/reset
conditions. Do not paint every failure red forever.

### Endsley: perceive, comprehend, project
- Endsley's three-level model defines situation awareness as perception of relevant elements,
  comprehension of their meaning, and projection of likely future state.
  [Endsley, *Toward a Theory of Situation Awareness in Dynamic Systems*](https://doi.org/10.1518/001872095779049543)
- For this console, Level 1 is “what is running/waiting/failing?”, Level 2 is “why and who owns it?”,
  and Level 3 is “what will miss a gate, timeout, or capacity bound next?”; this mapping is a design
  deduction from the model. [Endsley paper](https://doi.org/10.1518/001872095779049543)
- A fleet screen containing only counts and colored states supports perception but not necessarily
  comprehension or projection; trend, age, dependency, and forecast cues are required by the
  three-level framing. [Endsley paper](https://doi.org/10.1518/001872095779049543)

## Patterns shortlist for this factory console
1. **Attention-first home:** show actionable gates, failures, stalls, and expiring claims before healthy throughput; alarms should correspond to required response. [ISA alarm definition](https://www.isa.org/intech-home/2017/january-february/departments/isa-certified-automation-professional-cap-program)
2. **Fleet table as the default dense view:** task, repo, stage, current action, owner, age, updated time, and output link make autonomous sessions scannable. [Devin list sessions API](https://docs.devin.ai/api-reference/v1/sessions/list-sessions)
3. **Three-layer drill-down:** fleet → semantic stage/turn timeline → raw tool/log evidence follows proven run/job/step and thread/run patterns. [GitHub workflow logs](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs) [LangSmith trace views](https://docs.langchain.com/langsmith/view-traces)
4. **Atomic “I’m on it” claim:** claiming changes visible ownership and prevents duplicate gate work among equals. [incident.io task tracking](https://docs.incident.io/incidents/task-tracking)
5. **Actor on every consequential event:** gate decisions, steering, takeover, retry, and cancellation record “decided by” plus exact time. [Vercel activity log](https://vercel.com/docs/activity-log)
6. **Small, explicit status taxonomy:** separate running, waiting, needs-human, claimed, failed, canceled, and completed; do not overload one red/green field. [GitHub workflow logs](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs)
7. **Freshness as data:** show last event age, connection/poll state, and a controlled “new events” affordance so live updates do not steal reading position. [Vercel runtime logs](https://vercel.com/docs/logs/runtime)
8. **Context-sensitive command palette:** one action grammar shared by buttons, menus, keyboard, and commands supports discovery and speed. [Linear conceptual model](https://linear.app/docs/conceptual-model)
9. **Saved, shareable operational views:** team presets such as “unclaimed gates,” “stalled >10m,” and “my active runs” prevent dashboard proliferation. [Linear custom views](https://linear.app/docs/custom-views)
10. **Alarm color budget:** use neutral surfaces for normal work and saturated, redundant cues only for abnormal actionable conditions. [ISA high-performance HMI overview](https://www.isa.org/getmedia/06130a38-f7af-4b35-8c9c-2c34f25c1977/The-High-Performance-HMI-Overview-v2-01.pdf)
11. **Approval evidence card:** show requested action, reason, diff/output, test evidence, blast radius, requester, and expiry at the irreversible boundary. [Introducing Operator](https://openai.com/index/introducing-operator/)
12. **Scoped recovery:** retry the failed stage when safe, rerun the whole pipeline only when necessary, and make cancellation explicit. [Managing GitHub workflow runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs)
13. **Shared situation plus focused detail:** home is the team's common operational picture; detail is an uninterrupted operator workstation. [NASA Houston Mission Control history](https://www.nasa.gov/history/building-on-a-mission-the-houston-mission-control-center/)
14. **Perceive → comprehend → project:** show present state, causal/ownership context, and impending timeout/capacity risk in that order. [Endsley paper](https://doi.org/10.1518/001872095779049543)
15. **Append-only semantic timeline:** preserve raw events, but group them into stages, retries, gates, child agents, human actions, and evidence with deep links. [Temporal UI changelog](https://temporal.io/changelog/product-area/ui)

## Anti-patterns
- **Dashboard sprawl:** a new dashboard for every question creates conflicting truths; prefer a
  small surface set with variables, filters, saved views, and consistent drill-down.
  [Datadog template variables](https://docs.datadoghq.com/dashboards/template_variables/) [Linear custom views](https://linear.app/docs/custom-views)
- **Alarm flood:** treating every failure, retry, warning, or old error as equally urgent defeats
  prioritization and overloads operators. [ISA-18 series](https://www.isa.org/standards-and-publications/isa-standards/isa-18-series-of-standards)
- **Color-as-status-only:** color perception varies and alarms need redundant coding; always pair
  color with text, icon/shape, location, and explicit action. [NASA TM-100451](https://ntrs.nasa.gov/citations/19900012897) [ISA high-performance HMI overview](https://www.isa.org/getmedia/06130a38-f7af-4b35-8c9c-2c34f25c1977/The-High-Performance-HMI-Overview-v2-01.pdf)
- **Wall of live logs:** streaming output is evidence, not fleet IA; summarize progress and expose
  raw logs at the failed or selected stage. [GitHub workflow logs](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs)
- **Silent auto-refresh:** moving rows while someone reads causes lost place and action mistakes;
  expose freshness and let users incorporate new rows deliberately. [Vercel runtime logs](https://vercel.com/docs/logs/runtime)
- **Presence without claims:** showing who is online does not establish who owns a gate; use an
  atomic claim/acknowledge transition and record it. [PagerDuty incidents](https://support.pagerduty.com/main/docs/incidents)
- **Broadcast ownership:** notifying everyone can create ambiguity about who is responding; direct
  assignment or self-claim needs an escalation/release path. [PagerDuty escalation policies](https://support.pagerduty.com/main/docs/escalation-policies)
- **One giant “running” state:** autonomous work needs current stage, current action, last progress,
  child activity, and blocked/approval distinctions. [Devin release notes](https://docs.devin.ai/release-notes/overview)
- **Charts without scope:** a throughput or success number without time window, filters, denominator,
  and freshness cannot support a decision. [Datadog dashboard guide](https://docs.datadoghq.com/dashboards/guide/)
- **Decorative mission-control cosplay:** CRT fonts, radar sweeps, neon glows, and gratuitous maps
  increase visual load unless they encode shared context or actionable deviation. NASA's functional
  legacy is specialized responsibility plus shared situational displays. [NASA Houston Mission Control history](https://www.nasa.gov/history/building-on-a-mission-the-houston-mission-control-center/)
- **Irreversible action without evidence:** approvals that omit requested change, consequence, and
  supporting evidence force operators to approve blind. [Introducing Operator](https://openai.com/index/introducing-operator/)
- **Approval on every tool call:** indiscriminate prompts cause fatigue; separate read-only, bounded
  edits, and consequential external actions with scoped policies. [OpenAI Realtime API reference](https://platform.openai.com/docs/api-reference/realtime) [Claude Code security](https://docs.anthropic.com/en/docs/claude-code/security)
- **Raw event history as the product:** append-only evidence is essential, but operators need
  grouped stages, semantic summaries, and causal links before raw event payloads.
  [Temporal UI changelog](https://temporal.io/changelog/product-area/ui)
- **Metrics-only situational awareness:** present-state counts do not explain meaning or forecast
  what will require intervention next. [Endsley paper](https://doi.org/10.1518/001872095779049543)
