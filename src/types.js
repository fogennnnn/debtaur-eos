/**
 * Shared JSDoc typedefs for the deterministic SOP policy enforcer.
 * This module exports nothing at runtime; it documents the shapes
 * used by engine.js, ledger.js and cli.js.
 *
 * @typedef {Object} RuleVersion
 * @property {string} id               - Rule version identifier (e.g. "sop_fin_01_v1.0.0").
 * @property {string} version_hash     - Deterministic hash identifying this signed version.
 * @property {string} effective_date   - ISO date from which this version is live.
 * @property {string} signed_by        - Role/human that signed this version into force.
 *
 * @typedef {Object} Premise
 * @property {string} id               - Stable premise identifier (e.g. "PREMISE_FIN_01_DEPT_HEAD_SIG").
 * @property {string} description      - Human-readable statement of the required premise.
 * @property {string} evaluator_key    - Registry key the engine dispatches on.
 * @property {Object} [params]         - Evaluator arguments (fields, lists, thresholds, signers).
 * @property {string[]} [escalate_on]  - Signature names whose presence converts failure into ESCALATED.
 *
 * @typedef {Object} SOPRuleSet        - Data-driven policy; engine reads premises + named data only.
 * @property {string} sop_id
 * @property {string} title            - Client-plain words, never methodology jargon.
 * @property {string} [demo_story]     - One-line plain-words situation the demo shows.
 * @property {RuleVersion} version
 * @property {string} [issue_prefix]   - Policy-issue ID prefix (e.g. "ISS-FIN-2026").
 * @property {Premise[]} premises
 * @property {Object[]} [signers]      - [{ key, label }] signature roles this policy recognises.
 * @property {Object[]} [input_fields] - [{ key, label, type, choices?, default? }] live-mode prompts.
 *
 * @typedef {Object} ActionRequest     - Field values plus a signatures map; shapes vary per policy.
 * @property {string} [action_id]
 * @property {string} [action_type]
 * @property {string} [actor_id]
 * @property {Object<string, boolean>} [signatures]
 *
 * @typedef {Object} PolicyIssue
 * @property {string} id               - Policy issue identifier (e.g. "ISS-FIN-2026-001").
 * @property {string} title
 * @property {string} missing_premise  - Premise ID that could not be satisfied.
 * @property {boolean} [conflict]      - True when the issue flags a signed-but-unapproved conflict.
 * @property {Object} context          - Minimal context to route the issue to an owner.
 *
 * @typedef {Object} RefusalDetails
 * @property {string} missing_premise_id
 * @property {string} reason
 * @property {PolicyIssue} policy_issue
 *
 * @typedef {Object} EscalationDetails
 * @property {string} conflicting_signature - Signature key present without approval (e.g. "finance").
 * @property {string} [conflicting_signature_label] - Human label for that signature.
 * @property {string} unsatisfied_premise_id - Premise left unsatisfied.
 * @property {string} reason
 * @property {PolicyIssue} policy_issue
 *
 * @typedef {Object} EvaluationResult
 * @property {"AUTHORIZED"|"REFUSED"|"ESCALATED"} status
 * @property {string} [sop_id]
 * @property {string} action_id
 * @property {string} actor_id
 * @property {string} rule_version_hash
 * @property {string} timestamp        - ISO timestamp of evaluation.
 * @property {string[]} derivation     - Step-by-step logic path.
 * @property {string[]} [derivation_chain] - Alias of derivation (kept for compatibility).
 * @property {RefusalDetails} [refusal_details]
 * @property {EscalationDetails} [escalation_details]
 *
 * @typedef {Object} LedgerEntry
 * @property {number} seq
 * @property {string} timestamp
 * @property {"AUTHORIZED"|"REFUSED"|"ESCALATED"|"ANCHORED"|"NOTICE"} status
 * @property {string} [kind]           - Entry kind (e.g. "RULESET_ANCHORED", "POLICYSET_LIVE").
 * @property {string} [sop_id]         - Policy id for anchor entries.
 * @property {string} action_id
 * @property {string} actor_id
 * @property {string} rule_version_hash
 * @property {string[]} derivation
 * @property {string} prev_hash
 * @property {string} hash
 */

export {};
