/**
 * Interactive CLI menu loop for the deterministic multi-policy enforcer.
 * Zero dependencies: uses only node:readline.
 * Demos and live evaluation are driven by the loaded ruleset JSON files —
 * adding a new file to src/rules/ adds it to the menu automatically.
 * All user-facing strings are methodology-neutral ("policy enforcer",
 * "policy issue card").
 */
import readline from "node:readline";
import { evaluateAction } from "./engine.js";
import { appendDecision, getEntries, verifyChain } from "./ledger.js";
import { INTEGRITY_MEANING, SEQUENCE, runSequence } from "./sequence.js";

/**
 * One honest line about whose policy is on stage. Printed once at opening
 * and once at close — never multiplied.
 */
const DEMO_NOTE =
  "Note: the policies shown are authored for demonstration; in a live engagement the client's own process replaces them.";

/**
 * Policy display pairing the client-words name with its code; the code never
 * headlines a moment on its own.
 * @param {import('./types.js').EvaluationResult} result
 * @returns {string}
 */
function policyLine(result) {
  const t = result.policy_title;
  return t && t !== result.sop_id ? `${t} [${result.sop_id}]` : `${result.sop_id}`;
}

const GREEN = "\x1b[1;32m";
const RED = "\x1b[1;31m";
const YELLOW = "\x1b[1;33m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let runCounter = 0;

/**
 * Persistence hook set by startCli (index.js hands down a file appender).
 * Every appended decision is offered to it; failures warn, never alter results.
 * @type {((entry: import('./types.js').LedgerEntry) => void) | null}
 */
let persistHook = null;

/**
 * @param {import('./types.js').LedgerEntry} entry
 * @returns {void}
 */
function persist(entry) {
  if (persistHook) {
    try {
      persistHook(entry);
    } catch (e) {
      console.log(`Warning: could not persist ledger entry seq ${entry.seq} (${e?.message ?? e}).`);
    }
  }
}

function nextActionId(prefix) {
  runCounter += 1;
  return `${prefix}-${String(runCounter).padStart(3, "0")}`;
}

/**
 * Create a prompt helper backed by a line queue so piped / redirected
 * stdin (menu choices sent ahead) is never dropped. Prompts are written
 * directly; answers come from 'line' events in arrival order.
 * @param {readline.Interface} rl
 * @returns {{ ask: (prompt: string) => Promise<string | null>, isClosed: () => boolean }}
 */
