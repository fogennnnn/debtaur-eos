/**
 * Guided four-outcome sequence plus shared ruleset-integrity helpers.
 * Browser-safe: imports only ./engine.js and ./ledger.js (no node APIs,
 * no DOM, no network), so a page can import this module directly and run
 * the same Friday sequence client-side that the CLI runs in Node.
 *
 * The SEQUENCE covers the flagship expense-signoff policy in order:
 *   1. clean allow with derivation,
 *   2. refusal with the exact missing premise,
 *   3. signed-but-unapproved escalation,
 *   4. change-attempt refused and logged (tamper variant evaluated against
 *      a deliberately altered in-memory copy — never touches real files).
 */
import { evaluateAction, nextIssueId } from "./engine.js";
import { appendDecision, sha256Hex } from "./ledger.js";

/**
 * Owner-facing meaning line for integrity refusals (shared by CLI + load gate
 * so the wording stays grouped here, not scattered). Accurate while the anchor
 * holds: quiet edits cannot widen authority, and the change stops at the
 * affected policy surface while unaffected areas stay live.
 */
export const INTEGRITY_MEANING =
  "quiet edits cannot widen spend authority — the unsigned change stops at this policy surface; unaffected areas stay live.";

/**
 * Stable serialisation: objects with keys sorted recursively, arrays in order.
 * Key order in the file itself does not matter; only content does.
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Canonical serialisation of ruleset content for integrity hashing.
 * Covers the whole ruleset EXCEPT the top-level `version` object (which
 * carries the hash — including it would be circular).
 * @param {import('./types.js').SOPRuleSet} rules
 * @returns {string}
 */
export function canonicalRulesetContent(rules) {
  const { version, ...rest } = rules ?? {};
  void version;
  return stableStringify(rest);
}

/**
 * Content hash in the stored form ("sha256:" + hex).
 * @param {import('./types.js').SOPRuleSet} rules
 * @returns {string}
 */
export function contentHash(rules) {
  return `sha256:${sha256Hex(canonicalRulesetContent(rules))}`;
}

/**
 * Verify the stored signature against the recomputed content hash.
 * Accepts the "sha256:" prefix form of version.version_hash.
 * @param {import('./types.js').SOPRuleSet} rules
 * @returns {{ ok: boolean, expected: string, recomputed: string }}
 */
export function verifyRulesetIntegrity(rules) {
  const stored = String(rules?.version?.version_hash ?? "");
  const expected = stored.startsWith("sha256:") ? stored.slice("sha256:".length) : stored;
  const recomputed = sha256Hex(canonicalRulesetContent(rules));
  return { ok: expected.length > 0 && expected === recomputed, expected, recomputed };
}

/**
 * Build a RULESET_INTEGRITY tamper refusal for a ruleset whose stored hash
 * does not match its recomputed content hash. Pure data — the caller decides
 * whether to append it to the ledger and whether to exit.
 * @param {{ sourceLabel: string, rules: import('./types.js').SOPRuleSet | null, recomputedHex: string, issuePrefix?: string, reason?: string, extraContext?: object }} opts
 * @returns {import('./types.js').EvaluationResult}
 */
