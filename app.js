/* HFS Pocket Office — quoting, territory door-knocking, follow-ups.
   Talks straight to the Airtable pipeline. Token lives only in this phone's localStorage. */

// ---------- config ----------
const BASE = "appaJie3ceZxDhJRj";
const TBL = { leads: "Leads", nbrs: "Neighborhoods", homes: "Homes", visits: "Visits" };
const atUrl = (table) => `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`;
const API = atUrl(TBL.leads);
const CONTENT_API = `https://content.airtable.com/v0/${BASE}`;

// Owner-approved rate bands (config/pricing.json): total footage picks the rate.
function bandRate(totalFt) { if (totalFt >= 400) return 6; if (totalFt >= 300) return 7; return 8; }

// Owner-LOCKED text (templates/messages.md). Never reword.
const COVER = (first) => `Hey ${first}, thank you for your time today. Here's your fence staining quote. If you have any questions, just text me. — Colton, Heights Fence Staining`;

const SOURCES = ["Door-knock", "Hanger", "Website", "Referral"];
const HEIGHTS = ["6 FT standard", "8 FT", "Mixed heights"];
const OUTCOMES = ["Talked — interested", "Talked — gave quote", "Talked — not interested", "No answer — left tag", "No answer — no tag"];
const TAG_WAIT_DAYS = 30; // second door tag only after a month of no-answer

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const store = {
  get token() { return localStorage.getItem("hfs_token") || ""; },
  set token(v) { localStorage.setItem("hfs_token", v); },
  get queue() { try { return JSON.parse(localStorage.getItem("hfs_queue") || "[]"); } catch { return []; } },
  set queue(v) { localStorage.setItem("hfs_queue", JSON.stringify(v)); },
  get idmap() { try { return JSON.parse(localStorage.getItem("hfs_idmap") || "{}"); } catch { return {}; } },
  set idmap(v) { localStorage.setItem("hfs_idmap", JSON.stringify(v)); },
  get territory() { try { return JSON.parse(localStorage.getItem("hfs_territory") || "null"); } catch { return null; } },
  set territory(v) { localStorage.setItem("hfs_territory", JSON.stringify(v)); },
};
const pad5 = (n) => String(n).padStart(5, "0");
const digits = (p) => (p || "").replace(/[^\d+]/g, "");
const firstName = (name) => (name || "").trim().split(/\s+/)[0] || "there";
const fmtMoney = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const todayNice = () => { const d = new Date(); return `${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}/${d.getFullYear()}`; };
const tempId = () => "tmp_" + Date.now() + Math.random().toString(36).slice(2, 7);
const isTemp = (id) => typeof id === "string" && id.startsWith("tmp_");
const daysSince = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;
const fmtWhen = (iso) => { const d = new Date(iso); let h = d.getHours() % 12 || 12; const ap = d.getHours() < 12 ? "am" : "pm";
  return `${d.getMonth()+1}/${d.getDate()} ${h}:${String(d.getMinutes()).padStart(2,"0")}${ap}`; };
const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

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
  if (b.dataset.tab === "knock") openTerritory();
});

// ---------- airtable ----------
function headers() { return { "Authorization": `Bearer ${store.token}`, "Content-Type": "application/json" }; }

