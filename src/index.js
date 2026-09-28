/**
 * Entry point for the deterministic SOP policy-enforcer demo CLI.
 * Loads every signed rule set in src/rules/, verifies each file's integrity
 * against BOTH its in-file signature and the ledger anchor, then starts the
 * interactive menu.
 *
 * Fail closed per area, not per estate: an integrity failure in ONE area
 * quarantines that area only. Its cases refuse at load naming the dark area;
 * the other areas load and evaluate normally, and the ledger records both
 * the refusal and the areas that stayed live. Only a broken audit chain, an
 * unreadable rules directory, or every area dark refuses to start at all.
 *
 * Persistent ledger: data/ledger.jsonl (append-only JSONL, one entry per
 * line) is loaded on start and every decision is appended to it. In-memory
 * chain format is identical (seq/prev_hash/hash). That file is local audit
 * data, not source — it is excluded from version control (see .gitignore).
 *
 * LEDGER-ANCHORED INTEGRITY (the edit-both attack):
 * The stored hash sits in the same file it protects, so editing the file AND
 * its hash would pass check (a). The anchor closes that: on the first trusted
 * run, a RULESET_ANCHORED entry (ruleset id + content hash) is appended to
 * the ledger. Afterwards the recomputed hash must match the anchor too.
 * An attacker who edits file+hash still breaks the anchor, and re-anchoring
 * needs the running CLI (refusals exit before any anchor is written).
 *
 * HOW TO RE-SIGN AFTER RULE EDITS (canonicalisation + anchor contract):
 * version.version_hash must equal contentHash() from src/sequence.js, i.e.
 * "sha256:" + SHA-256 hex of the whole file EXCEPT the top-level `version`
 * object (stable key order; file key order does not matter). Recompute per
 * file with e.g.:
 *   node --input-type=module -e "import('./src/sequence.js').then(async (S) => { const fs = await import('node:fs'); for (const f of fs.readdirSync('./src/rules').filter((x) => x.endsWith('.json')).sort()) { const r = JSON.parse(fs.readFileSync('./src/rules/' + f, 'utf8')); console.log(f, S.contentHash(r)); } })"
 * then store each value in that file's version.version_hash. After re-signing
 * you must DELIBERATELY re-anchor: stop the CLI, delete data/ledger.jsonl
 * (this archives nothing — copy it aside first if the history matters), and
 * start once so the fresh run anchors the new hashes. Never re-anchor
 * silently: an unexpected anchor mismatch is evidence of tampering.
 */
import fs from "node:fs";
import { appendDecision, getEntries, importEntries, verifyChain } from "./ledger.js";
import { buildTamperRefusal, INTEGRITY_MEANING, verifyRulesetIntegrity } from "./sequence.js";
import { startCli } from "./cli.js";

const dataDirUrl = new URL("../data/", import.meta.url);
const ledgerUrl = new URL("../data/ledger.jsonl", import.meta.url);
const LEDGER_LABEL = "data/ledger.jsonl";

/**
 * Append one ledger entry to the persistent file (created on first write).
 * @param {import('./types.js').LedgerEntry} entry
 * @returns {void}
 */
