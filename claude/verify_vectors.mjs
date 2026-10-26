// verify_vectors.mjs - a second, independent EDEN Evidence v1 verifier, written from
// EDEN_EVIDENCE_SPEC_v1.md. Shares no code with the Python reference. Node 18+, no packages.
// Usage: node verify_vectors.mjs [vectors/eden_evidence_v1_vectors.json]
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const enc = new TextEncoder();
const DOMAIN = Buffer.concat([Buffer.from("EDEN-EVIDENCE-SEAL-v1", "ascii"), Buffer.from([0])]);
const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts.map(p => Buffer.from(p)))).digest();
const hex = b => Buffer.from(b).toString("hex");
const unhex = h => { if (typeof h !== "string" || !/^([0-9a-f]{2})*$/.test(h)) throw new Error("hex"); return Buffer.from(h, "hex"); };
const MAX = 2 ** 53 - 1;

// ---- spec section 3: raw-text number check, then canonical JSON
function numbersOk(text) {                // scan raw JSON text, skipping strings
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') { i++; while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1; i++; continue; }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400));
      if (!m || m[2] || m[3] || Math.abs(Number(m[0])) > MAX) return false;
      i += m[0].length; continue;
    }
    i++;
  }
  return true;
}
function canon(v) {
  if (v === null || v === true || v === false) return String(v);
  if (typeof v === "number") { if (!Number.isSafeInteger(v)) throw new Error("FLOAT"); return String(v); }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));   // UTF-16 order == code point order for BMP keys
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
}
const cbytes = v => Buffer.from(enc.encode(canon(v)));

// ---- RFC 9162 Merkle
const leafH = d => sha([0], d);
const nodeH = (l, r) => sha([1], l, r);
const split = n => { let k = 1; while (k * 2 < n) k *= 2; return k; };
function rootOf(h) {
  if (h.length === 0) return sha(Buffer.alloc(0));
  if (h.length === 1) return h[0];
  const k = split(h.length);
  return nodeH(rootOf(h.slice(0, k)), rootOf(h.slice(k)));
}
function verifyInclusion(data, index, size, path, root) {       // RFC 9162 2.1.3.2
  if (!(index >= 0 && index < size)) return false;
  let fn = index, sn = size - 1, r = leafH(data);
  for (const p of path) {
    if (sn === 0) return false;
    if ((fn & 1) || fn === sn) { r = nodeH(p, r); if (!(fn & 1)) while (fn && !(fn & 1)) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); } }
    else r = nodeH(r, p);
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  return sn === 0 && r.equals(root);
}
function verifyConsistency(first, second, fh, sh, path) {       // RFC 9162 2.1.4.2
  if (!(first > 0 && first <= second)) return false;
  if (first === second) return path.length === 0 && fh.equals(sh);
  path = path.slice();
  if ((first & (first - 1)) === 0) path.unshift(fh);
  if (!path.length) return false;
  let fn = first - 1, sn = second - 1;
  while (fn & 1) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
  let fr = path[0], sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if ((fn & 1) || fn === sn) { fr = nodeH(c, fr); sr = nodeH(c, sr); if (!(fn & 1)) while (fn && !(fn & 1)) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); } }
    else sr = nodeH(sr, c);
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  return sn === 0 && fr.equals(fh) && sr.equals(sh);
}

// ---- Ed25519 via Node's crypto (raw key wrapped in SPKI DER)
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const pubKey = raw => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });
const keyId = raw => hex(sha(raw)).slice(0, 16);
const omitSig = s => Object.fromEntries(Object.entries(s).filter(([k]) => k !== "sig"));
const sealId = s => hex(sha(DOMAIN, cbytes(s)));

