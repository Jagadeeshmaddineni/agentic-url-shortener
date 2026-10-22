# Requirement understanding

## Problem statement (normalized)
Build a **working prototype that turns a requirement into a reviewable engineering outcome** using an agentic execution model. The *subject* is a URL shortener, but the *evaluated artifact* is the **orchestration layer**: a stateful, governed SDLC workflow, not just the service.

## What is being asked, and where it lives

| # | Assignment requirement | Interpretation | Implementation |
|---|---|---|---|
| 1 | Requirement understanding | Normalize intent, surface ambiguity, record assumptions | `src/agents/requirements.js` (interpret, ambiguity lexicon, `resolveSpec`) |
| 2 | Task decomposition | Requirement -> tasks with dependencies/sequencing | `src/scenarios/graphs.js` (explicit DAG per scenario) |
| 3 | Codebase reasoning (brownfield) | Impacted modules, data flow, blast radius | `codebaseAnalysisAgent`: import graph, route map, keyword + route-ownership impact analysis |
| 4 | Workflow orchestration (differentiator) | See table below | `src/orchestrator/*` |
| 5 | Engineering output | Code, API/schema, tests, docs | Reference service + generated OpenAPI, acceptance tests, README, ADRs |
| 6 | Validation and risk control | Risks, failure scenarios, guardrails | Risk register agent, policy engine, exit gates that *run the tests* |
| 7 | Controlled autonomy | Agents act, humans approve | Approval checkpoints; policy escalation; safe-stop |
| 8 | Final engineering summary | Plan, artifacts, risks, assumptions, limits | `summaryAgent` generates `docs/ENGINEERING_SUMMARY.md` from run evidence |

### Orchestration checklist (requirement 4)

| Required capability | Where |
|---|---|
| Explicit dependency graph with entry/exit gates | `graph.js`, `entryGate`/`exitGate` per node |
| Sequential + parallel paths with synchronization | batches of ready nodes; join nodes; `batch.synchronized` audit event |
| Cross-stage context and decision lineage | `context.js` (versioned outputs, consumed-input versions, decisions) -> `lineage.json` |
| Human approval checkpoints for high-impact actions | `impact: 'high'` requires `approval.required` (validated at graph build, rule CHG-002) |
| Bounded retries, fallback, rollback, safe-stop | `engine.js`: per-node retries -> fallback agent -> journaled rollback; attempt/failure/re-plan budgets; operator kill switch |
| Policy guardrails (security, compliance, change control) | `policy.js` rules SEC-001..004, CMP-001, CHG-001..003 |
| Audit-grade observability and traceability | hash-chained `audit.jsonl`, verifiable offline |
| Reliability metrics | success rate, first-attempt rate, retries, rollbacks, fallbacks, MTTR, e2e latency, approvals |
| Dynamic re-planning on upstream change | `replan` (insert nodes) and `updateOutput` (stale propagation) |

## Ambiguities in the assignment and the decisions taken

| Ambiguity | Decision |
|---|---|
| "Agents" - LLM-backed or not? | Agents are **deterministic, rule/template based** behind a narrow `ctx -> {output, artifacts}` contract so the prototype is reproducible and testable offline. An LLM can replace any agent without changing orchestration, because every artifact still passes policy and gates. Stated as a limitation. |
| Java or JS | **JavaScript (Node >= 20), zero dependencies**: runs anywhere with one command; no install step. |
| Brownfield codebase | Ships a small legacy service (`fixtures/legacy-service`) with a real security bug, so brownfield reasoning, reproduction and fallback are demonstrated on real code. |
| What is "high impact"? | Public API contract, breaking behaviour changes, and release. Policy can also *escalate* any node (e.g. change budget exceeded). |
| Human in the loop in a demo | Interactive CLI approver by default; `--auto-approve` is an explicit demo mode, recorded as `mode=auto-demo` in the audit log. |
| Rollback semantics | A terminal node failure rolls back every committed node in reverse order (all-or-nothing delivery). A human **rejection** reverts only the rejected node and safe-stops, because earlier approved work stays valid. |
| Persistence of run state | Run is in-process; evidence is persisted. Resume-after-crash is out of scope (limitation). |
