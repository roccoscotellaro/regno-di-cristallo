/*
 * Il Regno di Cristallo — dati e sincronizzazione (schema v1)
 *
 * Idea chiave: ogni telefono tiene la SUA copia completa della casa.
 * Il file sul cloud è solo il punto d'incontro. Sincronizzare = scaricare,
 * fondere, ricaricare. La fusione è commutativa e idempotente: l'ordine
 * delle sincronizzazioni non conta e ripeterla non fa danni.
 *
 * Unità di fusione: il singolo CAMPO di un record. Ogni campo ha un
 * timestamp (orologio logico ibrido); vince il più recente. Le eliminazioni
 * sono un campo come gli altri (`_deleted`), così non "resuscitano" per sbaglio.
 * L'XP è un registro di voci che si sommano, mai un contatore da sovrascrivere.
 */

export const SCHEMA = "regno-di-cristallo";
export const SCHEMA_VERSION = 1;
export const COLLECTIONS = ["players", "events", "meals", "shopping", "pantry", "rooms", "quests", "waste", "xp", "settings", "recipes", "achievements", "log", "birthdays"];

/* ---------- Orologio logico ibrido (HLC) ----------
 * Formato "000001727180000000:0003:dev_ab12": millisecondi, contatore, dispositivo.
 * Si confronta come stringa. Il contatore e l'osservazione dei timestamp altrui
 * proteggono dagli orologi dei telefoni non allineati. */
export class Clock {
  constructor(deviceId) { this.device = deviceId; this.l = 0; this.c = 0; }
  now() {
    const p = Date.now();
    if (p > this.l) { this.l = p; this.c = 0; } else { this.c++; }
    return `${String(this.l).padStart(15, "0")}:${String(this.c).padStart(4, "0")}:${this.device}`;
  }
  observe(ts) {
    if (!ts) return;
    const [l, c] = ts.split(":"); const L = +l, C = +c;
    if (L > this.l) { this.l = L; this.c = C; } else if (L === this.l && C > this.c) { this.c = C; }
  }
}

/* ---------- Documento vuoto ---------- */
export function emptyDoc(householdId) {
  const data = {}; COLLECTIONS.forEach(c => data[c] = {});
  return { schema: SCHEMA, schemaVersion: SCHEMA_VERSION, householdId, devices: {}, data };
}

const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));

/* ---------- Fusione ---------- */
export function mergeRecord(a, b) {
  if (!a) return clone(b);
  if (!b) return clone(a);
  const out = { id: a.id, _t: {} };
  const keys = new Set([...Object.keys(a._t || {}), ...Object.keys(b._t || {})]);
  for (const k of keys) {
    const ta = (a._t || {})[k] || "", tb = (b._t || {})[k] || "";
    const src = tb > ta ? b : a;
    out[k] = clone(src[k]); out._t[k] = src._t[k];
  }
  return out;
}

export function mergeDocs(a, b) {
  if (!a) return clone(b);
  if (!b) return clone(a);
  if (a.householdId !== b.householdId) throw new Error("I due salvataggi appartengono a case diverse.");
  const out = emptyDoc(a.householdId);
  out.schemaVersion = Math.max(a.schemaVersion, b.schemaVersion);
  for (const d of new Set([...Object.keys(a.devices), ...Object.keys(b.devices)])) {
    const x = a.devices[d], y = b.devices[d];
    out.devices[d] = !x ? clone(y) : !y ? clone(x) : ((y.lastSync || "") > (x.lastSync || "") ? clone(y) : clone(x));
  }
  for (const c of COLLECTIONS) {
    const A = a.data[c] || {}, B = b.data[c] || {};
    for (const id of new Set([...Object.keys(A), ...Object.keys(B)])) out.data[c][id] = mergeRecord(A[id], B[id]);
  }
  return out;
}

export function maxTimestamp(doc) {
  let m = "";
  for (const c of COLLECTIONS) for (const r of Object.values(doc.data[c] || {}))
    for (const t of Object.values(r._t || {})) if (t > m) m = t;
  return m;
}

