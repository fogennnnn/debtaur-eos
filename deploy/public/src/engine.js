/**
 * Data-driven deterministic policy evaluator.
 * Pure and synchronous: no network, no I/O, no randomness, no node-only
 * imports — this module runs unchanged in Node and in browsers.
 *
 * Each ruleset JSON declares an ordered `premises` list. The engine walks it
 * and dispatches every premise on the evaluator registry below via its
 * `evaluator_key`. Statuses: AUTHORIZED (all premises satisfied), REFUSED (a
 * premise is merely missing or uncovered — silence is never consent),
 * ESCALATED (a downstream/executing signature listed in the premise's
 * `escalate_on` is present while that premise is unsatisfied: a
 * signed-but-unapproved conflict needing owner review).
 *
 * Premise shape:
 *   { id, description, evaluator_key, params?, escalate_on? }
 * `params` carries the evaluator's arguments; `escalate_on` lists signature
 * names whose presence converts this premise's failure into ESCALATED.
 *
 * Evaluator registry (all pure functions of request + params + ruleset):
 *   signature-present                 { signer, label? }
 *   positive-amount                   { field }
 *   text-present                      { field }
 *   value-in-allowlist                { field, values? | list? }
 *   vendor-active-against-list        { field, list }
 *   currency-in-supported-set         { field, list }
 *   amount-over-threshold-needs-override { amount_field, threshold | threshold_field, override_signer, override_label? }
 *   date-within-validity              { date_field, window_key }
 *   signature-required-when           { when_field, when_value, signer, label? }
 *   require-all                       { checks: [{ evaluator_key, params? }], success_detail? }
 * `list`, `threshold_field` and `window_key` resolve against the ruleset's
 * own top-level data (or its `data` object), so thresholds and allowlists
 * stay signed content, not code.
 */

const issueCounters = Object.create(null);

/**
 * Reset all policy-issue counters (used for tests / replay).
 * @returns {void}
 */
export function resetIssueCounter() {
  for (const key of Object.keys(issueCounters)) {
    delete issueCounters[key];
  }
}

/**
 * Build the next deterministic policy-issue identifier for a ruleset prefix.
 * Exported so the load-time integrity path can mint non-colliding IDs.
 * @param {string} [prefix]
 * @returns {string}
 */
export function nextIssueId(prefix) {
  const p = typeof prefix === "string" && prefix.length > 0 ? prefix : "ISS-2026";
  issueCounters[p] = (issueCounters[p] ?? 0) + 1;
  return `${p}-${String(issueCounters[p]).padStart(3, "0")}`;
}

/**
 * @param {object} request
 * @param {string} name
 * @returns {boolean}
 */
function hasSig(request, name) {
  return request?.signatures?.[name] === true;
}

/**
 * @param {object} request
 * @param {string} key
 * @returns {unknown}
 */
function fieldOf(request, key) {
  return request?.[key];
}

/**
 * Resolve a named list from signed ruleset content (top level, then `data`).
 * @param {object} ruleset
 * @param {string} name
 * @returns {unknown[] | null}
 */
function resolveList(ruleset, name) {
  const v = ruleset?.[name] ?? ruleset?.data?.[name];
  return Array.isArray(v) ? v : null;
}

/**
 * Resolve a named threshold number from params or signed ruleset content.
 * @param {object} params
 * @param {object} ruleset
 * @returns {number | null}
 */