function createPrompter(rl) {
  /** @type {string[]} */
  const queue = [];
  let closed = false;
  /** @type {((line: string | null) => void) | null} */
  let waiter = null;
  rl.on("line", (line) => {
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      queue.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  return {
    /**
     * @param {string} prompt
     * @returns {Promise<string | null>} answer line, or null on EOF.
     */
    ask(prompt) {
      process.stdout.write(prompt);
      if (queue.length > 0) {
        return Promise.resolve(queue.shift());
      }
      if (closed || rl.closed) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    isClosed() {
      return (closed || rl.closed) && queue.length === 0 && waiter === null;
    },
  };
}

/**
 * Parse a y/n answer.
 * @param {string | null} raw
 * @returns {boolean}
 */
function parseYesNo(raw) {
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  return v === "y" || v === "yes";
}

/**
 * Print an evaluation result with ledger linkage.
 * @param {import('./types.js').EvaluationResult} result
 * @param {import('./types.js').LedgerEntry} entry
 * @returns {void}
 */
function printResult(result, entry) {
  console.log("");
  if (result.status === "AUTHORIZED") {
    console.log(`${GREEN}${BOLD}[AUTHORIZED]${RESET} Action ${result.action_id} approved.`);
    console.log(`Policy            : ${policyLine(result)}`);
    console.log(`Rule version hash : ${result.rule_version_hash}`);
    console.log(`Actor             : ${result.actor_id}`);
    console.log(`Evaluated at      : ${result.timestamp}`);
    console.log("Derivation path   :");
    for (const line of result.derivation) {
      console.log(`  - ${line}`);
    }
    console.log(`Ledger block hash : ${entry.hash}`);
    console.log(`${DIM}Ledger seq ${entry.seq} | prev ${entry.prev_hash}${RESET}`);
  } else if (result.status === "ESCALATED") {
    const d = result.escalation_details;
    console.log(`${YELLOW}${BOLD}[ESCALATED]${RESET} Action ${result.action_id} needs owner review.`);
    console.log(`Policy                : ${policyLine(result)}`);
    console.log(`Conflicting signature : ${d.conflicting_signature_label} ('${d.conflicting_signature}', present)`);
    console.log(`Unsatisfied premise   : ${d.unsatisfied_premise_id}`);
    console.log(`Rule version          : ${result.rule_version_hash}`);
    console.log(`Reason                : ${d.reason}`);
    console.log("Derivation path   :");
    for (const line of result.derivation) {
      console.log(`  - ${line}`);
    }
    console.log("");
    console.log("--- GENERATED POLICY ISSUE (REVIEW QUEUE) ---");
    console.log(`Issue ID        : ${d.policy_issue.id}`);
    console.log(`Title           : ${d.policy_issue.title}`);
    console.log(`Missing Premise : ${d.policy_issue.missing_premise}`);
    console.log(`Conflict        : true (signed but unapproved)`);
    console.log(`Action Required : Owner must review the signed-but-unapproved conflict before execution.`);
    console.log(`Context         : ${JSON.stringify(d.policy_issue.context)}`);
    console.log("----------------------------------------------");
    console.log(`Ledger block hash : ${entry.hash}`);
    console.log(`${DIM}Ledger seq ${entry.seq} | prev ${entry.prev_hash}${RESET}`);
  } else {
    const d = result.refusal_details;
    console.log(`${RED}${BOLD}[REFUSED]${RESET} Action ${result.action_id} blocked.`);
    console.log(`Policy            : ${policyLine(result)}`);
    console.log(`Violated premise  : ${d.missing_premise_id}`);
    console.log(`Rule version      : ${result.rule_version_hash}`);
    console.log(`Reason            : ${d.reason}`);
    console.log("Derivation path   :");
    for (const line of result.derivation) {
      console.log(`  - ${line}`);
    }
    console.log("");
    console.log("--- GENERATED POLICY ISSUE (REVIEW QUEUE) ---");
    console.log(`Issue ID        : ${d.policy_issue.id}`);
    console.log(`Title           : ${d.policy_issue.title}`);
    console.log(`Missing Premise : ${d.policy_issue.missing_premise}`);
    console.log(`Action Required : Owner must provide the missing premise or update the rule version.`);
    if (d.missing_premise_id === "RULESET_INTEGRITY") {
      console.log(`What it means     : ${INTEGRITY_MEANING}`);
    }
    console.log(`Context         : ${JSON.stringify(d.policy_issue.context)}`);
    console.log("----------------------------------------------");
    console.log(`Ledger block hash : ${entry.hash}`);
    console.log(`${DIM}Ledger seq ${entry.seq} | prev ${entry.prev_hash}${RESET}`);
  }
  console.log("");
}

/**
 * Evaluate a request, append to ledger, and print.
 * @param {import('./types.js').SOPRuleSet} sopRules
 * @param {import('./types.js').ActionRequest} request
 * @returns {import('./types.js').EvaluationResult}
 */
function evaluateAndPrint(sopRules, request) {
  const result = evaluateAction(request, sopRules);
  const entry = appendDecision(result, request);
  persist(entry);
  printResult(result, entry);
  return result;
}

/**
 * Scripted demo runs per policy: a baseline plus the silent case the paper
 * process misses. Each run is { label, request }.
 * @param {import('./types.js').SOPRuleSet} rules
 * @returns {{ label: string, request: import('./types.js').ActionRequest }[] | null}
 */
function demoRequests(rules) {
  switch (rules.sop_id) {
    case "SOP-FIN-01":
      return [
        {
          label: "Baseline: $7,500 with all signatures (approved)",
          request: {
            action_id: nextActionId("ACT-FIN-BASE"),
            action_type: "execute-payout",
            actor_id: "dept-head-01",
            amount: 7500,
            currency: "USD",
            vendor: "Acme Supplies",
            signatures: { dept_head: true, ceo: false, finance: true },
          },
        },
        {
          label: "Silent case: $25,000 payout signed with no owner override (escalated, not passed)",
          request: {
            action_id: nextActionId("ACT-FIN-SILENT"),
            action_type: "execute-payout",
            actor_id: "dept-head-01",
            amount: 25000,
            currency: "USD",
            vendor: "Acme Supplies",
            signatures: { dept_head: true, ceo: false, finance: true },
          },
        },
      ];
    case "SOP-ONB-01":
      return [
        {
          label: "Baseline: clean intake with partner approval (approved)",
          request: {
            action_id: nextActionId("ACT-ONB-BASE"),
            action_type: "accept-client",
            actor_id: "intake-01",
            client_name: "Blue Lantern Co.",
            identity_status: "verified",
            credit_status: "pass",
            sanctions_status: "clear",
            prior_rejection: false,
            signatures: { approver: true, onboarding: true },
          },
        },
        {
          label: "Silent case: previously rejected client re-engaged with a fresh approval (escalated, not a fresh intake)",
          request: {
            action_id: nextActionId("ACT-ONB-SILENT"),
            action_type: "accept-client",
            actor_id: "intake-01",
            client_name: "Harbor & Grey Ltd",
            identity_status: "verified",
            credit_status: "pass",
            sanctions_status: "clear",
            prior_rejection: true,
            signatures: { approver: true, onboarding: true },
          },
        },
      ];
    case "SOP-HIRE-01":
      return [
        {
          label: "Baseline: first hire inside the window and under the threshold (approved)",
          request: {
            action_id: nextActionId("ACT-HIRE-BASE"),
            action_type: "issue-offer",
            actor_id: "hiring-manager-01",
            candidate_name: "Jordan Ellis",
            role_type: "employee",
            compensation: 95000,
            offer_date: "2026-06-15",
            is_renewal: false,
            signatures: { hiring_manager: true, director: false, reapprover: false, hr: true },
          },
        },
        {
          label: "Silent case: contractor renewal with no fresh re-approval (refused)",
          request: {
            action_id: nextActionId("ACT-HIRE-SILENT"),
            action_type: "issue-offer",
            actor_id: "hiring-manager-01",
            candidate_name: "Sam Rivera",
            role_type: "contractor",
            compensation: 90000,
            offer_date: "2026-06-15",
            is_renewal: true,
            signatures: { hiring_manager: true, director: false, reapprover: false, hr: true },
          },
        },
      ];
    case "SOP-PAY-01":
      return [
        {
          label: "Baseline: active vendor with approval and payer (approved)",
          request: {
            action_id: nextActionId("ACT-PAY-BASE"),
            action_type: "release-payment",
            actor_id: "buyer-01",
            vendor: "Acme Supplies",
            amount: 4000,
            currency: "USD",
            signatures: { approver: true, controller: false, payer: true },
          },
        },
        {
          label: "Silent case: vendor deactivated after approval, payer signed anyway (escalated at payout)",
          request: {
            action_id: nextActionId("ACT-PAY-SILENT"),
            action_type: "release-payment",
            actor_id: "buyer-01",
            vendor: "Harbor Parts Co.",
            amount: 4000,
            currency: "USD",
            signatures: { approver: true, controller: false, payer: true },
          },
        },
      ];
    default:
      return null;
  }
}

/**
 * Run the scripted demo for one policy. A dark (quarantined) policy refuses
 * on attempt with its recorded load-time refusal — no cases are evaluated.
 * @param {{ file: string, rules: import('./types.js').SOPRuleSet | null, live: boolean, shortReason?: string, refusal?: import('./types.js').EvaluationResult, entrySeq?: number }} policy
 * @returns {void}
 */
function runDemo(policy) {
  const rules = policy.rules;
  if (!policy.live || !rules) {
    const title = rules ? `${rules.title} [${rules.sop_id}]` : policy.file;
    console.log(`\n[REFUSED] ${title} is dark — refused at load, no cases evaluated.`);
    console.log(`Violated premise  : RULESET_INTEGRITY`);
    console.log(`Reason            : ${policy.shortReason ?? "policy failed its load-time integrity check"}`);
    console.log(`What it means     : ${INTEGRITY_MEANING}`);
    if (policy.refusal) {
      console.log(`Policy issue      : ${policy.refusal.refusal_details.policy_issue.id} (logged at load as ledger seq ${policy.entrySeq})`);
    }
    console.log("");
    return;
  }
  console.log(`\nDemo: ${rules.title} [${rules.sop_id}]`);
  console.log(`Situation: ${rules.demo_story}`);
  const runs = demoRequests(rules);
  if (!runs) {
    console.log("(no scripted demo for this policy yet — use live evaluation)");
    return;
  }
  for (const run of runs) {
    console.log(`\n-- ${run.label}`);
    evaluateAndPrint(rules, run.request);
  }
}

/**
 * Convert a raw live-mode answer into a field value per input type.
 * @param {{ key: string, type: string, choices?: string[], default?: string }} spec
 * @param {string} raw
 * @returns {unknown}
 */
function coerceField(spec, raw) {
  const text = raw.trim();
  switch (spec.type) {
    case "amount": {
      return Number(text);
    }
    case "yesno": {
      return parseYesNo(text);
    }
    case "date": {
      if (text === "" && spec.default === "today") {
        return new Date().toISOString().slice(0, 10);
      }
      return text === "" ? (spec.default ?? "") : text;
    }
    case "choice": {
      const choices = Array.isArray(spec.choices) ? spec.choices : [];
      const hit = choices.find((c) => c.toLowerCase() === text.toLowerCase());
      return hit ?? text;
    }
    default: {
      if (text === "" && spec.default !== undefined) {
        return spec.default;
      }
      return text;
    }
  }
}

/**
 * Live evaluation mode for one ruleset: prompts are generated from the
 * ruleset's own `input_fields` and `signers`, so no per-policy CLI code.
 * @param {(prompt: string) => Promise<string | null>} ask
 * @param {import('./types.js').SOPRuleSet} rules
 * @returns {Promise<void>}
 */
async function runLiveMode(ask, rules) {
  console.log(`\nLive Evaluation Mode — ${rules.title} [${rules.sop_id}]`);
  /** @type {Record<string, unknown>} */
  const fields = {};
  const inputFields = Array.isArray(rules.input_fields) ? rules.input_fields : [];
  for (const spec of inputFields) {
    let hint = "";
    if (spec.type === "choice" && Array.isArray(spec.choices)) {
      hint = ` (${spec.choices.join(" / ")})`;
    } else if (spec.type === "yesno") {
      hint = " (y/n)";
    } else if (spec.default !== undefined) {
      hint = ` [default: ${spec.default === "today" ? "today" : spec.default}]`;
    }
    const raw = await ask(`${spec.label}${hint}: `);
    if (raw === null) return;
    fields[spec.key] = coerceField(spec, raw);
  }
  /** @type {Record<string, boolean>} */
  const signatures = {};
  const signers = Array.isArray(rules.signers) ? rules.signers : [];
  for (const s of signers) {
    const raw = await ask(`Include '${s.label}' signature? (y/n): `);
    if (raw === null) return;
    signatures[s.key] = parseYesNo(raw);
  }
  evaluateAndPrint(rules, {
    action_id: nextActionId("ACT-LIVE"),
    action_type: "live-evaluation",
    actor_id: "live-operator",
    ...fields,
    signatures,
  });
}

/**
 * Run the guided four-outcome sequence with pauses between steps.
 * @param {(prompt: string) => Promise<string | null>} ask
 * @param {() => boolean} isClosed
 * @param {{ file: string, rules: import('./types.js').SOPRuleSet | null, live: boolean, shortReason?: string }[]} policies
 * @returns {Promise<void>}
 */
async function runGuidedSequence(ask, isClosed, policies) {
  const found = policies.find((r) => r.rules && r.rules.sop_id === SEQUENCE.sop_id);
  if (!found || !found.live) {
    console.log(`Guided sequence needs the spend policy [${SEQUENCE.sop_id}], which is dark (refused at load: ${found?.shortReason ?? "not loaded"}). Restore the trusted version to run it.`);
    return;
  }
  console.log(`\nGuided sequence: ${SEQUENCE.title} [${SEQUENCE.id}]`);
  const out = runSequence(found.rules, { onEntry: persist });
  for (let i = 0; i < out.results.length; i += 1) {
    const r = out.results[i];
    for (const line of r.lines) {
      console.log(line);
    }
    printResult(r.result, r.entry);
    if (i < out.results.length - 1) {
      const p = await ask("Press Enter for the next step... ");
      if (p === null || isClosed()) {
        break;
      }
    }
  }
  if (out.allPass) {
    console.log("Guided sequence complete: all four outcomes as expected.\n");
  } else {
    console.log("Guided sequence complete: SOME STEPS DID NOT MATCH — see FAIL above.\n");
  }
}

/**
 * Let the operator pick one of the live policies (dark areas cannot evaluate).
 * @param {(prompt: string) => Promise<string | null>} ask
 * @param {{ file: string, rules: import('./types.js').SOPRuleSet | null, live: boolean }[]} policies
 * @returns {Promise<import('./types.js').SOPRuleSet | null>}
 */
async function pickRuleset(ask, policies) {
  const live = policies.filter((p) => p.live && p.rules);
  console.log("\nChoose a policy:");
  live.forEach((r, i) => {
    console.log(`  [${i + 1}] ${r.rules.title} [${r.rules.sop_id}]`);
  });
  const raw = await ask(`Select policy [1-${live.length}]: `);
  if (raw === null) return null;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > live.length) {
    console.log(`Unknown policy '${raw.trim()}'.`);
    return null;
  }
  return live[n - 1].rules;
}

function viewLedger() {
  const entries = getEntries();
  console.log("\n--- HASH-CHAINED AUDIT LEDGER ---");
  if (entries.length === 0) {
    console.log("(ledger is empty — run a demo first)");
  }
  for (const e of entries) {
    console.log(`seq=${e.seq} status=${e.status} action=${e.action_id} actor=${e.actor_id}`);
    console.log(`  rule_hash=${e.rule_version_hash}`);
    console.log(`  prev_hash=${e.prev_hash}`);
    console.log(`  hash     =${e.hash}`);
  }
  const v = verifyChain();
  if (v.ok) {
    console.log(`Chain verification: OK (${v.checked} entr${v.checked === 1 ? "y" : "ies"} chained)`);
  } else {
    console.log(`Chain verification: FAILED at seq ${v.failedAt}`);
  }
  console.log("---------------------------------\n");
}

/**
 * @param {{ file: string, rules: import('./types.js').SOPRuleSet | null, live: boolean }[]} policies
 * @returns {void}
 */
function printMenu(policies) {
  console.log("==================================================");
  console.log("  DEBTAUR POLICY ENFORCER | DEMO CLI");
  console.log("==================================================");
  const demoPolicies = policies.filter((p) => p.rules);
  demoPolicies.forEach((p, i) => {
    const mark = p.live ? "" : " (DARK — refused at load)";
    console.log(`[${i + 1}] Demo: ${p.rules.title}${mark}`);
  });
  const seqOpt = demoPolicies.length + 1;
  const liveOpt = demoPolicies.length + 2;
  const ledgerOpt = demoPolicies.length + 3;
  const exitOpt = demoPolicies.length + 4;
  console.log(`[${seqOpt}] Guided sequence: ${SEQUENCE.title}`);
  console.log(`[${liveOpt}] Live Evaluation Mode (choose a policy, enter values)`);
  console.log(`[${ledgerOpt}] View Hash-Chained Audit Ledger`);
  console.log(`[${exitOpt}] Exit`);
  return demoPolicies;
}

/**
 * Start the interactive menu loop. Resolves when the user exits or stdin ends.
 * @param {{ file: string, rules: import('./types.js').SOPRuleSet | null, live: boolean, shortReason?: string, refusal?: import('./types.js').EvaluationResult, entrySeq?: number }[]} policies
 * @param {{ onAppend?: (entry: import('./types.js').LedgerEntry) => void }} [options]
 * @returns {Promise<void>}
 */
export async function startCli(policies, options = {}) {
  persistHook = typeof options?.onAppend === "function" ? options.onAppend : null;
  console.log(`\n${DEMO_NOTE}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const { ask, isClosed } = createPrompter(rl);
  const demoPolicies = policies.filter((p) => p.rules);
  const seqOpt = String(demoPolicies.length + 1);
  const liveOpt = String(demoPolicies.length + 2);
  const ledgerOpt = String(demoPolicies.length + 3);
  const exitOpt = String(demoPolicies.length + 4);

  while (true) {
    printMenu(policies);
    const choice = await ask(`Select option [1-${exitOpt}]: `);
    if (choice === null || isClosed()) {
      break;
    }
    const opt = choice.trim();
    const demoIndex = Number(opt);
    if (Number.isInteger(demoIndex) && demoIndex >= 1 && demoIndex <= demoPolicies.length) {
      runDemo(demoPolicies[demoIndex - 1]);
    } else if (opt === seqOpt) {
      await runGuidedSequence(ask, isClosed, policies);
      if (isClosed()) break;
    } else if (opt === liveOpt) {
      const rules = await pickRuleset(ask, policies);
      if (rawNull(rules)) {
        if (isClosed()) break;
        continue;
      }
      await runLiveMode(ask, rules);
      if (isClosed()) break;
    } else if (opt === ledgerOpt) {
      viewLedger();
    } else if (opt === exitOpt) {
      break;
    } else {
      console.log(`Unknown option '${opt}'. Please select 1-${exitOpt}.\n`);
    }
  }

  if (!rl.closed) {
    rl.close();
  }
  console.log(`\n${DEMO_NOTE}`);
  console.log("Goodbye.");
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function rawNull(v) {
  return v === null || v === undefined;
}
