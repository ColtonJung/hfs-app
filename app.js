/* HFS Pocket Office — quoting, door-knock capture, follow-ups.
   Talks straight to the Airtable pipeline. Token lives only in this phone's localStorage. */

// ---------- config ----------
const BASE = "appaJie3ceZxDhJRj";
const TABLE = "Leads";
const API = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}`;
const CONTENT_API = `https://content.airtable.com/v0/${BASE}`;

// Owner-approved rate bands (config/pricing.json): total footage picks the rate.
function bandRate(totalFt) { if (totalFt >= 400) return 6; if (totalFt >= 300) return 7; return 8; }

// Owner-LOCKED text (templates/messages.md). Never reword.
const COVER = (first) => `Hey ${first}, thank you for your time today. Here's your fence staining quote. If you have any questions, just text me. — Colton, Heights Fence Staining`;

const SOURCES = ["Door-knock", "Hanger", "Website", "Referral"];
const HEIGHTS = ["6 FT standard", "8 FT", "Mixed heights"];
const INTERESTS = ["Hot", "Warm", "Cool"];

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const store = {
  get token() { return localStorage.getItem("hfs_token") || ""; },
  set token(v) { localStorage.setItem("hfs_token", v); },
  get queue() { try { return JSON.parse(localStorage.getItem("hfs_queue") || "[]"); } catch { return []; } },
  set queue(v) { localStorage.setItem("hfs_queue", JSON.stringify(v)); },
};

// Quote numbering: the pipeline is the single source of truth.
// Sequence floor = 1275, the last hand-made invoice; the sequence continues from
// whatever the highest numeric Quote No in Airtable is. Offline quotes get a
// permanent field number (F + MMDD-HHMM) that is never renumbered.
const SEQ_FLOOR = 1275;
async function fetchNextQuoteNumber() {
  const params = `fields%5B%5D=${encodeURIComponent("Quote No")}` +
    `&filterByFormula=${encodeURIComponent("{Quote No} != ''")}` +
    `&sort%5B0%5D%5Bfield%5D=${encodeURIComponent("Quote No")}&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=100`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(`${API}?${params}`, { headers: headers(), signal: ctrl.signal });
    if (!r.ok) throw new Error(`Airtable ${r.status}`);
    const { records } = await r.json();
    const nums = records.map((x) => parseInt(x.fields["Quote No"], 10)).filter(Number.isFinite);
    return pad5(Math.max(SEQ_FLOOR, ...nums) + 1);
  } finally { clearTimeout(timer); }
}
function fieldQuoteNumber() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `F${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
const pad5 = (n) => String(n).padStart(5, "0");
const digits = (p) => (p || "").replace(/[^\d+]/g, "");
const firstName = (name) => (name || "").trim().split(/\s+/)[0] || "there";
const fmtMoney = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const todayNice = () => { const d = new Date(); return `${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}/${d.getFullYear()}`; };

function toast(msg, ms = 2600) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms); }

function seg(containerId, options, defIdx = 0) {
  const el = $(containerId); el.innerHTML = "";
  options.forEach((o, i) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = o;
    if (i === defIdx) b.classList.add("on");
    b.onclick = () => { el.querySelectorAll("button").forEach(x => x.classList.remove("on")); b.classList.add("on"); el.dispatchEvent(new Event("segchange")); };
    el.appendChild(b);
  });
}
const segVal = (id) => $(id).querySelector("button.on")?.textContent || "";

// ---------- tabs ----------
document.querySelectorAll("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.remove("on")); b.classList.add("on");
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("on"));
  $("tab-" + b.dataset.tab).classList.add("on");
  if (b.dataset.tab === "fu") loadFollowups();
  if (b.dataset.tab === "settings") refreshSettings();
});

// ---------- airtable ----------
function headers() { return { "Authorization": `Bearer ${store.token}`, "Content-Type": "application/json" }; }

async function atCreate(fields) {
  const r = await fetch(API, { method: "POST", headers: headers(), body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
  return r.json();
}
async function atPatch(id, fields) {
  const r = await fetch(`${API}/${id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`Airtable ${r.status}`);
  return r.json();
}
async function atUploadPhoto(recordId, dataURL) {
  const [meta, b64] = dataURL.split(",");
  const contentType = (meta.match(/data:(.*?);/) || [])[1] || "image/jpeg";
  const r = await fetch(`${CONTENT_API}/${recordId}/${encodeURIComponent("Photos")}/uploadAttachment`, {
    method: "POST", headers: headers(),
    body: JSON.stringify({ contentType, filename: `photo-${Date.now()}.jpg`, file: b64 }),
  });
  if (!r.ok) throw new Error(`photo upload ${r.status}`);
}

