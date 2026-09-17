# Operator Dashboard — UI/UX Development Requirements v1.0

## 0. Status

Status: UI/UX development requirements
Readiness: Design-ready for MVP discovery and wireframing; implementation-ready only for the explicitly marked MVP scope
Source basis: Operator Dashboard PRD, current codebase constraints, and follow-up data-readiness answers
Primary UI model: Visual Agent Run Graph / Execution Map
Primary product unit: Agent Run
Primary user outcome: Find, understand, and debug agent execution without reading source code or stitching together backend systems manually

This document replaces the previous broad UI/UX draft with a stricter, graph-first requirements document.

Companion docs:

* [`specs/operator-viewer.md`](./specs/operator-viewer.md) — implementation spec for `apps/operator-viewer`.
* [`../operator-run-graph.md`](../operator-run-graph.md) — semantic data contract for Agent Run Graph.
* [`adr/0006-observability-and-deletion.md`](./adr/0006-observability-and-deletion.md) — compact operator event capture and deletion boundaries.

The previous draft was directionally correct, but too broad for dev handoff. It mixed MVP, later steps, possible future actions, and data-dependent features. This version separates:

* What is MVP
* What is later
* What is blocked by missing product/runtime data
* What must never be shown as fact unless the system actually captures it

The dashboard must be honest. It must not imply knowledge the system does not have.

---

# 0.5 Tech stack and design system

## 0.5.1 Committed stack

The operator dashboard is built as a **Vite + React + TypeScript single-page app**,
served by `runtime-host` (as today), with the following committed layers:

| Concern | Choice | Why |
| ------- | ------ | --- |
| Components / design system | **shadcn/ui** (Radix primitives + Tailwind CSS) | Accessibility, keyboard nav, and focus management come from Radix (directly satisfies §23); we own the component code (no lock-in); CSS-variable tokens make env/tenant/dark-mode theming trivial |
| Styling / theming | **Tailwind CSS** with a token layer (CSS variables) | One source of truth for color/space/typography; per-environment and dark-mode theming is a token swap |
| Routing + URL state | **TanStack Router** | Type-safe **search-param state** is the mechanism for §25 (URL preserves window/filters/sort/selected node/turn/tab) and §25.3 back behavior |
| Data fetching / cache | **TanStack Query** | Caching, background refetch, and the freshness/staleness model in §28.0 |
| Tables | **TanStack Table** (+ **TanStack Virtual**) | Headless, fits our data; sorting/filtering/column visibility/virtualization (§24) |
| Graph | **React Flow** | The Visual Agent Run Graph (§2); custom nodes/edges, deterministic layout, lazy expansion |
| Icons | a single icon set (e.g. Lucide) | Status icons are part of the non-color status requirement (§2.8, §23.1) |

This **replaces the current `apps/operator-viewer` scaffold** (Vite + plain CSS +
manual routing). The existing API client and types are reused; the UI is rebuilt
on this stack. No move to Next.js for MVP — auth is handled at the host/BFF layer
(see §7.4–7.5), keeping the SPA serving model intact.

## 0.5.2 Design tokens and status visual language

Status visuals are referenced in §2.8, §22.2, and §23.1 but must be defined **once**
as tokens and reused everywhere (graph node, table cell, badge, inspector). Each
status token defines:

```ts
type StatusToken = {
  id: 'running' | 'waiting' | 'stuck' | 'completed' | 'failed'
    | 'cancelled' | 'partial' | 'unknown';
  label: string;        // text label (never color-only)
  icon: IconName;       // distinct icon
  shape: 'solid' | 'dashed' | 'double'; // border/shape treatment
  colorLight: string;   // light-theme token
  colorDark: string;    // dark-theme token
  srLabel: string;      // screen-reader description
};
```

Attention status (§22.1) is a **separate** token set layered on top of runtime
status, never folded into the same color.

## 0.5.3 Dark mode, density, and theming

* **Dark mode is required**, not optional — ops users expect it. Light/dark are
  token swaps; no component hardcodes color.
* **Compact density by default.** This is a data-dense investigation tool, not a
  marketing surface. Tables and inspectors default to compact spacing with an
  optional comfortable mode.
* **Environment theming (§7.2):** production vs non-production is expressed through
  a distinct token set / accent so the environment is unmistakable on every page.
* **Tenant context (§7.3):** visible and, where useful, color-accented — but
  tenant accent must never be confused with status or environment color.

## 0.5.4 Display conventions

* **Time:** show absolute UTC on hover/detail and relative ("18m ago") inline;
  pick one default and state the timezone explicitly.
* **IDs/hashes/tokens/keys:** monospace, middle-ellipsis, copy affordance (§24.2).
* **Numbers:** tokens, cost, latency use consistent units and locale formatting;
  missing values use the §4.2 vocabulary, never `0`.

---

# 1. Product thesis

The Operator Dashboard is a semantic execution viewer for agent runs.

It is not:

* a workflow builder;
* a generic DevOps dashboard;
* a replacement for Hatchet;
* a raw prompt/response telemetry viewer;
* a general log explorer;
* an agent authoring tool.

It is the main interface for answering:

1. Which agent run needs attention?
2. What happened inside that run?
3. Which agent node caused the problem?
4. Which turn was the first wrong turn?
5. Which LLM, memory, tool, child, or transition event explains the behavior?
6. Where should the user go next if full raw detail is needed?

The dashboard should make complex multi-agent execution visually understandable.

The central UX principle:

> Show the execution story first. Show raw detail only when the user asks for it.

---

# 2. Primary UI concept: Visual Agent Run Graph

## 2.1 Core decision

The primary Run Detail surface must be a visual graph of the actual agent execution.

This graph is the product’s central UI, not a secondary debug widget.

Recommended implementation model: React Flow-style interactive canvas with custom nodes, custom edges, automatic layout, lazy expansion, and a selected-node inspector.

The graph must feel like an **execution map**, not a workflow editor.

The user must understand:

> This is what happened.

Not:

> This is where I build or modify a workflow.

## 2.2 Graph semantics

### Nodes

One graph node represents one **Agent Run**.

