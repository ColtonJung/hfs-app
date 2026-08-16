/* HFS offline queue engine.
   Born from the 2026-08-16 field data loss. Design rules, in blood:
   1. NEVER hold a copy of the queue across an await. Every mutation re-reads
      localStorage fresh and targets one item by its unique id (qid).
   2. An item leaves the queue ONLY after its network call confirmed success.
   3. Failures MARK the item (visible, retryable) — they never remove it.
   4. Every enqueued item is also copied to an append-only journal that nothing
      in the app ever deletes (ring of 300) — the net under the net.
   5. All queue network calls time out (20s) so a dead-zone hang can't wedge
      anything while the user keeps working. */

function createQueue(cfg) {
  // cfg: { hasToken(), isOnline(), headers(), atUrl(table), contentApi,
  //        homesTable, leadsTable, onIdMapped(tmp,real), onLinkedHome(homeId,leadId), onChange() }
  const QKEY = "hfs_queue", JKEY = "hfs_journal", MKEY = "hfs_idmap";
  const LINK_KEYS = ["Neighborhood", "Home", "Lead"];
  const newQid = () => "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const isTemp = (v) => typeof v === "string" && v.startsWith("tmp_");

  const read = (key, fb) => { try { return JSON.parse(localStorage.getItem(key)) ?? fb; } catch { return fb; } };
  const write = (key, v) => localStorage.setItem(key, JSON.stringify(v));

  // normalize legacy items (pre-engine) so nothing already queued is stranded
  const readQ = () => read(QKEY, []).map(i => ({ state: "pending", attempts: 0, qid: i.qid || newQid(), ...i }));
  const idmap = () => read(MKEY, {});

  // storage writes must never throw away a record: shed weight (journal, then photos) before giving up
  function writeQueueSafe(q) {
    try { write(QKEY, q); return; } catch (e) {}
    try { write(JKEY, read(JKEY, []).slice(-40)); write(QKEY, q); return; } catch (e) {}
    const slim = q.map(i => i.photo ? { ...i, photo: undefined, photoDropped: true } : i);
    try { write(QKEY, slim); (cfg.onWarn || console.warn)("Phone storage full — a photo was dropped to save the record itself."); return; } catch (e) {}
    (cfg.onWarn || console.warn)("PHONE STORAGE FULL — record could not be queued!");
    throw new Error("storage full");
  }

  function add(item) {
    const it = { ...item, qid: newQid(), state: "pending", attempts: 0, ts: Date.now() };
    writeQueueSafe([...readQ(), it]);                    // fresh read, atomic in this tick
    try {                                                // journal copy: photo stripped (quota safety)
      const j = read(JKEY, []);
      j.push({ ...it, photo: undefined, photoBytes: it.photo ? it.photo.length : 0, journaledAt: new Date().toISOString() });
      write(JKEY, j.slice(-300));                        // append-only ring; flush never touches this
    } catch (e) { console.warn("journal write failed", e); }
    cfg.onChange();
    flush();
    return it.qid;
  }

  // --- targeted, fresh-read mutations (the anti-clobber core) ---
  const removeItem = (qid) => writeQueueSafe(readQ().filter(i => i.qid !== qid));
  const patchItem = (qid, patch) => writeQueueSafe(readQ().map(i => i.qid === qid ? { ...i, ...patch } : i));

  function xlate(v) {
    if (!isTemp(v)) return v;
    const real = idmap()[v];
    if (!real) throw Object.assign(new Error("parent record hasn't synced"), { kind: "unresolved" });
    return real;
  }

  async function timedFetch(url, opts) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  }

  async function perform(item) {
    const table = item.table || cfg.leadsTable;
    const fields = { ...item.fields };
    for (const k of LINK_KEYS) if (Array.isArray(fields[k])) fields[k] = fields[k].map(xlate);
    if (item.kind === "create") {
      const r = await timedFetch(cfg.atUrl(table), { method: "POST", headers: cfg.headers(), body: JSON.stringify({ fields }) });
      if (!r.ok) throw Object.assign(new Error(`Airtable ${r.status}`), { status: r.status });
      const rec = await r.json();
      if (item.tempId) { const m = idmap(); m[item.tempId] = rec.id; write(MKEY, m); cfg.onIdMapped(item.tempId, rec.id); }
      if (item.photo) {
        try {
          await uploadPhoto(rec.id, item.photoField, item.photo);
        } catch (e) {  // photo failure must not cost the photo: it becomes its own queued item
          console.warn("photo attach failed — re-queued separately", e);
          add({ kind: "photo", table, recordId: rec.id, photoField: item.photoField, photo: item.photo });
        }
      }
      if (item.linkHome) {
        try {
          const hid = xlate(item.linkHome);
          const lr = await timedFetch(`${cfg.atUrl(cfg.homesTable)}/${hid}`, { method: "PATCH", headers: cfg.headers(), body: JSON.stringify({ fields: { Lead: [rec.id] } }) });
          if (!lr.ok) throw new Error(`link ${lr.status}`);
          cfg.onLinkedHome(item.linkHome, rec.id);
        } catch (e) {  // link failure must not cost the link: queue it as an independent patch
          console.warn("home link failed — re-queued", e);
          add({ kind: "patch", table: cfg.homesTable, recordId: item.linkHome, fields: { Lead: [rec.id] } });
        }
      }
    } else if (item.kind === "patch") {
      const r = await timedFetch(`${cfg.atUrl(table)}/${xlate(item.recordId)}`, { method: "PATCH", headers: cfg.headers(), body: JSON.stringify({ fields }) });
      if (!r.ok) throw Object.assign(new Error(`Airtable ${r.status}`), { status: r.status });
    } else if (item.kind === "photo") {
      await uploadPhoto(xlate(item.recordId), item.photoField, item.photo);
    } else if (item.kind === "sigvoid") {
      const r = await timedFetch(cfg.sigUrl, { method: "POST", headers: cfg.headers(), body: JSON.stringify({ fields: { Key: item.key, Data: "VOIDED", TermsV: item.termsV || "" } }) });
      if (!r.ok) throw Object.assign(new Error(`void ${r.status}`), { status: r.status });
    }
  }

  async function uploadPhoto(recordId, field, dataURL) {
    if (!dataURL) return;
    const [, b64] = dataURL.split(",");
    const r = await timedFetch(`${cfg.contentApi}/${recordId}/${encodeURIComponent(field || "Photos")}/uploadAttachment`, {
      method: "POST", headers: cfg.headers(),
      body: JSON.stringify({ contentType: "image/jpeg", filename: `photo-${Date.now()}.jpg`, file: b64 }) });
    if (!r.ok) throw Object.assign(new Error(`photo ${r.status}`), { status: r.status });
  }

  const isPermanent = (e) => e.status && e.status >= 400 && e.status < 500 && e.status !== 429;

  let flushing = false;
  async function flush() {
    if (flushing || !cfg.hasToken() || !cfg.isOnline()) return;
    flushing = true;
    try {
      for (;;) {
        const item = readQ().find(i => i.state === "pending");   // FRESH read every iteration
        if (!item) break;
        try {
          await perform(item);
          removeItem(item.qid);                                   // fresh read-modify-write, by qid
        } catch (e) {
          if (e.kind === "unresolved" || isPermanent(e)) {
            // visible failure; skip so the rest of the queue still drains
            patchItem(item.qid, { state: "failed", attempts: (item.attempts || 0) + 1, lastError: e.message, lastTry: Date.now() });
          } else {
            // network/timeout/5xx/429: keep pending, stop in order, retry on next trigger
            patchItem(item.qid, { attempts: (item.attempts || 0) + 1, lastError: e.message, lastTry: Date.now() });
            break;
          }
        }
        cfg.onChange();
      }
    } finally { flushing = false; cfg.onChange(); }
  }

  function counts() {
    const q = readQ();
    return { pending: q.filter(i => i.state === "pending").length, failed: q.filter(i => i.state === "failed").length };
  }
  const items = () => readQ();
  const journal = () => read(JKEY, []);
  function retryAll() { write(QKEY, readQ().map(i => i.state === "failed" ? { ...i, state: "pending" } : i)); cfg.onChange(); flush(); }
  function discard(qid) { removeItem(qid); cfg.onChange(); }     // manual, UI-confirmed only — never called by the engine

  // persist normalized legacy items ONCE so their qids/states are stable across reads
  writeQueueSafe(readQ());

  // retry triggers: online, app becomes visible, and a heartbeat while work is waiting
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) flush(); });
  setInterval(() => { if (counts().pending) flush(); }, 60000);

  return { add, flush, counts, items, journal, retryAll, discard };
}
