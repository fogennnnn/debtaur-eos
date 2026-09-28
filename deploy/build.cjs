// Build the Cloudflare Worker deploy bundle for the debtaur-eos browser demo.
// Copies the page + browser-safe modules + rulesets into deploy/public/ and
// snapshots the guided SEQUENCE definition into deploy/sequence.json (consumed
// by deploy/worker.js for GET /api/sequence). Run: node deploy/build.cjs
// Nothing here touches src/, rules, or index.html.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pub = path.join(__dirname, "public");

function copy(srcRel, destRel) {
  const src = path.join(root, srcRel);
  const dest = path.join(pub, destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

fs.rmSync(pub, { recursive: true, force: true });
copy("index.html", "index.html");
for (const f of ["engine.js", "ledger.js", "sequence.js"]) {
  copy(path.join("src", f), path.join("src", f));
}
for (const f of fs.readdirSync(path.join(root, "src", "rules")).filter((x) => x.endsWith(".json")).sort()) {
  copy(path.join("src", "rules", f), path.join("src", "rules", f));
}

(async () => {
  const seq = await import(pathToFileURL(path.join(root, "src", "sequence.js")).href);
  fs.writeFileSync(path.join(__dirname, "sequence.json"), JSON.stringify({ sequence: seq.SEQUENCE }, null, 2));
  console.log("deploy bundle staged in deploy/public (+ deploy/sequence.json).");
})().catch((e) => { console.error(e); process.exit(1); });

function pathToFileURL(p) {
  let resolved = path.resolve(p).replace(/\\/g, "/");
  if (!resolved.startsWith("/")) resolved = `/${resolved}`;
  return new URL(`file://${resolved}`);
}