A node must not represent:

* a Hatchet workflow;
* a database row;
* an internal `aplret.segment`;
* a raw event;
* an LLM call;
* a tool call;
* an APLRET stage.

Those can appear inside inspectors or detail panels, but not as primary graph nodes.

### Edges

One graph edge represents a parent-child delegation relationship between agent runs.

The edge means:

> This agent delegated work to this child agent.

The graph should not represent every internal effect as an edge by default. Tool calls, LLM calls, memory operations, and transitions belong inside the selected node/turn details.

## 2.3 Graph layout

The default layout must be deterministic.

Preferred MVP layout:

* left-to-right tree layout; or
* top-to-bottom tree layout.

The layout must support recursive agent structures.

Avoid force-directed layouts for MVP. They can look visually interesting but are weaker for debugging because node position changes can reduce user orientation.

## 2.4 Graph is read-only

The graph must not expose builder-like affordances.

Forbidden in MVP:

* dragging nodes to edit execution;
* creating edges;
* deleting nodes;
* plus buttons for adding nodes;
* canvas editing toolbar;
* node resize handles;
* visual language that looks like an authoring tool.

Allowed:

* pan;
* zoom;
* select node;
* expand/collapse node;
* open node inspector;
* jump to leaf failure;
* fit to graph;
* fit to failure path;
* copy link to selected node;
* open deep links.

## 2.5 Default graph behavior

When opening a Run Detail page:

### If the run failed

The graph must:

1. Render the root agent node.
2. Auto-expand the known failure path.
3. Auto-select the deepest known failed node.
4. Highlight the path from root to deepest known failure.
5. Keep healthy sibling branches collapsed by default.
6. Open the right-side node inspector on the `Summary` tab.
7. Show a plain-language failure summary above or beside the graph.

### If the run is waiting

The graph must:

1. Render the root agent node.
2. Auto-expand the path to the currently waiting agent, if known.
3. Auto-select the waiting node.
4. Show the await type clearly.
5. Distinguish normal waiting from overdue/stuck waiting.

### If the run completed

The graph must:

1. Render the root agent node.
2. Collapse deep healthy branches by default.
3. Select the root node.
4. Show total duration, total cost, turn count, LLM count, and memory activity.

### If data is partial

The graph must:

1. Render what is known.
2. Show a `Partial data` warning.
3. Mark missing children/turns/traces clearly.
4. Avoid pretending the execution story is complete.

## 2.6 Large graph behavior

The graph must scale to deep recursive trees.

MVP requirements:

* Lazy-load children.
* Collapse healthy branches by default.
* Render only visible nodes.
* Show child count on collapsed nodes.
* Provide `Expand failed path`.
* Provide `Expand all failed`.
* Provide `Collapse healthy`.
* Provide `Fit to failure path`.
* Warn before expanding very large subtrees.

The UI must not freeze when a run has hundreds or thousands of descendants.

## 2.7 Graph node content

Each node must have compact and expanded display modes.

### Compact node

Required fields:

* Agent name
* Status label
* Status icon
* Duration or age
* Failure/waiting marker, if relevant

### Standard node

Required fields:

* Agent name
* Status
* Duration or age
* Turn count
* LLM call count
* Cost indicator, if available
* Child count
* Failure/waiting marker

### Detailed node

Optional, depending on zoom level or expanded state:

* Input preview, only if sanitized
* Output preview, only if sanitized
* Await type
* Error summary
* Memory activity marker
* Contract failure marker
* Manifest drift marker, if available

## 2.8 Graph node status display

Status must not rely on color only.

Each node status must use:

* text label;
* icon;
* color;
* border or shape treatment;
* tooltip or accessible description.

Required statuses:

* Running
* Waiting
* Stuck
* Completed
* Failed
* Cancelled
* Partial data
* Unknown

The UI must distinguish:

* direct node failure;
* propagated parent failure;
* child failure;
* derived stuck state;
* missing data.

## 2.9 Failure propagation

The graph must make failure propagation visible.

Definitions:

* **Leaf failure**: deepest known failed agent node.
* **Propagated failure**: parent agent failed because a child failed.
* **Failure path**: path from root to deepest known failure.

Requirements:

* Leaf failure node has strongest error treatment.
* Parent nodes show propagated failure treatment.
* Failure path edge is visually emphasized.
* User can jump directly to deepest known failure.
* If multiple leaf failures exist, show count and allow cycling through them.
* If the system cannot determine the leaf, say so.

Example copy:

> Root run failed because `fetch-browser` failed with captcha challenge. The failure propagated through `fetch-page-router` to `process-case`.

If the leaf cause is unavailable:

> Root run failed, but the dashboard cannot determine the leaf failure from captured data.

---

# 3. MVP scope

## 3.1 MVP goal

The MVP must solve one core workflow:

> Find a specific run, understand its execution graph, locate the failing or waiting agent, inspect turns, and open full trace/backend detail if needed.

## 3.2 MVP includes

MVP must include:

1. Fleet list
2. Run Detail page
3. Visual Agent Run Graph
4. Node inspector
5. Turn timeline
6. Turn detail / APLRET cognition inspector
7. LLM call metadata
8. Memory operation metadata
9. Cost summary at run/node/turn/call level where captured
10. Hatchet deep links and copyable trace/span identifiers where references exist
11. Explicit missing-data states
12. URL-shareable investigation state
13. Safe preview behavior

## 3.3 MVP excludes

MVP must exclude or feature-flag:

* cancellation;
* retry;
* resume;
* memory invalidation;
* saved views;
* full FinOps analytics;
* historical cost medians if data window is not defined;
* customer/case grouping unless canonical business entity metadata exists;
* team ownership routing unless ownership data exists;
* product/domain owner simplified home page;
* cache hit/miss analytics unless read result is captured;
* raw input/output preview unless sanitized.

## 3.4 MVP success criterion

MVP is successful when an operator or developer can:

1. Open a failed run.
2. See the agent graph.
3. Identify the deepest known failure.
4. Open the failed agent node.
5. Inspect the turn timeline.
6. Find the first failed or abnormal turn.
7. See LLM/memory/cost metadata related to that turn.
8. Open Hatchet or correlate trace/span identifiers only if full raw detail is needed.