async function atCreate(table, fields) {
  const r = await fetch(atUrl(table), { method: "POST", headers: headers(), body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
  return r.json();
}
async function atPatch(table, id, fields) {
  const r = await fetch(`${atUrl(table)}/${id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`Airtable ${r.status}`);
  return r.json();
}
async function atList(table, params = "") {
  let out = [], offset = "";
  do {
    const r = await fetch(`${atUrl(table)}?pageSize=100${params}${offset ? `&offset=${offset}` : ""}`, { headers: headers() });
    if (!r.ok) throw new Error(`Airtable ${r.status}`);
    const d = await r.json();
    out = out.concat(d.records); offset = d.offset || "";
  } while (offset);
  return out;
}
async function atUploadPhoto(recordId, field, dataURL) {
  const [meta, b64] = dataURL.split(",");
  const contentType = (meta.match(/data:(.*?);/) || [])[1] || "image/jpeg";
  const r = await fetch(`${CONTENT_API}/${recordId}/${encodeURIComponent(field)}/uploadAttachment`, {
    method: "POST", headers: headers(),
    body: JSON.stringify({ contentType, filename: `photo-${Date.now()}.jpg`, file: b64 }),
  });
  if (!r.ok) throw new Error(`photo upload ${r.status}`);
}

// Quote numbering: the pipeline is the single source of truth.
// Sequence floor = 1275, the last hand-made invoice. Offline quotes get a
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

// ---------- offline queue (v2: multi-table, temp-id aware) ----------
const LINK_KEYS = ["Neighborhood", "Home", "Lead"];
function enqueue(item) { const q = store.queue; q.push({ ...item, ts: Date.now() }); store.queue = q; updateQueueBadge(); flushQueue(); }
let flushing = false;
async function flushQueue() {
  if (flushing || !store.token || !navigator.onLine) return;
  flushing = true;
  let q = store.queue;
  while (q.length) {
    const item = q[0];
    const map = store.idmap;
    const xl = (v) => { if (!isTemp(v)) return v; if (!map[v]) throw new Error("temp id not resolved yet"); return map[v]; };
    try {
      const table = item.table || TBL.leads;
      if (item.kind === "create") {
        const fields = { ...item.fields };
        for (const k of LINK_KEYS) if (Array.isArray(fields[k])) fields[k] = fields[k].map(xl);
        const rec = await atCreate(table, fields);
        if (item.tempId) { const m = store.idmap; m[item.tempId] = rec.id; store.idmap = m; remapTerritory(item.tempId, rec.id); }
        if (item.photo) { try { await atUploadPhoto(rec.id, item.photoField || "Photos", item.photo); } catch (e) { console.warn("photo failed", e); } }
        if (item.linkHome) { try { await atPatch(TBL.homes, xl(item.linkHome), { Lead: [rec.id] }); linkHomeLocal(item.linkHome, rec.id); } catch (e) { console.warn("home link failed", e); } }
      } else if (item.kind === "patch") {
        const fields = { ...item.fields };
        for (const k of LINK_KEYS) if (Array.isArray(fields[k])) fields[k] = fields[k].map(xl);
        await atPatch(item.table || TBL.leads, xl(item.recordId), fields);
      }
      q.shift(); store.queue = q;
    } catch (e) { console.warn("flush stopped:", e.message); break; }
  }
  flushing = false; updateQueueBadge();
}
function updateQueueBadge() {
  const n = store.queue.length, b = $("queueBadge");
  b.style.display = n ? "block" : "none"; b.textContent = `${n} queued`;
  const qm = $("queueMsg"); if (qm) qm.textContent = n ? `${n} item(s) waiting for signal + token.` : "Nothing queued.";
}
window.addEventListener("online", flushQueue);

// ---------- TERRITORY (Door Knock tab) ----------
let T = store.territory || { nbrs: [], homes: [], visits: [] };
let KV = { level: "nbrs", nbrId: null, homeId: null, lastStreet: "" };
let territoryLoaded = false;

function saveT() { store.territory = T; }
function remapTerritory(tmp, real) {
  T.nbrs.forEach(n => { if (n.id === tmp) n.id = real; });
  T.homes.forEach(h => { if (h.id === tmp) h.id = real; if (h.nbrId === tmp) h.nbrId = real; });
  T.visits.forEach(v => { if (v.id === tmp) v.id = real; if (v.homeId === tmp) v.homeId = real; });
  if (KV.nbrId === tmp) KV.nbrId = real; if (KV.homeId === tmp) KV.homeId = real;
  saveT();
}
function linkHomeLocal(homeId, leadId) {
  const h = T.homes.find(x => x.id === homeId || x.id === store.idmap[homeId]);
  if (h) { h.leadIds = [leadId]; saveT(); }
}

async function loadTerritory() {
  const [nr, hr, vr] = await Promise.all([atList(TBL.nbrs), atList(TBL.homes), atList(TBL.visits)]);
  T = {
    nbrs: nr.map(r => ({ id: r.id, name: r.fields.Name || "(unnamed)" })),
    homes: hr.map(r => ({ id: r.id, nbrId: (r.fields.Neighborhood || [])[0] || null, address: r.fields.Address || "",
      streetNo: r.fields["Street No"] || "", street: r.fields.Street || "", notMovedIn: !!r.fields["Not Moved In"],
      note: r.fields.Note || "", leadIds: r.fields.Lead || [] })),
    visits: vr.map(r => ({ id: r.id, homeId: (r.fields.Home || [])[0] || null, outcome: r.fields.Outcome || "", when: r.fields.When || "" })),
  };
  // overlay anything still waiting in the queue so offline work never disappears from view
  const map = store.idmap;
  for (const item of store.queue) {
    if (item.kind !== "create" || !item.tempId || map[item.tempId]) continue;
    const f = item.fields;
    if (item.table === TBL.nbrs) T.nbrs.push({ id: item.tempId, name: f.Name });
    if (item.table === TBL.homes) T.homes.push({ id: item.tempId, nbrId: (f.Neighborhood || [])[0], address: f.Address,
      streetNo: f["Street No"] || "", street: f.Street || "", notMovedIn: !!f["Not Moved In"], note: f.Note || "", leadIds: f.Lead || [] });
    if (item.table === TBL.visits) T.visits.push({ id: item.tempId, homeId: (f.Home || [])[0], outcome: f.Outcome, when: f.When });
  }
  saveT(); territoryLoaded = true;
}

async function openTerritory() {
  renderKnock();
  if (!territoryLoaded && store.token && navigator.onLine) {
    try { await loadTerritory(); renderKnock(); }
    catch (e) { if (!T.nbrs.length) $("knockView").innerHTML = `<div class="empty">Couldn't load territory (${esc(e.message)}). Working from what's on this phone.</div>`; }
  }
}

// The next-action chip: the whole tracker boiled down to one glance.
function computeChip(home) {
  if (home.leadIds && home.leadIds.length) return { label: "Skip — in pipeline", cls: "blue", quote: false };
  const vs = T.visits.filter(v => v.homeId === home.id).sort((a, b) => new Date(b.when) - new Date(a.when));
  const talked = vs.find(v => v.outcome.startsWith("Talked"));
  if (talked) {
    if (talked.outcome === "Talked — not interested") return { label: "Skip — not interested", cls: "red", quote: false };
    if (talked.outcome === "Talked — gave quote") return { label: "Skip — in pipeline", cls: "blue", quote: true };
    return { label: "Interested — revisit", cls: "amber", quote: true };
  }
  if (vs.length) { // no-answer history only: knocking again is always fine, tags are rationed
    const lastTag = vs.find(v => v.outcome === "No answer — left tag");
    if (!lastTag || daysSince(lastTag.when) >= TAG_WAIT_DAYS) return { label: "Knock — tag OK", cls: "green", quote: false };
    const d = new Date(lastTag.when); d.setDate(d.getDate() + TAG_WAIT_DAYS);
    return { label: `Knock — no tag until ${d.getMonth() + 1}/${d.getDate()}`, cls: "green", quote: false };
  }
  if (home.notMovedIn) return { label: "Watch — move-in", cls: "purple", quote: false };
  return { label: "New — knock", cls: "green", quote: false };
}

function renderKnock() {
  const el = $("knockView");
  if (KV.level === "nbrs") {
    const rows = T.nbrs.map(n => {
      const count = T.homes.filter(h => h.nbrId === n.id).length;
      return `<button class="list-row" data-nbr="${esc(n.id)}"><span>${esc(n.name)}<span class="sub">${count} home${count === 1 ? "" : "s"}</span></span><span>›</span></button>`;
    }).join("");
    el.innerHTML = `<div class="card"><h2>MY NEIGHBORHOODS</h2>
      ${rows || `<div class="empty">No neighborhoods yet — add the one you're working.</div>`}
      <div class="addhome-row" style="margin-top:10px"><input type="text" id="nbrName" placeholder="Neighborhood name" style="flex:1" autocomplete="off"><button id="addNbr">Add</button></div></div>`;
    el.querySelectorAll("[data-nbr]").forEach(b => b.onclick = () => { KV = { ...KV, level: "homes", nbrId: b.dataset.nbr }; renderKnock(); });
    $("addNbr").onclick = () => {
      const name = $("nbrName").value.trim(); if (!name) return toast("Name it first");
      const id = tempId();
      T.nbrs.push({ id, name }); saveT();
      enqueue({ kind: "create", table: TBL.nbrs, tempId: id, fields: { Name: name } });
      KV = { ...KV, level: "homes", nbrId: id }; renderKnock(); toast(`Working ${name}`);
    };
    return;
  }

  const nbr = T.nbrs.find(n => n.id === KV.nbrId);
  if (!nbr) { KV.level = "nbrs"; return renderKnock(); }

  if (KV.level === "homes") {
    const homes = T.homes.filter(h => h.nbrId === nbr.id)
      .sort((a, b) => (a.street || "").localeCompare(b.street || "") || (parseInt(a.streetNo, 10) || 0) - (parseInt(b.streetNo, 10) || 0));
    const rows = homes.map(h => {
      const c = computeChip(h);
      return `<button class="list-row" data-home="${esc(h.id)}"><span>${esc(h.address)}</span><span class="chip ${c.cls}">${esc(c.label)}</span></button>`;
    }).join("");
    el.innerHTML = `<button class="crumb" id="backNbrs">‹ Neighborhoods</button>
      <div class="card"><h2>${esc(nbr.name).toUpperCase()}</h2>
        <div class="addhome-row"><input type="text" id="hNo" placeholder="No." inputmode="numeric" autocomplete="off"><input type="text" id="hStreet" placeholder="Street name" value="${esc(KV.lastStreet)}" autocomplete="off"><button id="addHome">Add</button></div>
        <details style="margin-top:8px"><summary class="note">+ note / photo / not moved in</summary>
          <input type="text" id="hNote" placeholder="Note (optional)" style="margin-top:8px" autocomplete="off">
          <input type="file" id="hPhoto" accept="image/*" capture="environment" style="margin-top:8px">
          <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:14px;color:var(--ink)"><input type="checkbox" id="hNotMoved" style="width:auto"> Fence is new, nobody moved in yet</label>
        </details>
        <div style="margin-top:12px">${rows || `<div class="empty">No homes logged here yet.</div>`}</div></div>`;
    $("backNbrs").onclick = () => { KV = { ...KV, level: "nbrs" }; renderKnock(); };
    el.querySelectorAll("[data-home]").forEach(b => b.onclick = () => { KV = { ...KV, level: "home", homeId: b.dataset.home }; renderKnock(); });
    $("addHome").onclick = async () => {
      const no = $("hNo").value.trim(), street = $("hStreet").value.trim();
      if (!no || !street) return toast("Number + street");
      const address = `${no} ${street}`;
      const id = tempId();
      const notMoved = $("hNotMoved").checked;
      const photoFile = $("hPhoto").files[0];
      const photo = photoFile ? await shrinkPhoto(photoFile) : null;
      const home = { id, nbrId: nbr.id, address, streetNo: no, street, notMovedIn: notMoved, note: $("hNote").value.trim(), leadIds: [] };
      T.homes.push(home); saveT();
      enqueue({ kind: "create", table: TBL.homes, tempId: id, photo, photoField: "Photos", fields: {
        Address: address, "Street No": no, Street: street, "Not Moved In": notMoved, Note: home.note, Neighborhood: [nbr.id] } });
      KV.lastStreet = street; renderKnock(); toast(`${address} added`);
    };
    return;
  }

  // home detail
  const home = T.homes.find(h => h.id === KV.homeId);
  if (!home) { KV.level = "homes"; return renderKnock(); }
  const chip = computeChip(home);
  const vs = T.visits.filter(v => v.homeId === home.id).sort((a, b) => new Date(b.when) - new Date(a.when));
  const history = vs.map(v => `<div class="visit-row"><span>${esc(v.outcome)}</span><span class="when">${fmtWhen(v.when)}</span></div>`).join("");
  const outcomeCls = { "Talked — interested": "o-amber", "Talked — gave quote": "o-blue", "Talked — not interested": "o-red", "No answer — left tag": "o-green", "No answer — no tag": "o-green" };
  el.innerHTML = `<button class="crumb" id="backHomes">‹ ${esc(nbr.name)}</button>
    <div class="card">
      <h2>${esc(home.address).toUpperCase()}</h2>
      <div style="margin:4px 0 10px"><span class="chip big ${chip.cls}">${esc(chip.label)}</span></div>
      ${home.note ? `<div class="note">${esc(home.note)}</div>` : ""}
      ${chip.quote && !home.leadIds.length ? `<button class="btn" id="quoteHome">Quote this home →</button>` : ""}
      <div class="outcome-btns">${OUTCOMES.map(o => `<button class="${outcomeCls[o]}" data-out="${esc(o)}">${esc(o)}</button>`).join("")}</div>
      <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:14px"><input type="checkbox" id="dNotMoved" style="width:auto" ${home.notMovedIn ? "checked" : ""}> Not moved in yet (watch)</label>
    </div>
    <div class="card"><h2>VISIT HISTORY</h2>${history || `<div class="empty">Never knocked.</div>`}</div>`;
  $("backHomes").onclick = () => { KV = { ...KV, level: "homes" }; renderKnock(); };
  el.querySelectorAll("[data-out]").forEach(b => b.onclick = () => {
    const outcome = b.dataset.out, when = new Date().toISOString();
    const v = { id: tempId(), homeId: home.id, outcome, when };
    T.visits.push(v); saveT();
    enqueue({ kind: "create", table: TBL.visits, tempId: v.id, fields: {
      Label: `${home.address} — ${fmtWhen(when)}`, Outcome: outcome, When: when, Home: [home.id] } });
    renderKnock(); toast("Visit logged");
  });
  $("dNotMoved").onchange = (e) => {
    home.notMovedIn = e.target.checked; saveT();
    enqueue({ kind: "patch", table: TBL.homes, recordId: home.id, fields: { "Not Moved In": home.notMovedIn } });
    renderKnock();
  };
  const qh = $("quoteHome");
  if (qh) qh.onclick = () => {
    localStorage.setItem("hfs_pending_home", JSON.stringify({ homeId: home.id, address: home.address }));
    document.querySelector('nav button[data-tab="quote"]').click();
    $("qAddress").value = home.address;
    toast("Address filled — build the quote");
  };
}

function shrinkPhoto(file) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      c.width = img.width * scale; c.height = img.height * scale;
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL("image/jpeg", 0.8));
    };
    img.src = URL.createObjectURL(file);
  });
}

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

  // territory hand-off: link the home this quote came from, if any and if unchanged
  let linkHome = null;
  try {
    const pend = JSON.parse(localStorage.getItem("hfs_pending_home") || "null");
    if (pend && pend.address === address) { linkHome = pend.homeId; }
  } catch (e) {}
  localStorage.removeItem("hfs_pending_home");

  enqueue({ kind: "create", linkHome, fields: {
    "Address": address, "Name": name, "Phone": phone, "Source": segVal("qSource"),
    "Status": phone ? "Quoted" : "New", "Linear Footage": totalFt, "Height Notes": noteHeight,
    "Stain Color": stain, "Rate per Ft": rate, "Quote Amount": total,
    "Quote Sent": todayISO(), "Notes": $("qNotes").value.trim(), "Quote No": quoteNo,
  }});
  if (linkHome) { const h = T.homes.find(x => x.id === linkHome); if (h) { h.leadIds = ["pending"]; saveT(); } }

  const file = new File([blob], `HFS Quote ${quoteNo}.pdf`, { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const cover = COVER(firstName(name));
  const rc = $("resultCard");
  rc.style.display = "block";
  rc.innerHTML = `<h2>QUOTE ${quoteNo} — $${fmtMoney(total)}</h2>
    <div class="note">${offlineNo ? "No signal — issued permanent field number " + quoteNo + ". It stays exactly this on the record when it syncs; it is never renumbered. " : ""}${phone ? "Logged as Quoted." : "No phone — logged as New; it'll sit in Missing Phone until you get a number."}${linkHome ? " Home marked in pipeline." : ""}</div>
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
  const row = (desc, qty, unit, cost) => {
    doc.text(desc, L + 10, y + 14); doc.text(qty, 300, y + 14); doc.text(unit, 390, y + 14);
    if (cost) doc.text(cost, R - 10, y + 14, { align: "right" });
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
      card.innerHTML = `<div class="name">${esc(f["Name"] || "—")}<span class="stage">${st.label}</span></div>
        <div class="meta">${esc(f["Address"] || "")} · quoted $${fmtMoney(f["Quote Amount"] || 0)}</div>
        <div class="draft">${esc(draft)}</div>
        <div class="fu-actions">
          <a class="primary" href="sms:${phone}&body=${encodeURIComponent(draft)}">Text</a>
          <button data-act="sent">Mark sent</button>
          <button data-act="pause">Pause</button>
          <button data-act="won">Won 🎉</button>
        </div>`;
      card.querySelector('[data-act="sent"]').onclick = () => {
        const fields = { [st.field]: true }; if (st.alsoThinking) fields["Status"] = "Thinking";
        enqueue({ kind: "patch", table: TBL.leads, recordId: rec.id, fields }); card.remove(); toast(`${st.label} marked sent`);
      };
      card.querySelector('[data-act="pause"]').onclick = () => {
        enqueue({ kind: "patch", table: TBL.leads, recordId: rec.id, fields: { "Paused": true } }); card.remove(); toast("Paused — they replied, you take it from here");
      };
      card.querySelector('[data-act="won"]').onclick = () => {
        enqueue({ kind: "patch", table: TBL.leads, recordId: rec.id, fields: { "Status": "Won" } }); card.remove(); toast("WON 🎉");
      };
      list.appendChild(card);
    });
  } catch (e) { list.innerHTML = `<div class="empty">Couldn't load (${esc(e.message)}). Check signal + token.</div>`; }
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
$("syncNow").onclick = async () => {
  toast("Syncing…"); flushQueue();
  try { await loadTerritory(); if (KV) renderKnock(); toast("Territory refreshed"); } catch (e) {}
};

// ---------- boot ----------
$("setupBanner").style.display = store.token ? "none" : "block";
updateQueueBadge(); flushQueue();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
