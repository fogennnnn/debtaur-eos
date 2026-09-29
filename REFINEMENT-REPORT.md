# REFINEMENT REPORT — debtaur-eos (agents2.txt pass)

Date: 2026-09-28. Working tree: `C:\Users\fogen\debtaur-eos`. All probes run by hand against the live tree; outputs below are what ran, not what should happen.

## Task 0 — anchor measurement (report, no fixes)

- 0.1, threshold-only edit (`threshold` 10000 → 999999 in `src/rules/expense-signoff.json`), boot via `echo "7" | npm start`:
  STOPS. `[AREA DARK] expense-signoff.json … refused at load (RULESET_INTEGRITY): stored signature does not match recomputed content`, logged (ledger seq 20), other areas live.
- 0.2, threshold + re-signed in-file hash (hash recomputed with `src/sequence.js` `contentHash`, so file and signature agree), boot:
  STOPS. Refusal names the file: content matches in-file signature but not the ledger anchor; other areas live.
- 0.3, ruleset + ledger anchor rewritten consistently (anchor entry hash updated, whole chain recomputed), boot:
  BOOTS. Menu opens, no refusal.
- One sentence: 0.1 and 0.2 stop the system, 0.3 boots.

## Tasks 1–2 — anchor + per-area quarantine (already enforced, verified not rebuilt)

No mechanism change was needed: the load gate compares each ruleset against both its in-file signature and the first `RULESET_ANCHORED` entry in `data/ledger.jsonl`, and a failure darkens only that area. Acceptance run (spend tampered, same run): demo 2 spend case `[REFUSED] … is dark — refused at load` naming `RULESET_INTEGRITY` with issue `ISS-FIN-2026-001`, while demo 1 onboarding completed a clean allow (`ACT-ONB-BASE-001` AUTHORIZED, 7 premises, ledger seq 22) plus its silent-case escalation. README already carries the plain-language anchor paragraph and the limits paragraph; left intact.

## Task 3 — copy corrections

- Integrity-refusal text names the attempt as a real one reads ("a superseded draft widens the spend limit", `SOP-FIN-01 (superseded draft)`); no staged-scene wording anywhere (grep clean).
- Policy codes never headline a moment; each is paired with client words ("Who can spend, and who signs above $10,000 [SOP-FIN-01]").
- Owner-facing lines aligned with enforcement: "quiet edits cannot widen spend authority — the unsigned change stops at this policy surface; unaffected areas stay live" (CLI) and "that policy goes dark while the others stay live" (frontend moment 4).
- Every refusal and escalation names the exact premise ID (FIN_05 / FIN_02 / ONB_06 / HIRE_06 / PAY_04 / RULESET_INTEGRITY).

## Task 4 — whose policy

One honest demo-numbers line at opening (CLI note + frontend lede) and close; no third-party methodology branding anywhere (full banned-token grep clean).

## Task 5 — verification

- Guided sequence (`npm start`, menu 5): Step 1 AUTHORIZED → Step 2 REFUSED/PREMISE_FIN_05 (issue 001) → Step 3 ESCALATED/PREMISE_FIN_02 (issue 002) → Step 4 REFUSED/RULESET_INTEGRITY on the superseded draft (issue 003) → "all four outcomes as expected".
- Task 0 re-runs after the pass: 0.1 stops, 0.2 stops, 0.3 boots (outputs above).
- Frontend served at `http://localhost:8080` (HTTP 200): three viewer tabs, guided run executes the engine live in-page, `/api/integrity` ok=true with anchor+chain match.

## What is and is not true about tamper resistance

True: any partial edit — touching a policy file alone, or the file plus its own signature — is refused at load, names the file, is written into the hash-chained ledger, and darkens only that policy area while the rest of the operation stays live. Not true: resistance to a full rewrite — someone who rewrites the policy, its signature, and the ledger history consistently will boot cleanly, because the ledger carries no outside signing key. Treat this demo as tamper-evident against partial edits, not tamper-proof against a full rewrite. One tampered policy stops that policy only; everything else keeps evaluating.

## Addendum 2026-09-29 — EOS framing on the demo surface (user-directed)

The Task 4 "no third-party methodology branding" rule in this report is superseded for the demo page: at the user's explicit direction for the Alain Dagenais meeting, `index.html` now speaks in EOS / Traction terms (Process, Accountability Chart, inherited SOP, Process Component) as descriptive comparison language for an exit-planning audience. This is a surface-copy decision, not a product claim: the demo does not present itself as an EOS product, carries no EOS templates or branding, and the engine, rulesets, ledger, and all verified behaviors are unchanged. Verify current surface copy in `index.html` COPY block, not in this report.