---

# 4. Data readiness gates

The UI must separate available, derived, missing, and unsafe data.

## 4.1 Data categories

Every displayed field belongs to one of four categories:

### Captured

The system explicitly stores this value.

Examples:

* agent ID;
* task ID;
* tenant ID;
* root task ID;
* parent/child relationships;
* run status;
* timestamps;
* LLM model;
* token usage;
* cost, where captured;
* memory operation keys;
* memory operation type;
* manifest hash.

### Derived

The dashboard calculates this from captured data.

Examples:

* stuck status;
* known descendant count;
* propagated failure path;
* cost concentration;
* graph depth;
* run age;
* visible subtree size.

Derived values must be labelled or explainable.

### Missing

The dashboard expected a value but it is not available.

Examples:

* missing trace link;
* missing cost capture;
* missing TurnTrace summary;
* missing business entity ID;
* missing memory hit/miss;
* missing ownership.

Missing data must be shown as missing, not as zero.

### Unsafe

The data exists but is not safe to show directly.

Examples:

* raw task input;
* raw task output;
* raw prompt;
* raw response;
* raw memory value;
* raw HTML/page content;
* large artifact payload.

Unsafe data must not be rendered inline.

## 4.2 Required display language

Use these terms consistently:

| UI term           | Meaning                                                   |
| ----------------- | --------------------------------------------------------- |
| Unknown           | The system cannot determine this value                    |
| Not captured      | The system did not capture this field                     |
| Hidden for safety | Data exists but is not safe to display inline             |
| Not applicable    | Field does not apply to this object/state                 |
| Partial data      | The dashboard cannot reconstruct the full execution story |
| Derived           | Calculated by the dashboard from captured fields          |

## 4.3 Blocked features

The following features are blocked until data support exists:

| Feature                          | Blocker                                    | MVP decision                            |
| -------------------------------- | ------------------------------------------ | --------------------------------------- |
| Reliable customer/case grouping  | No canonical business entity field         | Exclude from MVP or best-effort only    |
| Reliable cache hit/miss          | Memory read result not captured            | Show reads/writes only                  |
| Safe input/output preview        | Raw payloads not sanitized                 | Hide previews until sanitization exists |
| Cancellation                     | Runtime cancellation not fully implemented | Exclude or feature-flag                 |
| Team routing                     | No first-class agent ownership             | Exclude                                 |
| Valid historical outlier medians | Retention/capture window undefined         | Show only if valid                      |
| Exact child blast radius         | In-flight unrecorded children may exist    | Show known descendants only             |

---

# 5. Required data model conventions for better UX

These are not UI features, but they strongly affect UI quality.

## 5.1 Business entity identity

Current state:

* The framework has tenant/task/root/parent/child identity.
* There is no first-class customer/case/business field.
* Application-specific `caseId` may exist inside task input, but this is fragile.

Recommendation:

Add a standard metadata convention:

```ts
metadata.businessEntityId: string
metadata.businessEntityType?: string
metadata.businessEntityLabel?: string
```

Example:

```json
{
  "businessEntityId": "case-1",
  "businessEntityType": "case",
  "businessEntityLabel": "Case 1 / Italian source monitoring"
}
```

Until this exists, the UI must not make customer/case grouping a core MVP capability.

## 5.2 Memory read result

Current state:

* Memory events record operation type, keys, key count, and backend.
* They do not reliably say whether a read found a value.

Recommendation:

Add to memory read events:

```ts
found?: boolean
resultCount?: number
```

No raw memory value should be stored or displayed.

Until this exists, the UI must not display cache hit/miss as a fact.

## 5.3 Sanitized input/output preview

Current state:

* Input/output previews may contain raw task payloads.
* Raw previews are unsafe for production UI.

Recommendation:

Introduce a shared preview sanitizer.

Sanitizer must:

* truncate long strings;
* cap arrays;
* cap objects;
* hide secrets;
* hide obvious PII where possible;
* replace artifacts with metadata;
* replace raw HTML/page content with safe handles;
* preserve useful semantic labels.

Until this exists, UI must show:

> Preview hidden because payload is not sanitized.

## 5.4 Ownership convention

Current state:

* Agent Card provider organization may exist but is optional and weak.
* No first-class team/user ownership exists.

Recommendation:

Create one of:

* agent-to-team registry; or
* required ownership metadata in agent card; or
* external ownership mapping joined by dashboard.

Until this exists, UI must not route failures to owners as a first-class feature.

---

# 6. Information architecture

## 6.1 MVP navigation

MVP navigation should include:

1. Fleet
2. Run Detail
3. Cost summary inside run
4. Memory summary inside run
5. Settings / Diagnostics, if needed

Avoid too many top-level sections in MVP.

## 6.2 Later navigation

Later versions may add:

* Cost
* Memory
* Stuck / Waiting
* Agents
* Saved Views
* Ownership
* Health

## 6.3 Navigation principle

Start with investigation, not analytics.

The user journey is:

> Fleet → Run → Graph → Node → Turn → Trace

This is the core product path.

---

# 7. App shell

## 7.1 Required shell elements

The app shell must include:

* primary navigation;
* global time window;
* tenant indicator;
* environment indicator;
* global search;
* data freshness indicator;
* user/help area.

## 7.2 Environment safety

Production and non-production must be visually distinct.

The environment indicator must be visible on every page.

If destructive actions are later added, production must require extra visual confirmation.

## 7.3 Tenant safety

Tenant context must be visible enough to prevent cross-tenant confusion.

All queries and pages must be tenant-scoped.

If tenant is unknown or unavailable, the UI must not render run data.

## 7.4 Authentication and authorization (reserved)

Auth is not implemented in MVP, but the dashboard must be designed so it can be
added without re-architecture. Reserve the following now.

### Authentication boundary

* The dashboard assumes an authenticated session before any run data is fetched.
* The app shell must reserve a real user/identity area (not a placeholder),
  including sign-out and the current principal.