function resolveThreshold(params, ruleset) {
  if (typeof params?.threshold === "number") {
    return params.threshold;
  }
  const v = ruleset?.[params?.threshold_field] ?? ruleset?.data?.[params?.threshold_field];
  return typeof v === "number" ? v : null;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function show(v) {
  return v === undefined || v === null || v === "" ? "(missing)" : String(v);
}

/**
 * Evaluator registry: key -> (request, params, ruleset) => { ok, detail, reason }.
 * `detail` narrates the check for the derivation log; `reason` explains a failure.
 * @type {Record<string, (request: object, params: object, ruleset: object) => { ok: boolean, detail: string, reason: string }>}
 */
const evaluators = {
  "signature-present"(request, params) {
    const signer = params?.signer;
    const label = params?.label ?? signer;
    if (hasSig(request, signer)) {
      return { ok: true, detail: `'${label}' signature present.`, reason: "" };
    }
    return {
      ok: false,
      detail: `'${label}' signature missing.`,
      reason: `Required signer '${label}' has not signed.`,
    };
  },

  "positive-amount"(request, params) {
    const f = params?.field ?? "amount";
    const v = fieldOf(request, f);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return { ok: true, detail: `${f}=${v} is a positive amount.`, reason: "" };
    }
    return {
      ok: false,
      detail: `${f} missing or not positive.`,
      reason: `A positive numeric '${f}' is required; none was provided.`,
    };
  },

  "text-present"(request, params) {
    const f = params?.field ?? "name";
    const v = fieldOf(request, f);
    if (typeof v === "string" && v.trim().length > 0) {
      return { ok: true, detail: `${f}='${v.trim()}' provided.`, reason: "" };
    }
    return {
      ok: false,
      detail: `${f} missing or blank.`,
      reason: `A non-empty '${f}' is required; none was provided.`,
    };
  },

  "value-in-allowlist"(request, params, ruleset) {
    const f = params?.field;
    const allowed = Array.isArray(params?.values) ? params.values : resolveList(ruleset, params?.list);
    const v = fieldOf(request, f);
    if (Array.isArray(allowed) && allowed.includes(v)) {
      return { ok: true, detail: `${f}='${show(v)}' is explicitly allowed.`, reason: "" };
    }
    const options = Array.isArray(allowed) && allowed.length > 0 ? allowed.join(", ") : "(none)";
    return {
      ok: false,
      detail: `${f}='${show(v)}' is not in the allowlist.`,
      reason: `'${f}' value '${show(v)}' is not covered by any live rule (allowed: ${options}). Uncovered input defaults to explicit refusal; silence is never consent.`,
    };
  },

  "vendor-active-against-list"(request, params, ruleset) {
    const f = params?.field ?? "vendor";
    const list = resolveList(ruleset, params?.list);
    const raw = fieldOf(request, f);
    const v = typeof raw === "string" ? raw.trim() : "";
    const set = new Set((list ?? []).map((x) => String(x).trim().toLowerCase()));
    if (v.length > 0 && set.has(v.toLowerCase())) {
      return { ok: true, detail: `vendor '${v}' verified active.`, reason: "" };
    }
    return {
      ok: false,
      detail: `vendor '${show(v)}' is not on the active list.`,
      reason: `Vendor '${show(v)}' failed active-vendor verification. Only explicitly listed active vendors may proceed.`,
    };
  },

  "currency-in-supported-set"(request, params, ruleset) {
    const f = params?.field ?? "currency";
    const raw = fieldOf(request, f);
    const text = typeof raw === "string" ? raw : "";
    const cur = text.toUpperCase();
    const supported = (resolveList(ruleset, params?.list) ?? []).map((c) => String(c).toUpperCase());
    if (text.length > 0 && supported.includes(cur)) {
      return { ok: true, detail: `currency '${cur}' is explicitly supported.`, reason: "" };
    }
    const options = supported.length > 0 ? supported.join(", ") : "(none)";
    return {
      ok: false,
      detail: `currency '${show(text)}' is not in the supported set.`,
      reason: `Currency '${show(text)}' is not covered by any live rule (supported: ${options}). Uncovered input defaults to explicit refusal; silence is never consent.`,
    };
  },

  "amount-over-threshold-needs-override"(request, params, ruleset) {
    const af = params?.amount_field ?? "amount";
    const amount = fieldOf(request, af);
    const threshold = resolveThreshold(params, ruleset);
    const over = params?.override_signer;
    const olabel = params?.override_label ?? over;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      return {
        ok: false,
        detail: `${af} missing or not numeric.`,
        reason: `A numeric '${af}' is required to check the threshold; none was provided.`,
      };
    }
    if (typeof threshold !== "number") {
      return {
        ok: false,
        detail: `threshold '${params?.threshold_field}' is not configured as a number.`,
        reason: `Ruleset threshold '${params?.threshold_field}' is not a number; cannot evaluate. Refusing rather than guessing.`,
      };
    }
    if (amount > threshold && !hasSig(request, over)) {
      return {
        ok: false,
        detail: `${af}=${amount} exceeds ${threshold} without override.`,
        reason: `${af} ${amount} exceeds the ${threshold} threshold and no '${olabel}' override signature was provided.`,
      };
    }
    if (amount > threshold) {
      return { ok: true, detail: `${af}=${amount} exceeds ${threshold} with '${olabel}' override present.`, reason: "" };
    }
    return { ok: true, detail: `${af}=${amount} is within the ${threshold} threshold (no override needed).`, reason: "" };
  },

  "date-within-validity"(request, params, ruleset) {
    const df = params?.date_field ?? "date";
    const raw = fieldOf(request, df);
    const win = ruleset?.[params?.window_key] ?? ruleset?.data?.[params?.window_key] ?? null;
    const t = typeof raw === "string" ? Date.parse(raw) : NaN;
    if (typeof raw !== "string" || Number.isNaN(t)) {
      return {
        ok: false,
        detail: `${df} missing or not a valid date.`,
        reason: `A valid '${df}' date is required; '${show(raw)}' cannot be evaluated. Refusing rather than guessing.`,
      };
    }
    const day = new Date(t).toISOString().slice(0, 10);
    if (win?.from && day < win.from) {
      return {
        ok: false,
        detail: `${df}=${raw} is before the validity window.`,
        reason: `'${df}' ${raw} is before the validity window (from ${win.from}).`,
      };
    }
    if (win?.to && day > win.to) {
      return {
        ok: false,
        detail: `${df}=${raw} is after the validity window.`,
        reason: `'${df}' ${raw} is after the validity window (to ${win.to}).`,
      };
    }
    return { ok: true, detail: `${df}=${raw} is within the validity window.`, reason: "" };
  },

  "signature-required-when"(request, params) {
    const wf = params?.when_field;
    const wv = params?.when_value;
    const signer = params?.signer;
    const label = params?.label ?? signer;
    if (fieldOf(request, wf) !== wv) {
      return { ok: true, detail: `condition '${wf}' does not require '${label}' here.`, reason: "" };
    }
    if (hasSig(request, signer)) {
      return { ok: true, detail: `required '${label}' signature present for '${wf}'.`, reason: "" };
    }
    return {
      ok: false,
      detail: `'${wf}' applies and '${label}' signature is missing.`,
      reason: `'${wf}' applies and the required '${label}' signature was not provided.`,
    };
  },

  "require-all"(request, params, ruleset) {
    const checks = Array.isArray(params?.checks) ? params.checks : [];
    for (const c of checks) {
      const fn = evaluators[c?.evaluator_key];
      if (typeof fn !== "function") {
        return {
          ok: false,
          detail: `unknown sub-check '${c?.evaluator_key}'.`,
          reason: `No evaluator is registered for '${c?.evaluator_key}'; refusing rather than guessing.`,
        };
      }
      const r = fn(request, c?.params ?? {}, ruleset);
      if (!r.ok) {
        return { ok: false, detail: r.detail, reason: r.reason };
      }
    }
    return {
      ok: true,
      detail: params?.success_detail ?? `all ${checks.length} required checks satisfied.`,
      reason: "",
    };
  },
};

