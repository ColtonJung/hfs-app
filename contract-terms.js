/* Shared contract language + crypto helpers.
   Loaded by BOTH the app (executed PDF) and sign.html (what the customer reads),
   so the terms can never drift apart. Owner-approved wording, Aug 14 2026 —
   do not reword without the owner. */

const TERMS_VERSION = "v1-2026-08-14";

// d: { address, footage, color, total, half }  (money strings already formatted)
function contractSections(d) {
  return [
    ["What we'll do",
     `Stain and seal the fence at ${d.address} — ${d.footage} feet of stain coverage as quoted, in ${d.color} (Olympic Elite Advanced Exterior Stain and Sealer, solid). All stain and materials included. Typically finished in one day on site.`],
    ["Price & payment",
     `Total ${d.total}. Half (${d.half}) as a deposit to get on the schedule; the remaining half (${d.half}) when the job is complete. Check, Zelle, or cash.`],
    ["Weather",
     `Staining needs dry weather. If rain or wet conditions push the date, we'll pick the next workable date together. Your deposit is unaffected and stays applied to your job.`],
    ["Cancellation",
     `Cancel any time before we've bought your materials and your deposit comes back in full. If you cancel after materials for your job have been purchased, your refund is the deposit minus the cost of those materials.`],
    ["No warranty",
     `This job does not include a warranty of any kind, expressed or implied. How stain wears over time depends on weather and the wood itself.`],
  ];
}
const CONSENT_LINE = `By typing your name below and tapping "I agree & sign," you're agreeing to the work, the price, and the terms above.`;

// --- crypto: the signature payload is AES-GCM encrypted with the sign key,
// so the public inbox holds nothing readable without the link itself.
async function _aesKey(signKey) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signKey));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encPayload(signKey, obj) {
  const key = await _aesKey(signKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  const buf = new Uint8Array(iv.length + ct.byteLength); buf.set(iv); buf.set(new Uint8Array(ct), iv.length);
  return btoa(String.fromCharCode(...buf));
}
async function decPayload(signKey, b64) {
  const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await _aesKey(signKey);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}

// base64url helpers for the link fragment
const b64uEnc = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uDec = (s) => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))));