export function buildTamperRefusal(opts) {
  const { sourceLabel, rules, recomputedHex, issuePrefix, extraContext } = opts ?? {};
  const timestamp = new Date().toISOString();
  const storedHash = String(rules?.version?.version_hash ?? "(missing or unreadable)");
  const ruleVersionId = rules?.version?.id ?? "unknown-rule-version";
  const sopId = rules?.sop_id ?? String(sourceLabel);
  const policyTitle = typeof rules?.title === "string" && rules.title.length > 0 ? rules.title : sopId;
  const prefix = typeof issuePrefix === "string" && issuePrefix.length > 0
    ? issuePrefix
    : (typeof rules?.issue_prefix === "string" && rules.issue_prefix.length > 0 ? rules.issue_prefix : "ISS-2026");
  const reason = typeof opts?.reason === "string" && opts.reason.length > 0
    ? opts.reason
    : `Ruleset integrity failure for '${sourceLabel}': the stored version hash does not match the recomputed content hash ` +
      `(stored ${storedHash}; recomputed sha256:${recomputedHex}). ` +
      `The ruleset may have been edited after signing. Refusing to proceed with untrusted rules.`;
  const chain = [
    `Integrity check of '${sourceLabel}' rule version '${ruleVersionId}' failed: stored hash does not match recomputed content hash.`,
    `REFUSED at RULESET_INTEGRITY: ${reason}`,
  ];
  return {
    status: "REFUSED",
    sop_id: sopId,
    policy_title: policyTitle,
    action_id: "RULESET-LOAD",
    actor_id: "system",
    rule_version_hash: storedHash,
    timestamp,
    derivation: chain,
    derivation_chain: chain,
    refusal_details: {
      missing_premise_id: "RULESET_INTEGRITY",
      reason,
      policy_issue: {
        id: nextIssueId(prefix),
        title: `Policy refusal on ruleset load — RULESET_INTEGRITY (${sourceLabel})`,
        missing_premise: "RULESET_INTEGRITY",
        context: {
          action_id: "RULESET-LOAD",
          source: sourceLabel,
          rule_version: ruleVersionId,
          stored_hash: storedHash,
          recomputed_hash: `sha256:${recomputedHex}`,
          ...(extraContext ?? {}),
        },
      },
    },
  };
}

/**
 * The guided Friday sequence: one policy, four outcomes, in order.
 * Step 4 carries a `tamper` mutation applied to an in-memory copy only.
 */
export const SEQUENCE = {
  id: "expense-signoff-four-outcomes",
  title: "Friday run: one policy, four outcomes in order",
  sop_id: "SOP-FIN-01",
  steps: [
    {
      n: 1,
      title: "Clean allow — $7,500 with all signatures authorizes with a derivation",
      request: {
        action_id: "SEQ-01-ALLOW",
        action_type: "execute-payout",
        actor_id: "dept-head-01",
        amount: 7500,
        currency: "USD",
        vendor: "Acme Supplies",
        signatures: { dept_head: true, ceo: false, finance: true },
      },
      expect: { status: "AUTHORIZED" },
    },
    {
      n: 2,
      title: "Refusal names the exact missing premise — $3,200 with no finance signature",
      request: {
        action_id: "SEQ-02-REFUSE",
        action_type: "execute-payout",
        actor_id: "dept-head-01",
        amount: 3200,
        currency: "USD",
        vendor: "Initech LLC",
        signatures: { dept_head: true, ceo: false, finance: false },
      },
      expect: { status: "REFUSED", missing_premise_id: "PREMISE_FIN_05_FINANCE_SIG" },
    },
    {
      n: 3,
      title: "Signed-but-unapproved escalation — $12,000 payout signed with no owner override",
      request: {
        action_id: "SEQ-03-ESCALATE",
        action_type: "execute-payout",
        actor_id: "dept-head-01",
        amount: 12000,
        currency: "USD",
        vendor: "Acme Supplies",
        signatures: { dept_head: true, ceo: false, finance: true },
      },
      expect: { status: "ESCALATED", unsatisfied_premise_id: "PREMISE_FIN_02_CEO_OVERRIDE_REQUIRED" },
    },
    {
      n: 4,
      title: "Change attempt refused and logged — a superseded draft widens the spend limit",
      tamper: { field: "threshold", value: 999999 },
      expect: { status: "REFUSED", missing_premise_id: "RULESET_INTEGRITY" },
    },
  ],
};

/**
 * Render one executed step as plain-text lines (no ANSI — safe for browsers).
 * @param {{ n: number, title: string, expected: object, status: string, pass: boolean, premise: string | null, issue_id: string | null, note?: string }} r
 * @param {number} total
 * @returns {string[]}
 */