// ---- spec section 8
function vSeal(s, pub) {
  const need = ["v", "type", "log", "seq", "n", "root", "t", "key", "prev_seal", "sig"];
  if (!s || typeof s !== "object" || !need.every(k => k in s) || s.type !== "seal" || s.v !== 1) return "BAD_FORMAT";
  if (s.key !== keyId(pub)) return "WRONG_KEY";
  try { if (!edVerify(null, Buffer.concat([DOMAIN, cbytes(omitSig(s))]), pubKey(pub), unhex(s.sig))) return "BAD_SIGNATURE"; }
  catch { return "BAD_SIGNATURE"; }
  return "OK";
}
function vInclusion(b, pub) {
  const c = vSeal(b.seal, pub); if (c !== "OK") return c;
  const e = b.entry, s = b.seal;
  if (!e || e.log !== s.log || !Number.isInteger(e.i)) return "BAD_FORMAT";
  return verifyInclusion(cbytes(e), e.i, s.n, b.path.map(unhex), unhex(s.root)) ? "OK" : "BAD_INCLUSION";
}
function vConsistency(b, pub) {
  for (const s of [b.from, b.to]) { const c = vSeal(s, pub); if (c !== "OK") return c; }
  if (b.from.log !== b.to.log) return "BAD_FORMAT";
  return verifyConsistency(b.from.n, b.to.n, unhex(b.from.root), unhex(b.to.root), b.path.map(unhex)) ? "OK" : "BAD_CONSISTENCY";
}
function vPack(p, pub, held = []) {
  if (!p || p.type !== "pack" || p.v !== 1) return "BAD_FORMAT";
  if (p.pub !== hex(pub)) return "WRONG_KEY";
  const seals = p.seals || [], entries = p.entries || [];
  if (!seals.length) return "BAD_FORMAT";
  let prev = null;
  for (let k = 0; k < seals.length; k++) {
    const s = seals[k], c = vSeal(s, pub); if (c !== "OK") return c;
    if (s.seq !== k || s.log !== p.log) return "BAD_SEAL_CHAIN";
    if (s.prev_seal !== (prev ? sealId(prev) : "0".repeat(64))) return "BAD_SEAL_CHAIN";
    if (prev && (prev.n > s.n || (prev.n > 0 && !verifyConsistency(prev.n, s.n, unhex(prev.root), unhex(s.root), p.consistency[k - 1].map(unhex))))) return "BAD_CONSISTENCY";
    prev = s;
  }
  if (entries.length !== seals.at(-1).n) return "BAD_ROOT";
  const hs = [];
  for (let k = 0; k < entries.length; k++) {
    if (!entries[k] || entries[k].i !== k || entries[k].log !== p.log) return "INDEX_MISMATCH";
    hs.push(leafH(cbytes(entries[k])));
  }
  for (const s of seals) if (hex(rootOf(hs.slice(0, s.n))) !== s.root) return "BAD_ROOT";
  for (const h of held) {
    const c = vSeal(h, pub); if (c !== "OK") return c;
    if (h.n > entries.length || hex(rootOf(hs.slice(0, h.n))) !== h.root) return "BAD_CONSISTENCY";
  }
  return "OK";
}
function run(kind, obj, pub, held) {
  try { return { pack: () => vPack(obj, pub, held), seal: () => vSeal(obj, pub), inclusion: () => vInclusion(obj, pub), consistency: () => vConsistency(obj, pub) }[kind](); }
  catch (e) { return /FLOAT/.test(e.message) ? "FLOAT_FORBIDDEN" : "BAD_FORMAT"; }
}

export { vSeal, vInclusion, vConsistency, vPack, numbersOk, canon, cbytes, sha, hex, unhex, pubKey, keyId, sealId, omitSig, verifyConsistency };
const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (IS_MAIN) {
// ---- mode 2: check an evidence file produced by a demo: {"pub": hex, "items": [{"label","kind","input","held_seals"?,"expect"?}]}
if (process.argv[2] === "--check") {
  const raw2 = readFileSync(process.argv[3], "utf8");
  if (!numbersOk(raw2)) { console.log("FAIL  file contains a forbidden number form -> FLOAT_FORBIDDEN"); process.exit(1); }
  const F = JSON.parse(raw2); let bad = 0;
  for (const it of F.items) {
    const got = run(it.kind, it.input, unhex(F.pub), it.held_seals || []), want = it.expect || "OK";
    if (got !== want) bad++;
    console.log(`${got === want ? "PASS" : "FAIL"}  ${it.label}  ->  ${got}${got === want ? "" : "  (expected " + want + ")"}`);
  }
  console.log(`\n${F.items.length - bad}/${F.items.length} checks as expected (independent JavaScript verifier)`);
  process.exit(bad ? 1 : 0);
}

// ---- run the vectors
const file = process.argv[2] || "vectors/eden_evidence_v1_vectors.json";
const raw = readFileSync(file, "utf8");
const V = JSON.parse(raw);
let pass = 0, fail = 0;
const report = (name, got, want) => { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ->  ${got}${ok ? "" : "  (expected " + want + ")"}`); };

// intermediates: byte-level agreement with the reference implementation
const I = V.intermediates, e0 = V.cases[0].input.entries[0], s0 = V.cases[0].input.seals[0];
report("intermediate: entry 0 canonical bytes", canon(e0) === I.entry0_canonical ? "OK" : "MISMATCH", "OK");
report("intermediate: entry 0 leaf hash", hex(leafH(cbytes(e0))) === I.entry0_leaf_hash ? "OK" : "MISMATCH", "OK");
report("intermediate: seal 0 signed-message hash", hex(sha(DOMAIN, cbytes(omitSig(s0)))) === I.seal0_signed_message_sha256 ? "OK" : "MISMATCH", "OK");
report("intermediate: seal 0 id", sealId(s0) === I.seal0_id ? "OK" : "MISMATCH", "OK");
report("vectors file passes the raw-text number rule", numbersOk(raw) ? "OK" : "FLOAT_FORBIDDEN", "OK");

for (const c of V.cases) report(c.name, run(c.kind, c.input, unhex(c.pub || V.pub), c.held_seals || []), c.expect);
for (const c of V.text_cases) {
  const got = numbersOk(c.input_text) ? run(c.kind, JSON.parse(c.input_text), unhex(V.pub), []) : "FLOAT_FORBIDDEN";
  report(c.name, got, c.expect);
}
console.log(`\n${pass}/${pass + fail} passed (independent JavaScript verifier, Node ${process.version})`);
process.exit(fail ? 1 : 0);

}
