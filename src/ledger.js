/**
 * Append-only SHA-256 hash-chained audit ledger.
 * Each entry commits to the previous entry hash: hash = SHA256(prev_hash + canonical entry).
 * Entries are kept in memory for the session. No network, no mutation of history.
 *
 * Dual runtime (no imports, no DOM, no network — safe to import straight into a page):
 *   - Node: hashes with node:crypto, loaded synchronously via process.getBuiltinModule
 *     (a static `node:crypto` import would break browser module loading, so it is
 *     deliberately avoided here).
 *   - Browsers (or any runtime without node:crypto): a small self-contained pure-JS
 *     SHA-256 below. Both backends produce IDENTICAL digests — verified against the
 *     test vector SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.
 */

/** @type {{ createHash: (algo: string) => { update: (data: string, enc: string) => { digest: (enc: string) => string } } } | null} */
let nodeCrypto = null;
try {
  const proc = typeof globalThis !== "undefined" ? globalThis.process : undefined;
  if (proc && typeof proc.getBuiltinModule === "function") {
    nodeCrypto = proc.getBuiltinModule("node:crypto");
  }
} catch (_e) {
  nodeCrypto = null;
}

/**
 * Which hashing backend is active: "node:crypto" or "pure-js".
 * @returns {"node:crypto" | "pure-js"}
 */
export function hashBackend() {
  return nodeCrypto ? "node:crypto" : "pure-js";
}

/**
 * UTF-8 encode a string to bytes (manual encoder — no TextEncoder dependency).
 * @param {string} str
 * @returns {number[]}
 */
function utf8Encode(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i += 1) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i += 1;
      }
    }
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return bytes;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/**
 * @param {number} x
 * @param {number} n
 * @returns {number}
 */
function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/**
 * Self-contained pure-JS SHA-256 hex digest (fallback backend).
 * @param {string} input
 * @returns {string}
 */
export function pureJsSha256Hex(input) {
  const bytes = utf8Encode(input);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push(
    (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff
  );

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/**
 * SHA-256 hex digest via the active backend (node:crypto when available,
 * otherwise the embedded pure-JS fallback). Digests are identical.
 * @param {string} input
 * @returns {string}
 */
export function sha256Hex(input) {
  if (nodeCrypto) {
    return nodeCrypto.createHash("sha256").update(input, "utf8").digest("hex");
  }
  return pureJsSha256Hex(input);
}

/** @type {import('./types.js').LedgerEntry[]} */
const entries = [];

/**
 * Canonical serialisation for hashing (stable key order via explicit projection).
 * @param {object} core
 * @returns {string}
 */
function canonical(core) {
  return JSON.stringify({
    seq: core.seq,
    timestamp: core.timestamp,
    status: core.status,
    action_id: core.action_id,
    actor_id: core.actor_id,
    rule_version_hash: core.rule_version_hash,
    derivation: core.derivation,
  });
}

/**
 * Append a decision to the ledger.
 * @param {import('./types.js').EvaluationResult} result
 * @param {import('./types.js').ActionRequest} [request]
 * @returns {import('./types.js').LedgerEntry}
 */
export function appendDecision(result, request) {
  const prevHash = entries.length > 0 ? entries[entries.length - 1].hash : "GENESIS";
  const seq = entries.length + 1;
  const core = {
    seq,
    timestamp: result.timestamp,
    status: result.status,
    action_id: result.action_id,
    actor_id: result.actor_id,
    rule_version_hash: result.rule_version_hash,
    derivation: result.derivation,
  };
  const hash = sha256Hex(prevHash + canonical(core));
  /** @type {import('./types.js').LedgerEntry} */
  const entry = {
    ...core,
    prev_hash: prevHash,
    hash,
  };
  for (const meta of ["kind", "sop_id"]) {
    if (result[meta] !== undefined) {
      entry[meta] = result[meta];
    }
  }
  if (request !== undefined) {
    const { signatures, action_id, action_type, actor_id, ...inputs } = request;
    entry.request_summary = { inputs };
  }
  entries.push(entry);
  return entry;
}

/**
 * Return a copy of all ledger entries in append order.
 * @returns {import('./types.js').LedgerEntry[]}
 */
export function getEntries() {
  return [...entries];
}

/**
 * Verify the hash chain: each entry's prev_hash must equal the prior entry's hash,
 * and each stored hash must recompute correctly.
 * @returns {{ ok: boolean, checked: number, failedAt: number | null }}
 */
export function verifyChain() {
  let prev = "GENESIS";
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e.prev_hash !== prev) {
      return { ok: false, checked: entries.length, failedAt: e.seq };
    }
    const recomputed = sha256Hex(
      e.prev_hash +
        canonical({
          seq: e.seq,
          timestamp: e.timestamp,
          status: e.status,
          action_id: e.action_id,
          actor_id: e.actor_id,
          rule_version_hash: e.rule_version_hash,
          derivation: e.derivation,
        })
    );
    if (recomputed !== e.hash) {
      return { ok: false, checked: entries.length, failedAt: e.seq };
    }
    prev = e.hash;
  }
  return { ok: true, checked: entries.length, failedAt: null };
}

/**
 * Replace in-memory state with entries loaded from the persistent file.
 * Validates minimal shape; throws on corruption (callers treat that as a
 * broken chain). Extra metadata fields (kind, sop_id, request_summary)
 * survive the round trip; only core fields feed the hash.
 * @param {unknown} loaded
 * @returns {number} entry count
 */
export function importEntries(loaded) {
  if (!Array.isArray(loaded)) {
    throw new Error("ledger file does not contain a list of entries");
  }
  for (const e of loaded) {
    if (
      !e || typeof e.seq !== "number" || typeof e.timestamp !== "string" ||
      typeof e.status !== "string" || typeof e.hash !== "string" || typeof e.prev_hash !== "string"
    ) {
      throw new Error(`ledger entry seq ${e?.seq ?? "?"} is malformed`);
    }
  }
  entries.length = 0;
  for (const e of loaded) {
    entries.push(e);
  }
  return entries.length;
}

/**
 * Clear the ledger (used for tests only).
 * @returns {void}
 */
export function clearLedger() {
  entries.length = 0;
}