// Queue: every write goes through here; survives offline and app restarts.
function enqueue(item) { const q = store.queue; q.push({ ...item, ts: Date.now() }); store.queue = q; updateQueueBadge(); flushQueue(); }
let flushing = false;
async function flushQueue() {
  if (flushing || !store.token || !navigator.onLine) return;
  flushing = true;
  let q = store.queue;
  while (q.length) {
    const item = q[0];
    try {
      if (item.kind === "create") {
        const rec = await atCreate(item.fields);
        if (item.photo) { try { await atUploadPhoto(rec.id, item.photo); } catch (e) { console.warn("photo failed", e); } }
      } else if (item.kind === "patch") {
        await atPatch(item.recordId, item.fields);
      }
      q.shift(); store.queue = q;
    } catch (e) { console.warn("flush stopped:", e.message); break; }
  }
  flushing = false; updateQueueBadge();
}
function updateQueueBadge() {
  const n = store.queue.length, b = $("queueBadge");
  b.style.display = n ? "block" : "none"; b.textContent = `${n} queued`;
  $("queueMsg").textContent = n ? `${n} item(s) waiting for signal + token.` : "Nothing queued.";
}
window.addEventListener("online", flushQueue);

// ---------- QUOTE tab ----------
seg("qSource", SOURCES, 0);
seg("qHeight", HEIGHTS, 0);

function addSectionRow(ft = "", sides = "One Side") {
  const row = document.createElement("div"); row.className = "sec-row";
  row.innerHTML = `<input type="number" inputmode="numeric" placeholder="FT" value="${ft}">
    <div class="seg">
      <button type="button" class="${sides === "One Side" ? "on" : ""}">One Side</button>
      <button type="button" class="${sides === "Both Sides" ? "on" : ""}">Both Sides</button>
    </div><button type="button" class="del">×</button>`;
  row.querySelectorAll(".seg button").forEach(b => b.onclick = () => {
    row.querySelectorAll(".seg button").forEach(x => x.classList.remove("on")); b.classList.add("on"); recalc(); });
  row.querySelector(".del").onclick = () => { row.remove(); recalc(); };
  row.querySelector("input").oninput = recalc;
  $("sections").appendChild(row);
}
$("addSec").onclick = () => addSectionRow();
addSectionRow();

function readSections() {
  return [...$("sections").querySelectorAll(".sec-row")].map(r => ({
    ft: parseInt(r.querySelector("input").value, 10) || 0,
    sides: r.querySelector(".seg button.on")?.textContent || "One Side",
  })).filter(s => s.ft > 0);
}

let rateTouched = false;
$("qRate").oninput = () => { rateTouched = true; recalc(false); };
$("qHeight").addEventListener("segchange", () => { rateTouched = false; recalc(); });

function recalc(updateRate = true) {
  const secs = readSections();
  const totalFt = secs.reduce((a, s) => a + s.ft, 0);
  const std = segVal("qHeight") === "6 FT standard";
  $("heightWarn").style.display = std ? "none" : "block";
  if (updateRate && !rateTouched) $("qRate").value = std && totalFt ? bandRate(totalFt) : "";
  const rate = parseFloat($("qRate").value) || 0;
  $("rateNote").textContent = std ? `Band: $8 under 300 ft · $7 at 300–399 · $6 at 400+. Change the rate to override.` : `Manual rate required for non-standard height.`;
  $("tFt").textContent = `${totalFt} FT total`;
  $("tTotal").textContent = `$${fmtMoney(totalFt * rate)}`;
  return { secs, totalFt, rate, std };
}