/* Confronto stabile: due documenti sono uguali se hanno gli stessi dati. */
export function sameData(a, b) { return stable(a.data) === stable(b.data); }
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",")}}`;
  return JSON.stringify(v);
}

/* ---------- Store locale ---------- */
export class Store {
  constructor({ doc, deviceId, deviceName }) {
    this.deviceId = deviceId;
    this.clock = new Clock(deviceId);
    this.doc = doc;
    this.doc.devices[deviceId] ||= { name: deviceName, lastSync: null };
    for (const c of COLLECTIONS) this.doc.data[c] ||= {};   // file creati da versioni precedenti
    this.clock.observe(maxTimestamp(this.doc));
    this.listeners = new Set();
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach(fn => fn(this)); }

  put(coll, id, fields) {
    const rec = this.doc.data[coll][id] ||= { id, _t: {} };
    for (const [k, v] of Object.entries(fields)) { rec[k] = clone(v); rec._t[k] = this.clock.now(); }
    if (rec._deleted === undefined) { rec._deleted = false; rec._t._deleted = this.clock.now(); }
    this.emit(); return rec;
  }
  del(coll, id) { if (this.doc.data[coll][id]) this.put(coll, id, { _deleted: true }); }
  get(coll, id) { const r = this.doc.data[coll][id]; return r && !r._deleted ? r : null; }
  list(coll) { return Object.values(this.doc.data[coll]).filter(r => !r._deleted); }

  /* Modifiche locali non ancora viste dal cloud */
  pendingCount() {
    const since = this.doc.devices[this.deviceId].lastSyncMark || "";
    let n = 0;
    for (const c of COLLECTIONS) for (const r of Object.values(this.doc.data[c]))
      if (Object.values(r._t).some(t => t > since && t.endsWith(":" + this.deviceId))) n++;
    return n;
  }

  addXP(player, amount, reason) {
    const id = `xp_${this.clock.now()}`;
    const d = new Date(), date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    this.put("xp", id, { player, amount, reason, date });
  }
  xpTotal(player) { return this.list("xp").filter(x => !player || x.player === player).reduce((s, x) => s + x.amount, 0); }

  adopt(merged) { this.doc = merged; for (const c of COLLECTIONS) this.doc.data[c] ||= {}; this.clock.observe(maxTimestamp(merged)); this.emit(); }
}

/* ---------- Sincronizzazione ----------
 * 1. scarica il file dal cloud  2. fonde con la copia locale
 * 3. se il risultato contiene novità per il cloud, lo ricarica.
 * Se qualcuno scrive nello stesso istante e una scrittura va persa sul cloud,
 * non si perde nulla: le modifiche restano nella copia locale di chi le ha
 * fatte e tornano su alla sua prossima sincronizzazione. */
export class Syncer {
  constructor(store, adapter) { this.store = store; this.adapter = adapter; this.running = null; }
  sync() { return this.running ||= this._sync().finally(() => this.running = null); }
  async _sync() {
    const s = this.store;
    const remote = await this.adapter.read();
    let merged = remote.data ? mergeDocs(s.doc, remote.data) : clone(s.doc);
    const mark = s.clock.now();
    merged.devices[s.deviceId] = { ...merged.devices[s.deviceId], lastSync: new Date().toISOString(), lastSyncMark: mark };
    const needsUpload = !remote.data || !sameData(merged, remote.data);
    let result = { received: !!remote.data && !sameData(s.doc, merged), sent: false, version: remote.version };
    if (needsUpload) {
      const w = await this.adapter.write(merged, remote.version);
      if (w.conflict) {                         // il cloud è cambiato nel frattempo: si riparte
        s.adopt(merged); return this._sync();
      }
      result.sent = true; result.version = w.version;
    }
    s.adopt(merged);
    return result;
  }
}

/* ---------- Adattatore Google Drive ----------
 * Scope OAuth: https://www.googleapis.com/auth/drive.file
 * (l'app vede solo i file che ha creato o che l'utente le ha aperto).
 * getToken(): funzione che restituisce un access token valido
 * (su Capacitor, dal plugin di accesso Google). */
export class DriveAdapter {
  constructor({ getToken, fileId }) { this.getToken = getToken; this.fileId = fileId; }
  async _fetch(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${await this.getToken()}` } });
    if (!res.ok) { const e = new Error(`Drive ${res.status}`); e.status = res.status; throw e; }
    return res;
  }
  async read() {
    const base = `https://www.googleapis.com/drive/v3/files/${this.fileId}`;
    const meta = await (await this._fetch(`${base}?fields=version`)).json();
    const text = await (await this._fetch(`${base}?alt=media`)).text();
    return { data: text.trim() ? JSON.parse(text) : null, version: Number(meta.version) };
  }
  async write(doc, expectedVersion) {
    // Drive v3 non offre scritture condizionali: controllo la versione subito prima.
    // La piccola finestra residua è coperta dal fatto che ogni telefono conserva le sue modifiche.
    const meta = await (await this._fetch(`https://www.googleapis.com/drive/v3/files/${this.fileId}?fields=version`)).json();
    if (expectedVersion != null && Number(meta.version) !== expectedVersion) return { conflict: true };
    const res = await this._fetch(`https://www.googleapis.com/upload/drive/v3/files/${this.fileId}?uploadType=media&fields=version`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
    return { version: Number((await res.json()).version) };
  }
  /* Crea il file della casa nel Drive di chi lo fonda. */
  static async create({ getToken, name = "regno-di-cristallo.json", doc }) {
    const boundary = "regno" + Math.random().toString(36).slice(2);
    const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ name, mimeType: "application/json" })}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(doc)}\r\n--${boundary}--`;
    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      { method: "POST", headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body });
    if (!res.ok) throw new Error(`Drive ${res.status}`);
    return new DriveAdapter({ getToken, fileId: (await res.json()).id });
  }
  /* Condivide il file con l'altra persona come editor. */
  async shareWith(email) {
    await this._fetch(`https://www.googleapis.com/drive/v3/files/${this.fileId}/permissions?sendNotificationEmail=true`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "writer", type: "user", emailAddress: email }) });
  }
}

/* ---------- Cloud simulato (test e sviluppo) ----------
 * Si comporta come Drive: numero di versione che cresce a ogni scrittura. */
export class MemoryCloud {
  constructor() { this.data = null; this.version = 1; this.log = []; }
  adapter(name, isOnline = () => true) {
    const cloud = this;
    return {
      async read() { if (!isOnline()) throw new Error("offline"); await wait(); return { data: clone(cloud.data), version: cloud.version }; },
      async write(doc, expected) {
        if (!isOnline()) throw new Error("offline"); await wait();
        if (expected != null && expected !== cloud.version) return { conflict: true };
        cloud.data = clone(doc); cloud.version++; cloud.log.unshift({ by: name, version: cloud.version, at: new Date() });
        return { version: cloud.version };
      }
    };
  }
}
const wait = () => new Promise(r => setTimeout(r, 150 + Math.random() * 200));
