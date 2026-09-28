# Debtaur SOP policy enforcer (demonstration)

A zero-dependency, deterministic policy-enforcement demo: signed JSON policies, a pure evaluator with allow/refuse/escalate outcomes, and an append-only hash-chained ledger. The policies shipped here are authored for demonstration; in a live engagement the client's own process replaces them.

Run the CLI: `npm start`. Serve the project for a browser frontend: `npm run demo` (port 8080).

## Quickstart (anyone, local, 2 minutes)

Prerequisite: Node.js 22+ and nothing else (zero npm dependencies).

```sh
git clone <this-repo> debtaur-eos
cd debtaur-eos
sh install.sh        # Windows: install.ps1 — checks Node, runs the smoke test
npm start            # CLI: four policy demos + guided Friday sequence (menu 5)
npm run demo         # browser: open http://localhost:8080/ and press Begin
```

`data/ledger.jsonl` is local audit data (created on first run, git-ignored); deleting it re-anchors the four policies on next start.

## Where the trusted fingerprint lives

The trusted fingerprint for each policy lives in `data/ledger.jsonl` as the first `RULESET_ANCHORED` entry for that policy id — a separate file from the policy itself. Every start recomputes each policy file's content hash and compares it against both the signature inside the file and that ledger entry. Editing the policy file alone fails the first comparison, and editing the file together with its in-file signature still fails the second one, because the ledger still holds the old fingerprint — that is why a ruleset-plus-signature edit is refused at load.

## What this does and does not stop

It stops quiet partial edits: any change to a policy file that is not deliberately re-signed and re-anchored refuses at load, names the file, logs the refusal, and (since the quarantine change) keeps the other policy areas live. It does not stop a full rewrite: someone who rewrites the policy file, its signature, and the ledger history consistently will boot cleanly, because the ledger carries no outside signing key. Treat the ledger as tamper-evident against partial edits, not tamper-proof against a full rewrite. A tampered policy area goes dark on its own while the remaining areas stay live; the ledger records both the refusal and the areas that stayed live.