$("makeQuote").onclick = async () => {
  const { secs, totalFt, rate, std } = recalc(false);
  const name = $("qName").value.trim(), phone = digits($("qPhone").value), address = $("qAddress").value.trim();
  const stain = $("qStain").value.trim() || "TBD";
  if (!address) return toast("Address is required");
  if (!secs.length) return toast("Add at least one section with footage");
  if (!rate) return toast("Enter a rate");
  const total = totalFt * rate;

  // Number the quote from the pipeline; dead zone -> permanent field number.
  const btn = $("makeQuote"); btn.disabled = true; btn.textContent = "Numbering…";
  let quoteNo, offlineNo = false;
  try { quoteNo = await fetchNextQuoteNumber(); }
  catch (e) { quoteNo = fieldQuoteNumber(); offlineNo = true; }
  btn.disabled = false; btn.textContent = "Make PDF & Text It";

  const pdfHeight = std ? "6 FT" : (segVal("qHeight") === "8 FT" ? "8 FT" : "Mixed heights");
  const noteHeight = std ? "6 FT" : `${pdfHeight} — height review`;

  const blob = makePdf({ quoteNo, name, address, secs, totalFt, rate, total, stain, height: pdfHeight });

  enqueue({ kind: "create", fields: {
    "Address": address, "Name": name, "Phone": phone, "Source": segVal("qSource"),
    "Status": phone ? "Quoted" : "New", "Linear Footage": totalFt, "Height Notes": noteHeight,
    "Stain Color": stain, "Rate per Ft": rate, "Quote Amount": total,
    "Quote Sent": todayISO(), "Notes": $("qNotes").value.trim(), "Quote No": quoteNo,
  }});

  const file = new File([blob], `HFS Quote ${quoteNo}.pdf`, { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const cover = COVER(firstName(name));
  const rc = $("resultCard");
  rc.style.display = "block";
  rc.innerHTML = `<h2>QUOTE ${quoteNo} — $${fmtMoney(total)}</h2>
    <div class="note">${offlineNo ? "No signal — issued permanent field number " + quoteNo + ". It stays exactly this on the record when it syncs; it is never renumbered. " : ""}${phone ? "Logged as Quoted." : "No phone — logged as New; it'll sit in Missing Phone until you get a number."}</div>
    <button class="btn" id="shareBtn">Share PDF to Messages</button>
    ${phone ? `<a class="btn sub" style="text-align:center;text-decoration:none" href="sms:${phone}&body=${encodeURIComponent(cover)}">Text cover message</a>` : ""}
    <div class="note" style="margin-top:10px"><a class="pdf" href="${url}" target="_blank">View PDF</a> · saved as HFS Quote ${quoteNo}.pdf</div>`;
  $("shareBtn").onclick = async () => {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text: cover }); } catch (e) { /* user canceled */ }
    } else {
      const a = document.createElement("a"); a.href = url; a.download = file.name; a.click();
      toast("PDF downloaded — attach it in Messages");
    }
  };
  rc.scrollIntoView({ behavior: "smooth" });
  toast(`Quote ${quoteNo} ready`);
};