/**
 * Evaluate an action request against a live signed SOP rule set.
 * @param {import('./types.js').ActionRequest} request
 * @param {import('./types.js').SOPRuleSet} sopRules
 * @returns {import('./types.js').EvaluationResult}
 */
export function evaluateAction(request, sopRules) {
  const req = request ?? {};
  const version = sopRules?.version ?? {};
  const ruleVersionId = version.id ?? "unknown-rule-version";
  const ruleVersionHash = version.version_hash ?? ruleVersionId;
  const sopId = sopRules?.sop_id ?? "unknown-sop";
  const policyTitle = typeof sopRules?.title === "string" && sopRules.title.length > 0
    ? sopRules.title
    : sopId;
  const policyLabel = policyTitle === sopId ? sopId : `${policyTitle} [${sopId}]`;
  const prefix = typeof sopRules?.issue_prefix === "string" && sopRules.issue_prefix.length > 0
    ? sopRules.issue_prefix
    : "ISS-2026";
  const premises = Array.isArray(sopRules?.premises) ? sopRules.premises : [];

  const timestamp = new Date().toISOString();
  const actionId = typeof req.action_id === "string" && req.action_id.length > 0
    ? req.action_id
    : `ACT-${timestamp.replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const actorId = typeof req.actor_id === "string" && req.actor_id.length > 0 ? req.actor_id : "unknown-actor";

  /** @type {string[]} */
  const derivation = [];
  derivation.push(
    `Evaluating action '${actionId}' by actor '${actorId}' under '${sopId}' rule version '${ruleVersionId}' (hash ${ruleVersionHash}).`
  );

  /**
   * Shared policy-issue context for this evaluation.
   * @param {string} premiseId
   * @param {boolean} conflict
   * @returns {import('./types.js').PolicyIssue}
   */
  function makeIssue(premiseId, title, conflict) {
    const { signatures, action_id, action_type, actor_id, ...inputs } = req;
    const sigs = signatures ?? {};
    return {
      id: nextIssueId(prefix),
      title,
      missing_premise: premiseId,
      ...(conflict ? { conflict: true } : {}),
      context: {
        action_id: actionId,
        actor_id: actorId,
        sop_id: sopId,
        rule_version: ruleVersionId,
        inputs,
        signatures_present: Object.keys(sigs).filter((k) => sigs[k] === true),
      },
    };
  }

  /**
   * @param {object} premise
   * @param {{ ok: boolean, detail: string, reason: string }} outcome
   * @returns {import('./types.js').EvaluationResult}
   */
  function refuse(premise, outcome) {
    const chain = [...derivation, `REFUSED at ${premise.id}: ${outcome.reason}`];
    return {
      status: "REFUSED",
      sop_id: sopId,
      policy_title: policyTitle,
      action_id: actionId,
      actor_id: actorId,
      rule_version_hash: ruleVersionHash,
      timestamp,
      derivation: chain,
      derivation_chain: chain,
      refusal_details: {
        missing_premise_id: premise.id,
        reason: outcome.reason,
        policy_issue: makeIssue(premise.id, `Policy refusal — ${policyLabel} — ${premise.id}`, false),
      },
    };
  }

  /**
   * @param {object} premise
   * @param {{ ok: boolean, detail: string, reason: string }} outcome
   * @param {string} signerName
   * @param {string} signerLabel
   * @returns {import('./types.js').EvaluationResult}
   */
  function escalate(premise, outcome, signerName, signerLabel) {
    const reason =
      `Signed-but-unapproved conflict: the '${signerLabel}' signature is present ` +
      `while ${premise.id} is unsatisfied (${outcome.reason}). Requires owner review before execution.`;
    const chain = [...derivation, `ESCALATED at ${premise.id}: ${reason}`];
    return {
      status: "ESCALATED",
      sop_id: sopId,
      policy_title: policyTitle,
      action_id: actionId,
      actor_id: actorId,
      rule_version_hash: ruleVersionHash,
      timestamp,
      derivation: chain,
      derivation_chain: chain,
      escalation_details: {
        conflicting_signature: signerName,
        conflicting_signature_label: signerLabel,
        unsatisfied_premise_id: premise.id,
        reason,
        policy_issue: makeIssue(premise.id, `Policy conflict — ${policyLabel} — '${signerLabel}' signature vs ${premise.id}`, true),
      },
    };
  }

  for (let i = 0; i < premises.length; i += 1) {
    const premise = premises[i] ?? {};
    const premiseId = premise.id ?? `premise-${i + 1}`;
    const key = premise.evaluator_key;
    const fn = evaluators[key];
    /** @type {{ ok: boolean, detail: string, reason: string }} */
    let outcome;
    if (typeof fn !== "function") {
      outcome = {
        ok: false,
        detail: `unknown evaluator '${key}'.`,
        reason: `No evaluator is registered for '${key}' under premise '${premiseId}'; refusing rather than guessing.`,
      };
    } else {
      outcome = fn(req, premise.params ?? {}, sopRules);
    }
    if (outcome.ok) {
      derivation.push(`[${i + 1}/${premises.length}] ${premiseId} satisfied: ${outcome.detail}`);
      continue;
    }
    derivation.push(`[${i + 1}/${premises.length}] Checking ${premiseId} (${key ?? "unknown"}): ${outcome.detail}`);
    const triggers = Array.isArray(premise.escalate_on) ? premise.escalate_on : [];
    const hit = triggers.find((s) => hasSig(req, s));
    if (hit !== undefined) {
      const label = signerLabelFor(sopRules, hit);
      return escalate({ ...premise, id: premiseId }, outcome, hit, label);
    }
    return refuse({ ...premise, id: premiseId }, outcome);
  }

  const authorized = [...derivation, `AUTHORIZED: all premises satisfied under rule version '${ruleVersionId}'.`];
  return {
    status: "AUTHORIZED",
    sop_id: sopId,
    policy_title: policyTitle,
    action_id: actionId,
    actor_id: actorId,
    rule_version_hash: ruleVersionHash,
    timestamp,
    derivation: authorized,
    derivation_chain: authorized,
  };
}

/**
 * Human label for a signer key, resolved from the ruleset's `signers` list.
 * @param {object} sopRules
 * @param {string} key
 * @returns {string}
 */
function signerLabelFor(sopRules, key) {
  const list = Array.isArray(sopRules?.signers) ? sopRules.signers : [];
  const found = list.find((s) => s?.key === key);
  return found?.label ?? key;
}
