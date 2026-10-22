import { WorkflowGraph } from '../orchestrator/graph.js';
import { clarifyAgent, requirementsAgent } from '../agents/requirements.js';
import { apiSpecAgent, apiSpecGate, architectureAgent, riskAgent } from '../agents/design.js';
import { docsAgent, docsGate, implementationAgent, implementationGate, releaseGate, releaseReadinessAgent, securityGate, securityScanAgent, testAgent, testGate } from '../agents/delivery.js';
import { summaryAgent } from '../agents/summary.js';
import { analysisGate, brownfieldReleaseAgent, brownfieldRequirementsAgent, changePlanAgent, changelogAgent, changelogGate, codebaseAnalysisAgent, patchGate, patchInlineAgent, patchValidatorAgent, reproduceAgent, reproduceGate, securityRescanAgent, verifyAgent, verifyGate } from '../agents/brownfield.js';

const requirementsGate = async (result) => {
  const { functional } = result.output.spec;
  if (!functional.length) return { ok: false, reason: 'no functional requirements could be derived' };
  const bare = functional.filter((f) => !f.acceptance?.length);
  return bare.length ? { ok: false, reason: `requirements without acceptance criteria: ${bare.map((f) => f.id).join(', ')}` } : { ok: true, evidence: { functional: functional.length } };
};

export const AGENTS = {
  requirements: requirementsAgent, clarify: clarifyAgent, architecture: architectureAgent, risk: riskAgent, 'api-spec': apiSpecAgent,
  implementation: implementationAgent, 'unit-tests': testAgent, docs: docsAgent, 'security-scan': securityScanAgent,
  'release-readiness': releaseReadinessAgent, summary: summaryAgent,
  'requirements-bf': brownfieldRequirementsAgent, 'codebase-analysis': codebaseAnalysisAgent, reproduce: reproduceAgent, 'change-plan': changePlanAgent,
  'patch-inline': patchInlineAgent, 'patch-validator': patchValidatorAgent, verify: verifyAgent, changelog: changelogAgent,
  'security-rescan': securityRescanAgent, 'release-bf': brownfieldReleaseAgent,
};

/** Greenfield (also used by the ambiguous scenario, which re-plans around the `clarify` node). */
export function buildGreenfieldGraph() {
  const g = new WorkflowGraph();
  g.addNode({ id: 'requirements', stage: 'requirements', agent: 'requirements', exitGate: requirementsGate });
  g.addNode({ id: 'architecture', stage: 'design', agent: 'architecture', deps: ['requirements'], impact: 'medium' });
  g.addNode({ id: 'risk', stage: 'design', agent: 'risk', deps: ['requirements'] });
  g.addNode({
    id: 'api-spec', stage: 'design', agent: 'api-spec', deps: ['architecture'], impact: 'high', exitGate: apiSpecGate,
    approval: { required: true, summary: (r) => `Public API contract (hard to change once clients exist): ${r.output.operations.join('; ')}` },
  });
  g.addNode({ id: 'implementation', stage: 'implementation', agent: 'implementation', deps: ['api-spec', 'risk'], impact: 'medium', retries: 1, entryGate: async (v) => ({ ok: v.has('api-spec'), reason: 'API contract must be approved before implementation' }), exitGate: implementationGate });
  g.addNode({ id: 'unit-tests', stage: 'testing', agent: 'unit-tests', deps: ['implementation'], retries: 1, entryGate: async (v) => ({ ok: v.exists('src/service/app.js'), reason: 'implementation artifacts missing' }), exitGate: testGate });
  g.addNode({ id: 'docs', stage: 'documentation', agent: 'docs', deps: ['implementation'], exitGate: docsGate });
  g.addNode({ id: 'security-scan', stage: 'testing', agent: 'security-scan', deps: ['implementation'], retries: 1, exitGate: securityGate });
  g.addNode({
    id: 'release-readiness', stage: 'release', agent: 'release-readiness', deps: ['unit-tests', 'docs', 'security-scan'], impact: 'high', exitGate: releaseGate,
    approval: { required: true, summary: (r) => `Release gate checklist: ${r.summary}` },
  });
  g.addNode({ id: 'summary', stage: 'release', agent: 'summary', deps: ['release-readiness'] });
  return g;
}

/** Brownfield bug fix: analyse -> reproduce (red) -> approved plan -> patch (fallback) -> verify in parallel -> release. */
export function buildBrownfieldGraph() {
  const g = new WorkflowGraph();
  g.addNode({ id: 'requirements', stage: 'requirements', agent: 'requirements-bf', exitGate: requirementsGate });
  g.addNode({ id: 'codebase-analysis', stage: 'design', agent: 'codebase-analysis', exitGate: analysisGate });
  g.addNode({ id: 'reproduce', stage: 'testing', agent: 'reproduce', deps: ['requirements', 'codebase-analysis'], exitGate: reproduceGate });
  g.addNode({
    id: 'change-plan', stage: 'design', agent: 'change-plan', deps: ['reproduce'], impact: 'high',
    approval: { required: true, summary: (r) => r.summary },
  });
  g.addNode({ id: 'patch', stage: 'implementation', agent: 'patch-inline', fallbackAgent: 'patch-validator', retries: 1, deps: ['change-plan'], impact: 'medium', exitGate: patchGate });
  g.addNode({ id: 'verify', stage: 'testing', agent: 'verify', deps: ['patch'], exitGate: verifyGate });
  g.addNode({ id: 'changelog', stage: 'documentation', agent: 'changelog', deps: ['patch'], exitGate: changelogGate });
  g.addNode({ id: 'security-rescan', stage: 'testing', agent: 'security-rescan', deps: ['patch'], exitGate: securityGate });
  g.addNode({
    id: 'release-readiness', stage: 'release', agent: 'release-bf', deps: ['verify', 'changelog', 'security-rescan'], impact: 'high', exitGate: releaseGate,
    approval: { required: true, summary: (r) => `Release gate checklist: ${r.summary}` },
  });
  g.addNode({ id: 'summary', stage: 'release', agent: 'summary', deps: ['release-readiness'] });
  return g;
}