* Unauthenticated access must resolve to a sign-in state, never to empty run data.

### Authorization model

Reserve a minimal role model from day one, even if everyone is `admin` initially:

| Role | Can |
| ---- | --- |
| `viewer` | read fleet, runs, graph, turns, LLM/memory metadata, deep links |
| `operator` | everything `viewer` can, plus future intervention (cancel/retry/resume) |
| `admin` | everything, plus settings (thresholds, env config, ownership mapping) |

Rules:

* Read surfaces are gated by `viewer`.
* All future destructive actions (§19) must gate on `operator`/`admin`
  **and** be audit-logged (who, what run, when, reason).
* Production destructive actions (§7.2) require role **and** extra confirmation.

### Multi-tenant authorization

* A principal may be scoped to one or more tenants.
* Tenant selection in the UI must be constrained to the principal's allowed
  tenants; the UI must never offer or query a tenant the user cannot access.

## 7.5 Security boundary

These are hard requirements, independent of auth implementation timing.

* **Tenant is server-authoritative.** Today the runtime APIs accept tenant as a
  client header (`x-tenant-id`). This is acceptable only pre-auth. Once auth
  exists, tenant **must be derived from the authenticated session server-side**
  and the client header must be ignored for authorization. The UI must not rely
  on a client-supplied tenant for access control.
* **No raw payloads cross the boundary unsanitized.** Input/output/prompt/
  response/memory-value sanitization (§4.1 Unsafe, §17) must happen
  server-side before data reaches the browser, not in the client.
* **Deep links are not access grants.** Hatchet links may point to systems
  the user cannot access; the dashboard cannot pre-flight that authorization and
  must not imply it (see §18.3).
* **Operator actions are audited.** Any state-changing action (future) is logged
  with principal, tenant, target run, and timestamp.

---

# 8. Fleet page

## 8.1 Purpose

The Fleet page helps the user find which run to inspect.

It answers:

* Which runs exist in this time window?
* Which runs failed?
* Which runs are waiting?
* Which runs appear stuck?
* Which runs are expensive?
* Which agent is involved?
* Which run should I open?

## 8.2 MVP layout

Fleet page layout:

1. Header
2. Summary strip
3. Filter bar
4. Run table
5. Optional row preview drawer

## 8.3 Header

Header must show:

* title: `Fleet`
* selected time window;
* refresh status;
* data freshness;
* tenant;
* environment.

## 8.4 Summary strip

MVP summary cards:

* Total runs
* Failed
* Waiting
* Stuck
* Completed
* Cost captured
* Cost unavailable

Each card acts as a filter where possible.

Do not show customer/case summary in MVP unless `businessEntityId` exists.

## 8.5 Filters

MVP filters:

* time window;
* status;
* agent;
* task/root task ID;
* has failure;
* waiting type;
* stuck only;
* has LLM calls;
* has memory operations;
* has trace link;
* cost captured / cost missing.

Later filters:

* customer/case;
* owner/team;
* model;
* manifest hash;
* error category;
* cost outlier;
* memory hit/miss.

## 8.6 Run table columns

MVP columns:

| Column          | Requirement                       |
| --------------- | --------------------------------- |
| Status          | Label + icon + color + tooltip    |
| Agent           | Root agent name/ID                |
| Task            | Task ID/root task ID              |
| Started         | Timestamp                         |
| Age/duration    | Running age or completed duration |
| Current state   | Running/waiting/failed/completed  |
| Await type      | If waiting                        |
| Cost            | Value or `Not captured`           |
| LLM calls       | Count                             |
| Memory ops      | Count                             |
| Failure summary | Shortest safe summary             |
| Trace           | Available/unavailable             |
| Actions         | Open, copy link                   |

Do not include raw input/output preview by default until sanitized.

## 8.7 Row behavior

Clicking a row opens Run Detail.

Row secondary actions:

* copy run link;
* copy task ID;
* open trace, if available;
* open backend run, if available.

Opening and returning must preserve filters, sorting, and scroll position where feasible.

## 8.8 Fleet empty states

Required empty states:

* No runs in time window
* No runs match filters
* Data source unavailable
* Partial data loaded
* Tenant unavailable
* Cost data unavailable

Example copy:

> No failed runs match the current filters.

> Runs were found, but cost data was not captured for this time window.

---

# 9. Run Detail page

## 9.1 Purpose

The Run Detail page is the main investigation page.

It answers:

* What happened in this run?
* What is the execution topology?
* Where is the run now?
* Where did failure originate?
* What agent node should I inspect?
* Which turn should I inspect?

## 9.2 Layout

Run Detail layout:

1. Sticky run header
2. Investigation summary
3. Visual Agent Run Graph
4. Selected node inspector
5. Optional bottom panel for timeline/details on wide screens

Recommended desktop layout:

* graph center-left;
* inspector right;
* run header top;
* summary above graph;
* timeline inside inspector or bottom panel.

## 9.3 Sticky run header

Header must show:

* root agent;
* run status;
* task/root task ID;
* business entity, only if canonical metadata exists;
* started time;
* age/duration;
* total known cost;
* total LLM calls;
* total memory operations;
* trace availability;
* manifest hash;
* copy link action.

Do not show raw input/output preview in header unless sanitized.

## 9.4 Investigation summary

The summary must be short and evidence-based.

It should answer:

* current state;
* deepest known failure or waiting node;
* propagated path;
* cost availability;
* trace availability;
* missing data warnings.

Example failed summary:

> Failed in `fetch-browser`. The failure propagated through `fetch-page-router` to `process-case`. Full trace is available. Input/output previews are hidden because sanitized previews are not enabled.

Example waiting summary:

> Waiting for child agent `discover-listing-selectors` for 18 minutes. This is marked stuck because it exceeds the configured child-wait threshold.

Example partial summary:

> This run has partial data. The graph shows known agent nodes, but turn details were not captured for one child run.

## 9.5 Default selection behavior

When user opens Run Detail:

