import { createInterface } from 'node:readline/promises';

/**
 * Human-in-the-loop interfaces.
 *   decide(request)   -> { approved, reviewer, comment, mode }
 *   answer(questions) -> { answers: {id: value}, reviewer, mode }
 * `mode` is always written to the audit log so reviewers can see whether a human or a demo policy decided.
 */

/** Deterministic approver for tests/demos: per-node decisions with a default. */
export class ScriptedApprover {
  constructor({ decisions = {}, defaultDecision = 'approve', answers = {}, reviewer = 'scripted-reviewer', mode = 'scripted' } = {}) {
    Object.assign(this, { decisions, defaultDecision, answers, reviewer, mode });
    this.requests = [];
  }

  async decide(request) {
    this.requests.push(request);
    const d = this.decisions[request.nodeId] ?? this.defaultDecision;
    return { approved: d === 'approve', reviewer: this.reviewer, comment: d === 'approve' ? 'approved by scripted policy' : 'rejected by scripted policy', mode: this.mode };
  }

  async answer(questions) {
    const answers = {};
    for (const q of questions) answers[q.id] = this.answers[q.id] ?? q.proposedDefault;
    return { answers, reviewer: this.reviewer, mode: this.mode, usedDefaults: questions.filter((q) => !(q.id in this.answers)).map((q) => q.id) };
  }
}

/** Explicit demo mode (`--auto-approve`): approves everything and says so loudly in the audit log. */
export class AutoApprover extends ScriptedApprover {
  constructor(opts = {}) {
    super({ reviewer: 'auto-approve-demo', mode: 'auto-demo', ...opts });
  }
}

/** Interactive terminal approver. */
export class CliApprover {
  constructor({ input = process.stdin, output = process.stdout, reviewer = process.env.USER ?? 'cli-user' } = {}) {
    this.rl = createInterface({ input, output });
    this.reviewer = reviewer;
  }

  async decide(request) {
    console.log(`\n--- APPROVAL REQUIRED: ${request.nodeId} (${request.stage}, impact: ${request.impact}) ---`);
    console.log(request.summary);
    if (request.policyFindings?.length) console.log('Policy findings:', request.policyFindings.map((f) => `${f.rule}: ${f.reason}`).join('; '));
    console.log('Artifacts:', request.artifacts.join(', ') || '(none)');
    const a = (await this.rl.question('Approve? [y/N] ')).trim().toLowerCase();
    const comment = a === 'y' ? 'approved interactively' : (await this.rl.question('Reason for rejection: ')).trim();
    return { approved: a === 'y', reviewer: this.reviewer, comment, mode: 'interactive' };
  }

  async answer(questions) {
    console.log('\n--- CLARIFICATION NEEDED ---');
    const answers = {};
    for (const q of questions) {
      const v = (await this.rl.question(`${q.question}\n  [default: ${q.proposedDefault}] > `)).trim();
      answers[q.id] = v || q.proposedDefault;
    }
    return { answers, reviewer: this.reviewer, mode: 'interactive', usedDefaults: [] };
  }

  close() { this.rl.close(); }
}