// ---------- PDF ----------
function makePdf(q) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const GREEN = [148, 173, 98], PALE = [181, 199, 142], INK = [63, 63, 63], GRAY = [138, 138, 138], LINE = [217, 217, 217];
  const L = 48, R = 564, W = R - L;

  doc.setFillColor(...GREEN); doc.rect(L, 40, W, 8, "F");

  doc.setFont("helvetica", "bold"); doc.setFontSize(19); doc.setTextColor(...GREEN);
  doc.text("HEIGHTS FENCE STAINING", L, 82, { charSpace: 2 });
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...PALE);
  doc.text("WWW.HEIGHTSFENCESTAINING.COM", L, 96, { charSpace: 1.5 });
  try { doc.addImage("data:image/png;base64," + LOGO_B64, "PNG", R - 110, 56, 110, 80); } catch (e) {}

  doc.setFontSize(22); doc.setTextColor(85, 85, 85); doc.text("QUOTE", L, 168);
  doc.setFontSize(10); doc.setTextColor(...GREEN);
  doc.text("(254) 681-2205", L, 192); doc.text("heightsfencestain", L, 206); doc.text("@gmail.com", L, 220);

  doc.setTextColor(...INK);
  const rx = 300; let ry = 152;
  ["Quote To:", q.name || "—", q.address, `Quote No. ${q.quoteNo}`, `Date: ${todayNice()}`].forEach(t => { doc.text(String(t), rx, ry); ry += 16; });

  let y = 258;
  doc.setFillColor(...GREEN); doc.rect(L, y, W, 22, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(255, 255, 255);
  doc.text("Description", L + 10, y + 15); doc.text("Quantity", 300, y + 15); doc.text("Unit Price", 390, y + 15);
  doc.text("Cost", R - 10, y + 15, { align: "right" });
  y += 22;

  doc.setFont("helvetica", "normal"); doc.setTextColor(...INK);
  const row = (desc, qty, unit, cost, bold) => {
    if (bold) doc.setFont("helvetica", "bold");
    doc.text(desc, L + 10, y + 14); doc.text(qty, 300, y + 14); doc.text(unit, 390, y + 14);
    if (cost) doc.text(cost, R - 10, y + 14, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setDrawColor(...LINE); doc.line(L, y + 20, R, y + 20);
    y += 20;
  };
  q.secs.forEach(s => row(`Fence section (${s.sides})`, `${s.ft} FT`, "", ""));
  row(`Olympic Stain (${q.height})`, `${q.totalFt} FT`, `$${fmtMoney(q.rate)}`, `$${fmtMoney(q.total)}`);
  doc.setFont("helvetica", "bold");
  doc.text("Total", 390, y + 15); doc.text(`$${fmtMoney(q.total)}`, R - 10, y + 15, { align: "right" });
  doc.setDrawColor(...INK); doc.setLineWidth(1.5); doc.line(L, y + 22, R, y + 22); doc.setLineWidth(0.5);
  y += 44;

  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(85, 85, 85);
  doc.text(`Stain color: ${q.stain}`, L, y);
  doc.setFontSize(9); doc.setTextColor(...GRAY); doc.setFont("helvetica", "italic");
  doc.text("Prices good for 30 days.", L, y + 16);

  try {
    doc.addFileToVFS("GreatVibes.ttf", SIG_FONT_B64);
    doc.addFont("GreatVibes.ttf", "GreatVibes", "normal");
    doc.setFont("GreatVibes", "normal"); doc.setFontSize(30);
  } catch (e) { doc.setFont("helvetica", "italic"); doc.setFontSize(20); }
  doc.setTextColor(143, 163, 196);
  doc.text("Colton Jung", R - 10, 700, { align: "right" });

  doc.setFillColor(...GREEN); doc.rect(L, 724, W, 8, "F");
  return doc.output("blob");
}

// ---------- DOOR KNOCK tab ----------
seg("kInterest", INTERESTS, 1);
let knockPhoto = null;
$("kPhoto").onchange = () => {
  const f = $("kPhoto").files[0]; if (!f) { knockPhoto = null; $("kThumb").style.display = "none"; return; }
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    c.width = img.width * scale; c.height = img.height * scale;
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    knockPhoto = c.toDataURL("image/jpeg", 0.8);
    $("kThumb").src = knockPhoto; $("kThumb").style.display = "block";
  };
  img.src = URL.createObjectURL(f);
};
$("saveKnock").onclick = () => {
  const address = $("kAddress").value.trim();
  if (!address) return toast("Address is required");
  enqueue({ kind: "create", photo: knockPhoto, fields: {
    "Address": address, "Name": $("kName").value.trim(), "Phone": digits($("kPhone").value),
    "Source": "Door-knock", "Status": "New", "Interest Level": segVal("kInterest"),
    "Fence Age": $("kAge").value.trim(), "Notes": $("kNotes").value.trim(),
  }});
  ["kAddress", "kAge", "kName", "kPhone", "kNotes"].forEach(id => $(id).value = "");
  $("kPhoto").value = ""; knockPhoto = null; $("kThumb").style.display = "none";
  toast("Lead saved 👍");
};

