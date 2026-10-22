# Testing approach, limitations and trade-offs

`npm test` runs 51 tests using only `node:test` (no dependencies).

| Layer | File | What it proves |
| --- | --- | --- |
| Service units | `test/service/validator.test.js`, `units.test.js` | URL/alias/TTL rules (schemes, private hosts, credentials), code randomness, token bucket and LRU bound, store semantics, atomic file persistence |
| Service API (real HTTP, port 0) | `test/service/api.test.js` | 201/302/400/401/403/404/409/410/413/429, analytics aggregation, analytics-failure isolation, management-disabled mode |
| Orchestrator mechanics | `test/orchestrator/engine.test.js` | cycle/unknown-dep/CHG-002 validation, parallel + sync, bounded retry, fallback, rollback-all, gates, rejection, policy block vs critical safe-stop, path traversal, command allow-list, change-budget escalation, attempt budget, kill switch, structural re-plan (and rejected plan), upstream-change invalidation with lineage versions, upstream-only context, audit tamper detection, workspace confinement/revert |
| End-to-end scenarios | `test/orchestrator/scenarios.test.js` | the three scenarios, chaos, rejection paths, escalation, audit verification; generated projects run **their own** test suites inside the run workspace |

**Two levels of test.** The repository's tests verify the system. During a run, exit gates verify the *generated* outputs (including executing generated tests), so validation evidence is produced per run and stored in `evidence/`.

## Limitations
* Agents are deterministic templates/rules, not an LLM; requirement NLP is keyword-based and English-only.
* Orchestration is in-process: no crash-resume, no distributed workers, sequential execution of synchronous `spawnSync` test runs inside a "parallel" batch.
* Audit log is tamper-**evident**, not tamper-proof; production needs write-once storage and signed approvals with real identities.
* `--auto-approve` is a demo mode and bypasses real human review.
* Sandbox is allow-list + timeout + stripped env; it is not container isolation.
* Service: single-instance rate limiting and JSON-file persistence (O(n) per write), no per-user ownership, no destination reputation check, no load test of the stated latency targets.
* Release readiness checks are structural (tests exist/pass, scans clean); they cannot judge business correctness.

## Trade-offs
Evidence over speed (gates run real tests); safety over progress (critical violations stop the whole run); simplicity over scale (zero dependencies, in-memory state).