| Run state     | Default selected node                             |
| ------------- | ------------------------------------------------- |
| Failed        | Deepest known failed node                         |
| Waiting/stuck | Current waiting node                              |
| Completed     | Root node                                         |
| Running       | Active/current node if known, otherwise root      |
| Partial       | Most specific known abnormal node, otherwise root |

---

# 10. Node inspector

## 10.1 Purpose

The node inspector explains the selected Agent Run node.

It answers:

* What is this agent?
* Why is it important?
* What state is it in?
* What did it receive and return?
* Which turns happened?
* Which LLM/memory operations happened?
* Where can I inspect deeper?

## 10.2 Required tabs

MVP tabs:

1. Summary
2. Turns
3. LLM
4. Memory
5. Links

Later tabs:

* Events
* Raw
* Provenance
* Children
* Cost

## 10.3 Summary tab

Required fields:

* agent name;
* status;
* direct vs propagated failure;
* parent;
* children count;
* duration/age;
* turn count;
* LLM call count;
* memory op count;
* cost;
* await type;
* failure summary;
* sanitized input preview, if available;
* sanitized output preview, if available.

If previews are not sanitized:

> Input preview hidden because payload is not sanitized.

## 10.4 Turns tab

Shows turn timeline for the selected node.

The first abnormal turn should be easy to find.

Required controls:

* jump to first error;
* jump to first contract failure;
* jump to first Shield veto;
* jump to most expensive turn;
* jump to current waiting turn.

Disable controls when corresponding data does not exist.

## 10.5 LLM tab

Shows LLM calls for this node.

Required columns:

* turn;
* intent;
* provider;
* model;
* input tokens;
* output tokens;
* cost;
* latency;
* contract status;
* trace link.

No raw prompt or response inline.

## 10.6 Memory tab

Shows memory operations for this node.

Required columns:

* turn;
* operation;
* key/key prefix;
* key count;
* backend;
* timestamp;
* read result, only if captured;
* link to turn.

If hit/miss is not captured:

> Read result was not captured. The dashboard cannot confirm cache hit or miss.

## 10.7 Links tab

Shows:

* Hatchet run link, if available;
* copy trace/span IDs, if available;
* copy task ID;
* copy root task ID;
* copy agent ID;
* copy selected node link;
* manifest source/hash, if available.

External links open in a new tab.

---

# 11. Turn timeline

## 11.1 Purpose

The turn timeline helps users find the first wrong turn.

It answers:

* What happened in this agent, turn by turn?
* Where did the first abnormal event happen?
* Was this an LLM, memory, Shield, Policy, Execution, or Transition issue?

## 11.2 Timeline item content

Each turn item must show:

* turn number;
* status;
* intent;
* duration;
* cost, if captured;
* LLM call count;
* memory operation count;
* Shield outcome;
* transition outcome;
* await state;
* error marker;
* contract failure marker.

## 11.3 Abnormal markers

Required markers:

* Error
* Contract failed
* Shield veto
* Shield transform
* Await
* Stuck wait
* High cost
* High latency
* Memory write
* Mental state changed, if captured
* Retry/loop, if derivable

Markers must include text labels or accessible descriptions.

## 11.4 Loop recognition

If repeated turns have the same intent or correlation pattern, the UI may group them as a loop.

Example:

> `refine-selectors` repeated 4 times.

Only show loop grouping when derivable from captured fields.

Do not infer semantic cause without evidence.

---

# 12. Turn Detail / APLRET Cognition Inspector

## 12.1 Purpose

Turn Detail is the visual TurnTrace.

It must show the APLRET stages in order:

1. Attention
2. Perception
3. Learning
4. Policy
5. Shield
6. Execution
7. Transition

The UI should help the developer answer:

* What arrived?
* What was normalized?
* What changed?
* What was decided?
* Was the decision blocked or transformed?
* What was executed?
* Why did the turn continue, wait, or fail?

## 12.2 Stage display pattern

Each stage section must show:

* stage name;
* status;
* short summary;
* important captured fields;
* timing, if available;
* error/warning, if any;
* related LLM/memory/tool/child events;
* missing-data message, if not captured.

No stage should be a raw JSON dump by default.

## 12.3 Attention

Show:

* inbox summary;
* source;
* event kind;
* token/correlation ID, if available;
* whether expected event arrived, only if derivable.

## 12.4 Perception

Show:

* normalized perception summary;
* validation status;
* important extracted fields, if safe;
* validation errors.

## 12.5 Learning

Show:

* whether mental state changed, if captured;
* before/after hash, if available;
* memory writes;
* summary of derived fact, only if captured safely.

Do not show raw memory values.

## 12.6 Policy

Show:

* selected intent;
* policy status;
* available rationale only if captured;
* relevant context summary only if captured safely.

Do not invent explanation.

If no rationale exists:

> Policy rationale was not captured.

## 12.7 Shield

Show:

* outcome: pass, transform, defer, veto;
* reason/code, if captured;
* original action vs transformed action, if captured.

## 12.8 Execution

Show:

* action type;
* child/tool/LLM call summary;
* status;
* latency;
* cost, if LLM;
* result summary, if safe;
* error summary.

## 12.9 Transition

Show:

* next lifecycle state;
* await type;
* await token;
* resume token match, if captured;
* terminal status, if terminal.

---

# 13. LLM UI

## 13.1 Purpose

The LLM UI explains LLM behavior, cost, latency, and contract quality.

## 13.2 Required levels

LLM metadata must be available at:

* call level;
* turn level;
* node level;
* run level;
* fleet row level, as summary.

## 13.3 LLM call row

Required fields:

* agent;
* turn;
* intent;
* provider;
* model;
* input tokens;
* output tokens;
* total tokens;
* cost;
* latency;
* structured output contract status;
* trace link.

## 13.4 Contract status values

Allowed UI values:

* Contract passed
* Contract failed
* No contract
* Not captured
* Unknown

A contract failure should link to the related turn.

## 13.5 Prompt/response safety

Do not render raw prompts or responses inline.

Instead show:

* metadata;
* contract status;
* trace link;
* safe summary if captured.

If user needs full prompt/response:

> Use the trace/span IDs to correlate with application-level LLM telemetry.

---

# 14. Memory UI

## 14.1 Purpose