function persistEntry(entry) {
  fs.mkdirSync(dataDirUrl, { recursive: true });
  fs.appendFileSync(ledgerUrl, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Persistence hook handed to the CLI: every session decision lands in the file.
 * A failed write warns but never changes the decision itself.
 * @param {import('./types.js').LedgerEntry} entry
 * @returns {void}
 */
function onAppend(entry) {
  try {
    persistEntry(entry);
  } catch (e) {
    console.log(`Warning: could not persist ledger entry seq ${entry.seq} (${e?.message ?? e}).`);
  }
}

/**
 * Print a tamper refusal card, log it to the ledger file, and exit 1. No menu.
 * Used only for estate-level failures (no rules, broken chain, all areas dark).
 * @param {import('./types.js').EvaluationResult} refusal
 * @returns {never}
 */
function refuseStartup(refusal) {
  const entry = appendDecision(refusal);
  try {
    persistEntry(entry);
  } catch (e) {
    console.log(`Warning: could not persist tamper refusal (${e?.message ?? e}).`);
  }
  printRefusalCard(refusal, entry);
  console.log("");
  process.exit(1);
}

/**
 * Print a tamper refusal card with ledger linkage (no exit).
 * @param {import('./types.js').EvaluationResult} refusal
 * @param {import('./types.js').LedgerEntry} entry
 * @returns {void}
 */
function printRefusalCard(refusal, entry) {
  const d = refusal.refusal_details;
  console.log("");
  console.log(`[RULESET TAMPER REFUSAL] Refusing: ${d.policy_issue.context.source}.`);
  console.log(`Expected hash   : ${d.policy_issue.context.stored_hash}`);
  console.log(`Recomputed hash : ${d.policy_issue.context.recomputed_hash}`);
  console.log(`Reason          : ${d.reason}`);
  console.log("");
  console.log("--- GENERATED POLICY ISSUE (REVIEW QUEUE) ---");
  console.log(`Issue ID        : ${d.policy_issue.id}`);
  console.log(`Title           : ${d.policy_issue.title}`);
  console.log(`Missing Premise : ${d.policy_issue.missing_premise}`);
  console.log(`Action Required : Owner must re-sign the ruleset or restore the trusted version.`);
  console.log(`Context         : ${JSON.stringify(d.policy_issue.context)}`);
  console.log("----------------------------------------------");
  console.log(`Ledger block hash : ${entry.hash}`);
  console.log(`Ledger seq ${entry.seq} | prev ${entry.prev_hash}`);
  console.log(`What it means: quiet edits cannot widen spend authority — nothing starts until the trusted version is restored.`);
}

const rulesDirUrl = new URL("./rules/", import.meta.url);
let ruleFiles;
try {
  ruleFiles = fs.readdirSync(rulesDirUrl).filter((f) => f.endsWith(".json")).sort();
} catch (e) {
  console.log(`[RULESET TAMPER REFUSAL] Refusing to start: cannot read rules directory (${e?.message ?? e}).`);
  process.exit(1);
}

if (ruleFiles.length === 0) {
  console.log("[RULESET TAMPER REFUSAL] Refusing to start: no signed rulesets found in src/rules/.");
  process.exit(1);
}

// --- Persistent ledger load: import, then verify the chain before trusting it.
let freshLedger = true;
try {
  if (fs.existsSync(ledgerUrl)) {
    freshLedger = false;
    const lines = fs.readFileSync(ledgerUrl, "utf8").split("\n").filter((l) => l.trim().length > 0);
    importEntries(lines.map((l) => JSON.parse(l)));
    const chain = verifyChain();
    if (!chain.ok) {
      refuseStartup(buildTamperRefusal({
        sourceLabel: LEDGER_LABEL,
        rules: null,
        recomputedHex: "(not computed — chain broken)",
        issuePrefix: "ISS-2026",
        reason: `Audit chain failure in '${LEDGER_LABEL}': entry seq ${chain.failedAt} does not chain to its predecessor. ` +
          `The ledger file may have been edited. Refusing to proceed with untrusted history.`,
        extraContext: { file: LEDGER_LABEL, failed_at_seq: chain.failedAt },
      }));
    }
  }
} catch (e) {
  refuseStartup(buildTamperRefusal({
    sourceLabel: LEDGER_LABEL,
    rules: null,
    recomputedHex: "(not computed — ledger unreadable)",
    issuePrefix: "ISS-2026",
    reason: `Audit ledger failure: '${LEDGER_LABEL}' cannot be loaded (${e?.message ?? e}). Refusing to proceed with untrusted history.`,
    extraContext: { file: LEDGER_LABEL },
  }));
}

/**
 * Quarantine one failed area: log the refusal, print a one-line dark notice,
 * and keep the area description for the menu (its cases refuse on attempt).
 * @param {{ file: string, rules: import('./types.js').SOPRuleSet | null, shortReason: string, refusal: import('./types.js').EvaluationResult }} q
 * @returns {{ file: string, rules: import('./types.js').SOPRuleSet | null, live: false, shortReason: string, refusal: import('./types.js').EvaluationResult, entrySeq: number }}
 */
function quarantineArea(q) {
  const entry = appendDecision(q.refusal);
  onAppend(entry);
  const label = q.rules ? `${q.rules.title} [${q.rules.sop_id}]` : q.file;
  console.log(`[AREA DARK] ${q.file} — ${label}: refused at load (RULESET_INTEGRITY): ${q.shortReason} Logged as ledger seq ${entry.seq}.`);
  console.log(`What it means: ${INTEGRITY_MEANING}`);
  return {
    file: q.file,
    rules: q.rules,
    live: false,
    shortReason: q.shortReason,
    refusal: q.refusal,
    entrySeq: entry.seq,
  };
}

/** @type {{ file: string, rules: import('./types.js').SOPRuleSet | null, live: boolean, shortReason?: string, refusal?: import('./types.js').EvaluationResult, entrySeq?: number }[]} */
const policies = [];
for (const file of ruleFiles) {
  let rules = null;
  try {
    rules = JSON.parse(fs.readFileSync(new URL(`./rules/${file}`, import.meta.url), "utf8"));
  } catch (e) {
    policies.push(quarantineArea({
      file,
      rules: null,
      shortReason: "file is not valid JSON and cannot be trusted",
      refusal: buildTamperRefusal({
        sourceLabel: file,
        rules: null,
        recomputedHex: `(unparseable: ${e?.message ?? e})`,
        issuePrefix: "ISS-2026",
        extraContext: { file },
      }),
    }));
    continue;
  }
  const check = verifyRulesetIntegrity(rules);
  if (!check.ok) {
    policies.push(quarantineArea({
      file,
      rules,
      shortReason: "stored signature does not match recomputed content",
      refusal: buildTamperRefusal({
        sourceLabel: file,
        rules,
        recomputedHex: check.recomputed,
        extraContext: { file },
      }),
    }));
    continue;
  }
  const anchored = getEntries().find((e) => e?.kind === "RULESET_ANCHORED" && e?.sop_id === rules.sop_id);
  if (anchored) {
    const anchoredHex = String(anchored.rule_version_hash).startsWith("sha256:")
      ? String(anchored.rule_version_hash).slice("sha256:".length)
      : String(anchored.rule_version_hash);
    if (anchoredHex !== check.recomputed) {
      policies.push(quarantineArea({
        file,
        rules,
        shortReason: "content matches in-file signature but not the ledger anchor",
        refusal: buildTamperRefusal({
          sourceLabel: file,
          rules,
          recomputedHex: check.recomputed,
          reason: `Anchor mismatch for '${file}': the content hash matches the in-file signature but not the ledger anchor ` +
            `(recomputed sha256:${check.recomputed}; anchored ${anchored.rule_version_hash}). ` +
            `The file and its stored hash were both changed after anchoring. Deliberate re-anchoring is required (see index.js header).`,
          extraContext: { file, anchored_hash: anchored.rule_version_hash },
        }),
      }));
      continue;
    }
    policies.push({ file, rules, live: true });
    continue;
  }
  const timestamp = new Date().toISOString();
  const derivation = [
    `RULESET_ANCHORED ${rules.sop_id} (${file}) version ${rules.version.id} content hash sha256:${check.recomputed} recorded.`,
  ];
  const anchor = {
    status: "ANCHORED",
    kind: "RULESET_ANCHORED",
    sop_id: rules.sop_id,
    action_id: `RULESET-ANCHORED-${rules.sop_id}`,
    actor_id: "system",
    rule_version_hash: `sha256:${check.recomputed}`,
    timestamp,
    derivation,
    derivation_chain: derivation,
  };
  const entry = appendDecision(anchor);
  onAppend(entry);
  console.log(`anchored ${rules.sop_id} (${file}) @ sha256:${check.recomputed}`);
  policies.push({ file, rules, live: true });
}

const livePolicies = policies.filter((p) => p.live);
const darkPolicies = policies.filter((p) => !p.live);

if (livePolicies.length === 0) {
  console.log(`[RULESET TAMPER REFUSAL] Refusing to start: every policy area is dark (${darkPolicies.map((p) => p.file).join(", ")}). Refusals logged above.`);
  process.exit(1);
}

if (darkPolicies.length > 0) {
  const timestamp = new Date().toISOString();
  const derivation = [
    `POLICYSET_LIVE: live areas [${livePolicies.map((p) => p.rules.sop_id).join(", ")}]; dark areas [${darkPolicies.map((p) => (p.rules ? p.rules.sop_id : p.file)).join(", ")}].`,
  ];
  const notice = {
    status: "NOTICE",
    kind: "POLICYSET_LIVE",
    action_id: "POLICYSET-LIVE",
    actor_id: "system",
    rule_version_hash: "ledger",
    timestamp,
    derivation,
    derivation_chain: derivation,
  };
  const entry = appendDecision(notice);
  onAppend(entry);
  console.log(`Live areas: ${livePolicies.map((p) => p.rules.sop_id).join(", ")} | Dark areas: ${darkPolicies.map((p) => (p.rules ? p.rules.sop_id : p.file)).join(", ")} (ledger seq ${entry.seq}).`);
}

if (freshLedger && darkPolicies.length === 0) {
  console.log(`ledger ${LEDGER_LABEL} created; all ${policies.length} rulesets anchored.`);
}

await startCli(policies, { onAppend });
