/**
 * Hosted demo worker for debtaur-eos (overwrites the testworker slot).
 * Serves the static guided-run page plus two read-only JSON endpoints that
 * mirror the local `npm run demo` API shape:
 *   GET /api/sequence  — guided SEQUENCE definition + rulesets' content
 *   GET /api/integrity — per-ruleset signature match (recomputed vs stored).
 * No ledger anchor exists in hosting (no persistent office file): anchor
 * fields are returned as null and the page renders that honestly as
 * "signature matches (demo hosting)" / "not yet anchored". No evaluate
 * endpoint — browsers run src/engine.js locally. No Durable Objects, no KV.
 */
import SEQ from "./sequence.json";

const RULE_FILES = [
  "client-onboarding.json",
  "expense-signoff.json",
  "hiring-approval.json",
  "vendor-payment.json",
];

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function canonicalRulesetContent(rules) {
  const { version, ...rest } = rules ?? {};
  void version;
  return stableStringify(rest);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const norm = (h) => String(h).replace(/^sha256:/, "");

async function loadRules(env, req) {
  const out = {};
  for (const f of RULE_FILES) {
    const res = await env.ASSETS.fetch(new URL(`/src/rules/${f}`, req.url));
    if (!res.ok) throw new Error(`missing bundled ruleset ${f}`);
    out[f] = await res.json();
  }
  return out;
}

async function integrityPayload(env, req) {
  const byFile = await loadRules(env, req);
  const rows = await Promise.all(
    Object.entries(byFile).map(async ([file, rules]) => {
      const recomputed = await sha256Hex(canonicalRulesetContent(rules));
      const stored = String(rules?.version?.version_hash ?? "");
      const match = stored !== "" && norm(stored) === recomputed;
      return {
        file,
        sop_id: rules.sop_id,
        title: rules.title,
        version: rules?.version?.id ?? null,
        stored_hash: stored || "(missing)",
        recomputed_hash: `sha256:${recomputed}`,
        hash_match: match,
        anchored_hash: null,
        anchor_match: null,
        ok: match,
      };
    })
  );
  return {
    ok: rows.every((r) => r.ok),
    ledger: { path: "demo hosting (ephemeral, no office file)", exists: false, entries: 0, chain_ok: true, chain_error: null },
    rulesets: rows,
  };
}

function sequencePayload(byFile) {
  return { sequence: SEQ.sequence, rulesets: byFile };
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/sequence" || url.pathname === "/api/integrity") {
      if (req.method !== "GET") {
        return new Response(JSON.stringify({ error: "method not allowed; use GET" }), { status: 405, headers: JSON_HEADERS });
      }
      try {
        const payload =
          url.pathname === "/api/sequence" ? sequencePayload(await loadRules(env, req)) : await integrityPayload(env, req);
        return new Response(JSON.stringify(payload), { headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: `api failure: ${e?.message ?? e}` }), { status: 500, headers: JSON_HEADERS });
      }
    }
    return env.ASSETS.fetch(req);
  },
};