The Memory UI explains memory operations without exposing raw memory values.

It answers:

* What keys were read?
* What keys were written?
* Which agent/turn touched memory?
* Did memory activity correlate with behavior?

It must not claim cache hit/miss unless read result is captured.

## 14.2 Memory operation row

Required fields:

* operation: read/write/delete;
* key/key prefix;
* key count;
* backend;
* agent;
* turn;
* timestamp;
* read result, only if captured;
* link to turn.

## 14.3 Hit/miss language

If `found/resultCount` exists:

* show `Hit`;
* show `Miss`;
* show `N results`.

If it does not exist:

> Read result not captured.

Do not infer hit/miss from read/write sequence in MVP.

## 14.4 Raw values

Raw memory values must not be displayed inline.

If values are inspectable elsewhere, provide safe deep link only if access control exists.

---

# 15. Cost UI

## 15.1 MVP cost scope

MVP cost is investigation-level, not full FinOps analytics.

Required MVP cost views:

* total known run cost;
* node cost;
* turn cost;
* LLM call cost;
* cost missing state;
* most expensive node/turn within a run, if captured.

## 15.2 Deferred cost scope

Later versions may include:

* weekly/monthly trends;
* cost by customer/case;
* cost by owner/team;
* cost outlier detection;
* median comparison;
* cost regression detection;
* budget alerts.

Only implement these after retention/capture windows are defined.

## 15.3 Cost comparison safety

If comparing cost to historical median, the UI must show:

* comparison window;
* sample size;
* whether missing older usage data may bias comparison.

If the sample is invalid:

> Historical comparison unavailable because usage capture is incomplete for this window.

---

# 16. Stuck / Waiting UX

## 16.1 Concept

Waiting is a normal runtime state.

Stuck is a dashboard-derived attention state.

The UI must not treat all waiting runs as broken.

## 16.2 Await types

Supported await categories:

* await_input;
* await_tool;
* await_child;
* unknown await.

## 16.3 Stuck derivation

A run is stuck when:

```text
now - updatedAt > configured threshold for await type / agent
```

This is a dashboard-derived signal.

The UI must expose:

* wait duration;
* threshold used;
* await type;
* whether threshold is global, per-await-type, or per-agent.

## 16.4 MVP behavior

MVP can show stuck status if thresholds are available.

If thresholds are not configured:

* show `Waiting`;
* do not show `Stuck`;
* optionally show raw waiting duration.

---

# 17. Input/output preview rules

## 17.1 Default rule

Do not render raw input/output payloads.

## 17.2 Sanitized previews

A preview can be shown only if it has passed a sanitizer.

The preview must:

* be truncated;
* remove or mask secrets;
* reduce large objects;
* reduce arrays;
* replace artifacts with metadata;
* avoid raw HTML/page bodies;
* avoid raw prompts/responses;
* avoid raw memory values.

## 17.3 Preview states

Allowed states:

* Preview available
* Preview hidden for safety
* Preview not captured
* Preview too large
* Preview unavailable

Example copy:

> Preview hidden because this payload has not been sanitized.

---

# 18. Deep links

## 18.1 Purpose

Deep links are escape hatches for full raw detail.

## 18.2 Link behavior

Hatchet links must open in a new tab.

The dashboard should not embed the full Hatchet UI in MVP.

## 18.3 Link states

Required states:

* Available
* Not captured
* Unavailable
* User lacks access, if detectable

No broken external link should be rendered as if valid.

---

# 19. Intervention UX

## 19.1 MVP decision

Intervention is not MVP.

Do not include cancel/retry/resume in the default MVP unless runtime support is implemented and verified.

## 19.2 Future cancel UX

When cancellation is available, the UI must treat it as best-effort unless runtime guarantees stronger semantics.

Cancel confirmation must show:

* run ID;
* root agent;
* current status;
* known descendant count;
* note that descendant count is based on currently recorded graph;
* expected cancellation behavior;
* warning that in-flight effects may finish before cancellation is observed;
* final destructive confirmation.

Use copy:

> This will request cancellation for this run and its known descendants. Some in-flight effects may complete before cancellation is observed.

Do not say:

> This will immediately stop everything.

## 19.3 Cancellation states

Future UI states:

* Cancel requested
* Cancelling
* Cancelled
* Cancel failed
* Partial/unknown cancellation

---

# 20. Product/domain owner lens

## 20.1 MVP decision

Do not create a separate product-owner landing page in MVP.

## 20.2 Later recommendation

Later, add a simplified lens using the same underlying data.

Default for product/domain owner:

* health by business entity;
* success rate;
* cost per case;
* failing agents;
* degraded sites;
* trend over time.

This requires canonical business entity identity and quality signals.

Until those exist, this lens should not be presented as reliable.

---

# 21. Ownership / routing

## 21.1 MVP decision

Do not show owner/team routing in MVP unless ownership data is reliable.

## 21.2 Later requirement

When ownership exists, show:

* owner/team on Fleet row;
* owner/team on node inspector;
* route/escalate action;
* owner filter.

Ownership source must be explicit.

Possible sources:

* agent card metadata;
* agent-to-team registry;
* external service catalog.

---

# 22. Status taxonomy

## 22.1 Runtime status vs attention status

The UI must separate runtime status from dashboard attention.

### Runtime status

What the runtime says:

* running;
* waiting;
* completed;
* failed;
* cancelled;
* unknown.

### Attention status

What the dashboard wants the user to notice:

* normal;
* warning;
* critical;
* partial data;
* unsafe preview hidden;
* missing optional data.

Example:

A completed run can have warning attention if it was extremely expensive.

A waiting run can be normal if it is waiting for user input within expected threshold.

## 22.2 Required status display model

Each status must define:

* label;
* icon;
* color;
* border/shape;
* tooltip;
* table representation;
* graph node representation;
* screen-reader label.

---

# 23. Accessibility

## 23.1 Non-color status

All important state must be conveyed by more than color.

For example:

* failed = red + error icon + `Failed` label;
* waiting = blue/neutral + clock icon + `Waiting for child`;
* stuck = warning icon + `Stuck` label + wait duration;
* partial data = dashed border + `Partial data` label.