// ---------- FOLLOW-UPS tab ----------
function stageOf(f) {
  if (!f["D2 Sent"]) return { label: "Day 2", field: "D2 Sent", alsoThinking: true };
  if (!f["D7 Sent"]) return { label: "Day 7", field: "D7 Sent" };
  if (!f["D14 Sent"]) return { label: "Day 14", field: "D14 Sent" };
  return { label: "Day 30", field: "D30 Sent" };
}
async function loadFollowups() {
  const list = $("fuList");
  if (!store.token) { list.innerHTML = `<div class="empty">Add your token in Settings first.</div>`; return; }
  list.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const formula = "AND({Next Due}, NOT(IS_AFTER({Next Due}, TODAY())))";
    const r = await fetch(`${API}?filterByFormula=${encodeURIComponent(formula)}&sort%5B0%5D%5Bfield%5D=${encodeURIComponent("Next Due")}&sort%5B0%5D%5Bdirection%5D=asc`, { headers: headers() });
    if (!r.ok) throw new Error(`Airtable ${r.status}`);
    const { records } = await r.json();
    if (!records.length) { list.innerHTML = `<div class="empty">☀️ Nothing due. Go about your day.</div>`; return; }
    list.innerHTML = "";
    records.forEach(rec => {
      const f = rec.fields, st = stageOf(f);
      const draft = f["Next Draft"] || "";
      const phone = digits(f["Phone"]);
      const card = document.createElement("div"); card.className = "card fu-card";
      card.innerHTML = `<div class="name">${f["Name"] || "—"}<span class="stage">${st.label}</span></div>
        <div class="meta">${f["Address"] || ""} · quoted $${fmtMoney(f["Quote Amount"] || 0)}</div>
        <div class="draft">${draft}</div>
        <div class="fu-actions">
          <a class="primary" href="sms:${phone}&body=${encodeURIComponent(draft)}">Text</a>
          <button data-act="sent">Mark sent</button>
          <button data-act="pause">Pause</button>
          <button data-act="won">Won 🎉</button>
        </div>`;
      card.querySelector('[data-act="sent"]').onclick = () => {
        const fields = { [st.field]: true }; if (st.alsoThinking) fields["Status"] = "Thinking";
        enqueue({ kind: "patch", recordId: rec.id, fields }); card.remove(); toast(`${st.label} marked sent`);
      };
      card.querySelector('[data-act="pause"]').onclick = () => {
        enqueue({ kind: "patch", recordId: rec.id, fields: { "Paused": true } }); card.remove(); toast("Paused — they replied, you take it from here");
      };
      card.querySelector('[data-act="won"]').onclick = () => {
        enqueue({ kind: "patch", recordId: rec.id, fields: { "Status": "Won" } }); card.remove(); toast("WON 🎉");
      };
      list.appendChild(card);
    });
  } catch (e) { list.innerHTML = `<div class="empty">Couldn't load (${e.message}). Check signal + token.</div>`; }
}
$("fuRefresh").onclick = loadFollowups;

// ---------- SETTINGS tab ----------
async function refreshSettings() {
  $("sToken").value = store.token; updateQueueBadge();
  const el = $("nextNoDisplay");
  if (!store.token) { el.textContent = "— (add token first)"; return; }
  el.textContent = "checking…";
  try { el.textContent = await fetchNextQuoteNumber(); }
  catch (e) { el.textContent = "— (no signal right now)"; }
}
$("saveToken").onclick = () => { store.token = $("sToken").value.trim(); $("setupBanner").style.display = store.token ? "none" : "block"; toast("Token saved"); flushQueue(); refreshSettings(); };
$("testConn").onclick = async () => {
  $("connMsg").textContent = "Testing…";
  try {
    const r = await fetch(`${API}?maxRecords=1`, { headers: headers() });
    $("connMsg").textContent = r.ok ? "✓ Connected to Heights Fence Pipeline." : `✗ Airtable said ${r.status} — token wrong or missing scopes.`;
  } catch (e) { $("connMsg").textContent = `✗ ${e.message}`; }
};
$("syncNow").onclick = () => { flushQueue(); toast("Syncing…"); };

// ---------- boot ----------
$("setupBanner").style.display = store.token ? "none" : "block";
updateQueueBadge(); flushQueue();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
