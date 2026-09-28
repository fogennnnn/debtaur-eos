/**
 * Zero-dependency static file server (node:http only) for the browser demo.
 * Serves the project root so a page can `import ... from "/src/engine.js"`
 * (file:// pages block module loading, so serve over http instead).
 * No build step: run `npm run demo`, then open the printed URL.
 * Serves files only — dotfiles, traversal escapes and directories without an
 * index.html get a refusal, never a listing of anything outside the root.
 *
 * Minimal demo API (same data the CLI trusts, read fresh per request):
 *   GET /api/integrity — per-ruleset hash + ledger-anchor status.
 *   GET /api/sequence  — the guided sequence definition plus the rulesets'
 *                        public content, so the frontend runs the same
 *                        sequence client-side with the engine modules.
 * No evaluate endpoint: browsers run src/engine.js locally.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SEQUENCE, verifyRulesetIntegrity } from "./sequence.js";
import { importEntries, verifyChain } from "./ledger.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/integrity" || url.pathname === "/api/sequence") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "method not allowed; use GET" }));
        return;
      }
      try {
        const payload = url.pathname === "/api/integrity" ? integrityPayload() : sequencePayload();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `api failure: ${e?.message ?? e}` }));
      }
      return;
    }
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
    const abs = path.join(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    if (path.basename(abs).startsWith(".")) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (_e) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    let target = abs;
    if (stat.isDirectory()) {
      const indexFile = path.join(abs, "index.html");
      try {
        if (fs.statSync(indexFile).isFile()) {
          target = indexFile;
        } else {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("no index here — request a file path directly");
          return;
        }
      } catch (_e) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("no index here — request a file path directly");
        return;
      }
    }
    const ext = path.extname(target).toLowerCase();
    const body = fs.readFileSync(target);
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`server error: ${e?.message ?? e}`);
  }
});

/**
 * Read all ruleset files (parsed). Throws on unreadable content.
 * @returns {{ file: string, rules: object }[]}
 */
function readRulesets() {
  const dir = path.join(root, "src", "rules");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((file) => ({
    file,
    rules: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")),
  }));
}

/**
 * Read the persistent ledger file, if present.
 * @returns {{ exists: boolean, entries: object[] }}
 */
function readLedgerFile() {
  const p = path.join(root, "data", "ledger.jsonl");
  if (!fs.existsSync(p)) {
    return { exists: false, entries: [] };
  }
  const lines = fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0);
  return { exists: true, entries: lines.map((l) => JSON.parse(l)) };
}

/**
 * Per-ruleset hash + anchor status plus ledger chain health.
 * @returns {object}
 */
function integrityPayload() {
  const rulesets = readRulesets();
  const ledger = readLedgerFile();
  let chainOk = true;
  let chainError = null;
  try {
    importEntries(ledger.entries);
    const v = verifyChain();
    chainOk = v.ok;
    if (!v.ok) {
      chainError = `broken at seq ${v.failedAt}`;
    }
  } catch (e) {
    chainOk = false;
    chainError = e?.message ?? String(e);
  }
  const rows = rulesets.map(({ file, rules }) => {
    const check = verifyRulesetIntegrity(rules);
    const anchored = ledger.entries.find((e) => e?.kind === "RULESET_ANCHORED" && e?.sop_id === rules.sop_id) ?? null;
    const anchoredHash = anchored ? String(anchored.rule_version_hash) : null;
    const norm = (h) => (h.startsWith("sha256:") ? h.slice("sha256:".length) : h);
    const anchorMatch = anchoredHash === null ? null : norm(anchoredHash) === check.recomputed;
    const ok = check.ok && chainOk && anchorMatch !== false;
    return {
      file,
      sop_id: rules.sop_id,
      title: rules.title,
      version: rules.version?.id ?? null,
      stored_hash: String(rules.version?.version_hash ?? "(missing)"),
      recomputed_hash: `sha256:${check.recomputed}`,
      hash_match: check.ok,
      anchored_hash: anchoredHash,
      anchor_match: anchorMatch,
      ok,
    };
  });
  return {
    ok: chainOk && rows.every((r) => r.ok),
    ledger: {
      path: "data/ledger.jsonl",
      exists: ledger.exists,
      entries: ledger.entries.length,
      chain_ok: chainOk,
      chain_error: chainError,
    },
    rulesets: rows,
  };
}

/**
 * Guided sequence definition plus the rulesets' public content.
 * @returns {object}
 */
function sequencePayload() {
  const byFile = {};
  for (const { file, rules } of readRulesets()) {
    byFile[file] = rules;
  }
  return { sequence: SEQUENCE, rulesets: byFile };
}

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => {
  console.log(`demo server: http://localhost:${port}/ (root ${root})`);
  console.log("Designer entry points: /src/engine.js and /src/ledger.js (import directly, no build).");
  console.log("Demo API: GET /api/integrity, GET /api/sequence.");
});