## 23.2 Keyboard navigation

MVP keyboard requirements:

* focus global search;
* move through table rows;
* open selected run;
* move between graph nodes;
* expand/collapse selected graph node;
* open node inspector tabs;
* close drawers/modals;
* copy selected ID/link.

## 23.3 Screen reader requirements

Required:

* graph node accessible name;
* graph node status;
* expanded/collapsed state;
* selected node state;
* table headers;
* modal labels;
* icon labels;
* loading announcements;
* error announcements.

## 23.4 Contrast

Text, controls, focus rings, and important non-text indicators must meet accessibility contrast targets.

---

# 24. Tables

## 24.1 Required table behavior

Major tables must support:

* sorting;
* filtering;
* copy cell value;
* column visibility where useful;
* loading state;
* empty state;
* error state;
* pagination or virtualization;
* keyboard navigation;
* sticky header.

## 24.2 Cell display rules

Use:

* monospaced font for IDs, hashes, tokens, and keys;
* middle ellipsis for long IDs;
* copy buttons for IDs/tokens/keys;
* tooltip or expanded view for truncated safe content;
* explicit missing-value labels.

Avoid blank cells.

---

# 25. URL and shareability

## 25.1 URL state

The URL must preserve:

* time window;
* filters;
* sort;
* selected run;
* selected graph node;
* selected turn;
* active inspector tab.

## 25.2 Shareable links

A user must be able to share a link to:

* filtered Fleet view;
* specific run;
* specific agent node inside run;
* specific turn;
* specific LLM/memory detail where feasible.

## 25.3 Back behavior

Browser back must preserve:

* Fleet filters;
* Fleet scroll position where feasible;
* selected graph node;
* selected inspector tab;
* selected turn.

---

# 26. Responsive design

## 26.1 Primary target

Primary target is desktop.

MVP should optimize for:

* 1440px and above;
* 1024px minimum usable width.

## 26.2 Desktop layout

Desktop should support:

* left navigation;
* central graph;
* right inspector;
* sticky run header;
* wide tables;
* keyboard shortcuts.

## 26.3 Small screens

Small screens should:

* collapse navigation;
* move inspector into drawer;
* stack graph and details;
* hide non-critical table columns;
* preserve investigation capability.

Mobile is not primary for MVP.

---

# 27. Component inventory for MVP

MVP components:

1. App shell
2. Environment/tenant indicator
3. Time window selector
4. Global search
5. Filter bar
6. Filter chips
7. Summary cards
8. Status badge
9. Run table
10. Visual Agent Run Graph
11. Graph node
12. Graph edge
13. Graph controls
14. Node inspector
15. Inspector tabs
16. Turn timeline
17. Turn item
18. APLRET stage stepper
19. LLM call table
20. Memory operation table
21. Deep-link button
22. Copy button
23. Missing-data notice
24. Unsafe-preview notice
25. Partial-data warning
26. Loading skeleton
27. Empty state
28. Panel-level error state
29. Confirmation modal, later only
30. Keyboard shortcut help, later or MVP if shortcuts included

Each component must define:

* props/data contract;
* loading state;
* empty state;
* error state;
* disabled state;
* accessibility behavior;
* responsive behavior.

---

# 28. API implications

The UI should not assemble the execution story through many low-level backend calls.

MVP APIs should support UI-shaped resources:

## 28.0 API alignment and new backend scope

The endpoint shapes below (`/operator/runs/...`) are the **target** UI-shaped
contract. They do **not** all exist yet. The runtime currently exposes a smaller,
projection-based surface. This subsection maps target → existing and flags what is
**net-new backend work** so it is not mistaken for free client-side derivation.

| Target endpoint | Existing endpoint | Status |
| --------------- | ----------------- | ------ |
| `GET /operator/runs` (fleet) | `GET /agent-runs` (keyset, filters: agentId/status/since) | Rename + extend filters |
| `GET /operator/runs/:rootTaskId` (run summary) | none | **Net-new** (totals, links, missing-data flags, provenance) |
| `GET /operator/runs/:rootTaskId/graph` (windowed) | `GET /tasks/:taskId/run-graph` (full graph) | **Net-new windowing** |
| `GET /operator/runs/:rootTaskId/nodes/:taskId` | none | **Net-new** |
| `GET .../turns` and `.../turns/:n` | `GET /tasks/:taskId/turns/:turnSeq` | Partial; list endpoint net-new |
| `GET .../llm-calls` | (inside run-graph turns) | **Net-new** dedicated endpoint |
| `GET .../memory-ops` | `GET /tasks/:taskId/memory` | Rename/align |
| fleet summary counts (§8.4) | none | **Net-new aggregates endpoint** |
| `POST .../cancel` (§28.9) | none (ADR 0010 proposed) | **Blocked on runtime** |

### Decisions this implies

* **Failure path is server-computed.** "Deepest known failed node", "propagated
  failure path", and "default selected node recommendation" (§2.5, §2.9, §9.5)
  are **not** in the current `run-graph` response. They must be computed
  server-side and returned as explicit fields (consistency + testability). Treat
  this as backend scope, not client derivation.
* **Graph windowing is server-side.** Lazy children, collapsed child counts, and
  "render only visible nodes" (§2.6) require the graph endpoint to support subtree
  windowing/pagination. The current endpoint returns the whole graph.
* **Identity is consistent:** run = `rootTaskId`, node = `taskId`. The existing
  `taskId`-keyed endpoints must be aligned to this convention.
* **Tenant is session-derived** once auth exists (see §7.5); pre-auth it may use
  the existing header.

### Real-time / freshness

The "data freshness" and "refresh status" requirements (§7.1, §8.3) need an
explicit liveness model:

* **MVP:** manual refresh + a visible "last updated" timestamp and staleness
  indicator. No live push.
* **Later:** live updates for running/waiting runs via the existing SSE/streaming
  infrastructure.

The UI must never present stale data as live; absence of live push is itself a
displayed state.

## 28.1 Fleet

```http
GET /operator/runs
```