function renderStep(r, total) {
  const lines = [
    `Step ${r.n}/${total}: ${r.title}`,
    `  Expected: ${r.expected.status}${r.expected.missing_premise_id ? ` / ${r.expected.missing_premise_id}` : ""}${r.expected.unsatisfied_premise_id ? ` / ${r.expected.unsatisfied_premise_id}` : ""}`,
    `  Actual:   ${r.status}${r.premise ? ` / ${r.premise}` : ""}${r.issue_id ? ` (issue ${r.issue_id})` : ""}`,
  ];
  if (r.note) {
    lines.push(`  Note: ${r.note}`);
  }
  lines.push(`  ${r.pass ? "PASS" : "FAIL"}`);
  return lines;
}

/**
 * Execute the SEQUENCE in order against engine+ledger.
 * Step 4 clones the ruleset in memory, applies its tamper mutation, and runs
 * the integrity refusal path — real files are never touched.
 * @param {import('./types.js').SOPRuleSet} expenseRules - the live expense-signoff ruleset
 * @param {{ onEntry?: (entry: import('./types.js').LedgerEntry) => void }} [options]
 * @returns {{ sequence: { id: string, title: string, sop_id: string }, results: object[], allPass: boolean }}
 */
export function runSequence(expenseRules, options = {}) {
  const onEntry = typeof options?.onEntry === "function" ? options.onEntry : null;
  const results = [];
  for (const step of SEQUENCE.steps) {
    if (step.tamper) {
      const altered = JSON.parse(JSON.stringify(expenseRules));
      altered[step.tamper.field] = step.tamper.value;
      const check = verifyRulesetIntegrity(altered);
      const sourceLabel = `${expenseRules?.sop_id ?? "policy"} (superseded draft)`;
      const result = buildTamperRefusal({
        sourceLabel,
        rules: altered,
        recomputedHex: check.recomputed,
        extraContext: { mutated_field: step.tamper.field, mutated_value: step.tamper.value },
      });
      const entry = appendDecision(result);
      if (onEntry) {
        onEntry(entry);
      }
      const premise = result.refusal_details.missing_premise_id;
      const pass = !check.ok &&
        result.status === step.expect.status &&
        premise === step.expect.missing_premise_id;
      results.push({
        n: step.n,
        title: step.title,
        expected: step.expect,
        status: result.status,
        pass,
        premise,
        issue_id: result.refusal_details.policy_issue.id,
        note: `superseded draft presents ${step.tamper.field}=${step.tamper.value} against the live signature; refusal logged as ledger seq ${entry.seq}`,
        lines: [],
        result,
        entry,
      });
    } else {
      const result = evaluateAction(step.request, expenseRules);
      const entry = appendDecision(result, step.request);
      if (onEntry) {
        onEntry(entry);
      }
      let premise = null;
      let issueId = null;
      if (result.status === "REFUSED") {
        premise = result.refusal_details.missing_premise_id;
        issueId = result.refusal_details.policy_issue.id;
      } else if (result.status === "ESCALATED") {
        premise = result.escalation_details.unsatisfied_premise_id;
        issueId = result.escalation_details.policy_issue.id;
      }
      const want = step.expect.unsatisfied_premise_id ?? step.expect.missing_premise_id ?? null;
      const pass = result.status === step.expect.status && (want === null || premise === want);
      results.push({
        n: step.n,
        title: step.title,
        expected: step.expect,
        status: result.status,
        pass,
        premise,
        issue_id: issueId,
        lines: [],
        result,
        entry,
      });
    }
  }
  for (const r of results) {
    r.lines = renderStep(r, SEQUENCE.steps.length);
  }
  return {
    sequence: { id: SEQUENCE.id, title: SEQUENCE.title, sop_id: SEQUENCE.sop_id },
    results,
    allPass: results.every((r) => r.pass),
  };
}