Supports:

* time window;
* status;
* agent;
* task/root task;
* waiting type;
* has trace;
* has LLM;
* has memory;
* pagination.

Returns summary rows only.

## 28.2 Run summary

```http
GET /operator/runs/:rootTaskId
```

Returns:

* root metadata;
* status;
* timestamps;
* totals;
* trace/backend links;
* missing data flags;
* provenance.

## 28.3 Run graph

```http
GET /operator/runs/:rootTaskId/graph
```

Returns:

* visible nodes;
* visible edges;
* collapsed child counts;
* failure path;
* selected default node recommendation;
* partial data flags.

## 28.4 Node detail

```http
GET /operator/runs/:rootTaskId/nodes/:taskId
```

Returns:

* node summary;
* parent;
* children summary;
* totals;
* failure/wait state;
* links;
* sanitized previews if available.

## 28.5 Turn list

```http
GET /operator/runs/:rootTaskId/nodes/:taskId/turns
```

Returns turn timeline summaries.

## 28.6 Turn detail

```http
GET /operator/runs/:rootTaskId/nodes/:taskId/turns/:turnNumber
```

Returns APLRET stage summaries, not raw full payloads by default.

## 28.7 LLM calls

```http
GET /operator/runs/:rootTaskId/llm-calls
GET /operator/runs/:rootTaskId/nodes/:taskId/llm-calls
GET /operator/runs/:rootTaskId/nodes/:taskId/turns/:turnNumber/llm-calls
```

## 28.8 Memory operations

```http
GET /operator/runs/:rootTaskId/memory-ops
GET /operator/runs/:rootTaskId/nodes/:taskId/memory-ops
GET /operator/runs/:rootTaskId/nodes/:taskId/turns/:turnNumber/memory-ops
```

## 28.9 Future intervention

```http
POST /operator/runs/:rootTaskId/cancel
```

Do not expose in MVP UI until runtime support is real.

---

# 29. QA acceptance scenarios

## 29.1 Failed run graph

Given a root run failed because a child three levels deep failed, when the user opens Run Detail, then:

* graph opens;
* failure path is expanded;
* deepest known failed node is selected;
* parent nodes show propagated failure;
* inspector shows failure summary;
* user can open the failed turn.

## 29.2 Large graph

Given a run with hundreds of nodes, when the user opens the graph, then:

* only root/important path/visible branches render;
* healthy branches are collapsed;
* UI remains responsive;
* child counts are visible;
* user can expand branches intentionally.

## 29.3 Missing trace

Given a run without trace/span references, then:

* trace/span rows show `Not captured` or `Unavailable`;
* no broken link is shown;
* user can still inspect available graph/turn data.

## 29.4 Unsafe preview

Given raw input/output payloads without sanitization, then:

* no raw payload is rendered;
* UI shows `Preview hidden for safety`;
* user still sees status, IDs, timestamps, cost, and topology.

## 29.5 Memory hit/miss missing

Given memory read events without result metadata, then:

* UI shows read operation and key metadata;
* UI does not show hit/miss;
* UI says read result was not captured.

## 29.6 Stuck derivation

Given a waiting run past configured threshold, then:

* UI shows `Stuck`;
* UI shows await type;
* UI shows wait duration;
* UI shows threshold used;
* UI makes clear this is dashboard-derived.

## 29.7 Cost missing

Given a run without cost capture, then:

* Fleet row shows `Not captured`;
* Run header shows cost unavailable;
* UI does not show zero cost.

## 29.8 Keyboard graph navigation

Given keyboard-only user, then:

* user can focus graph;
* move between nodes;
* select a node;
* expand/collapse node;
* open inspector;
* navigate tabs.

---

# 30. MVP development steps

## Step 1 — Core investigation shell

Build:

* app shell;
* Fleet table;
* run filters;
* Run Detail route;
* run header;
* missing-data states.

Goal:

> User can find and open a run.

## Step 2 — Visual Agent Run Graph

Build:

* graph renderer;
* custom nodes;
* custom edges;
* automatic layout;
* lazy expansion;
* failure path highlighting;
* default node selection;
* node inspector summary.

Goal:

> User can understand the run topology and find the failing/waiting node.

## Step 3 — Turn and cognition detail

Build:

* turn timeline;
* turn detail;
* APLRET stage stepper;
* first abnormal turn navigation.

Goal:

> User can find the first wrong turn.

## Step 4 — LLM and memory metadata

Build:

* LLM tab;
* memory tab;
* cost rollups within run;
* contract failure markers;
* memory operation links to turns.

Goal:

> User can explain cost, contract failures, and memory-related behavior from captured metadata.

## Step 5 — Hardening

Build:

* accessibility pass;
* large graph performance;
* keyboard navigation;
* URL state;
* error boundaries;
* preview sanitizer integration.

Goal:

> UI is safe and reliable for production use.

## Later steps

Build only after data/runtime support exists:

* customer/case grouping;
* FinOps analytics;
* historical outlier detection;
* stuck thresholds by agent;
* saved views;
* ownership routing;
* cancellation;
* retry/resume;
* memory key investigation;
* product/domain owner lens.

---

# 31. Final acceptance bar

This document is accepted for MVP design/build only if the team agrees to the following:

1. The Visual Agent Run Graph is the primary Run Detail UI.
2. The graph is read-only and execution-derived.
3. The MVP focuses on investigation, not full analytics.
4. Customer/case grouping is not core MVP until business entity metadata exists.
5. Cache hit/miss is not shown until memory read result is captured.
6. Raw input/output previews are not shown until sanitized.
7. Cancellation is excluded or feature-flagged until runtime support is implemented.
8. Missing data is explicit, not hidden.
9. Status never relies on color alone.
10. Large graphs are collapsed/lazy-rendered by default.
11. Hatchet is a deep-link escape hatch; trace/span IDs are copyable correlation handles.
12. The UI never pretends to know what the system did not capture.

The product quality bar:

> A user should open a failed run, see the execution graph, jump to the deepest known failure, inspect the relevant turn, understand the available evidence, and know when to open the raw trace — without reading source code or querying the database.
