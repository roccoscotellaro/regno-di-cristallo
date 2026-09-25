import { Store, Syncer, DriveAdapter, emptyDoc, mergeDocs } from "./regno-sync.js";
import { CONFIG } from "./config.js";
import * as G from "./drive.js";
import { deliver, askPermission, wasteICS, shareOrDownload } from "./notify.js";

export const VERSION = "1.1.0";

/* ---------- Errori visibili: se qualcosa si rompe, lo si legge sullo schermo ---------- */
function showError(msg) {
  let el = document.getElementById("errbar");
  if (!el) { el = document.createElement("div"); el.id = "errbar"; el.setAttribute("role", "alert"); document.body.appendChild(el);
    el.addEventListener("click", () => el.remove()); }
  el.textContent = "Errore: " + msg + " (tocca per chiudere)";
}
window.addEventListener("error", e => showError(e.message || "sconosciuto"));
window.addEventListener("unhandledrejection", e => showError(e.reason?.message || String(e.reason)));

/* ---------- Archivio del dispositivo ---------- */
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};
const K = { device: "regno.device", doc: "regno.doc", file: "regno.fileId", me: "regno.me", chat: "regno.chat", ai: "regno.aikey", intent: "regno.intent", mode: "regno.mode", gem: "regno.gemkey", oracle: "regno.oracle" };

/* ---------- Date ---------- */
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
let TODAY = iso(new Date());
const DOW = ["D", "L", "M", "M", "G", "V", "S"];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const fmtLong = s => parse(s).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const at = (dateStr, hh, mm = 0) => { const d = parse(dateStr); d.setHours(hh, mm, 0, 0); return d.getTime(); };

/* ---------- Stato ---------- */
let store = null, syncer = null, syncState = "local";
let tab = "oggi", selDay = TODAY, spesaTab = "lista", busy = false;
const device = LS.get(K.device) || (() => { const d = { id: "dev_" + uid(), name: /iPhone/.test(navigator.userAgent) ? "iPhone" : "Dispositivo" }; LS.set(K.device, d); return d; })();

/* ---------- Letture comode ---------- */
const L = c => store.list(c);
const players = () => L("players").sort((a, b) => a.id.localeCompare(b.id));
const me = () => LS.get(K.me) || players()[0]?.id;
const pname = id => store.get("players", id)?.name || "Qualcuno";
const rooms = () => L("rooms").sort((a, b) => (a.order || 0) - (b.order || 0)).map(r => ({ ...r, quests: L("quests").filter(q => q.roomId === r.id) }));
const eventsOn = d => L("events").filter(e => !e.skip?.includes(d) && (e.date === d || (e.repeat === "weekly" && e.date <= d && parse(e.date).getDay() === parse(d).getDay())))
  .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
const meal = d => store.get("meals", d) || { pranzo: "", cena: "" };
const lateTonight = () => !!store.get("settings", "late-" + TODAY)?.value;
const bins = () => L("waste").sort((a, b) => (a.order || 0) - (b.order || 0));
const wasteOn = d => { const dow = parse(d).getDay(); return bins().filter(b => (b.days || []).includes(dow)).map(b => b.name); };
function questState(q) { const due = q.last ? diffDays(q.last, TODAY) - q.every : 1; return due < 0 ? "ok" : due === 0 ? "due" : "over"; }
function roomState(r) { const st = r.quests.map(questState); return st.includes("over") ? "over" : st.includes("due") ? "due" : "clean"; }
const dueQuests = () => rooms().flatMap(r => r.quests.filter(q => questState(q) !== "ok").map(q => ({ ...q, room: r })));
const daysLeft = p => p.expires ? diffDays(TODAY, p.expires) : null;

/* ---------- Ricette ---------- */
const STAPLES = new Set(["aglio", "olio", "sale", "pepe", "cipolla", "acqua"]);
const BASE_RECIPES = [
  ["Pasta zucchine e ricotta", ["pasta", "zucchine", "ricotta"], 20], ["Gnudi ricotta e spinaci", ["spinaci", "ricotta", "farina", "uova"], 30],
  ["Frittata di spinaci", ["spinaci", "uova"], 15], ["Frittata di zucchine", ["zucchine", "uova"], 15],
  ["Risotto zucchine e spinaci", ["riso", "zucchine", "spinaci"], 25], ["Pasta al pomodoro", ["pasta", "passata"], 15],
  ["Uova strapazzate e pane tostato", ["uova", "pane"], 10], ["Riso saltato con verdure", ["riso", "verdure miste"], 20],
  ["Spaghetti aglio, olio e peperoncino", ["spaghetti"], 12], ["Spaghetti alle vongole", ["spaghetti", "vongole"], 20],
  ["Pollo al forno con patate", ["pollo", "patate"], 60], ["Minestrone", ["verdure miste", "patate"], 40],
  ["Orecchiette con cime di rapa", ["orecchiette", "cime di rapa"], 25], ["Fave e cicorie", ["fave secche", "cicoria"], 60],
  ["Tiella di patate, riso e cozze", ["patate", "riso", "cozze"], 75], ["Pizza fatta in casa", ["farina", "mozzarella", "passata"], 90],
  ["Salmone e insalata", ["salmone", "insalata"], 20], ["Risotto ai funghi", ["riso", "funghi"], 30],
  ["Pasta e ceci", ["pasta", "ceci"], 30], ["Hamburger e verdure grigliate", ["hamburger", "zucchine"], 25],
  ["Zuppa di legumi", ["legumi misti"], 40], ["Piadina con prosciutto e rucola", ["piadine", "prosciutto", "rucola"], 10],
  ["Pasta e patate", ["pasta", "patate"], 35], ["Melanzane alla parmigiana", ["melanzane", "passata", "mozzarella", "parmigiano"], 90],
  ["Polpette al sugo", ["carne macinata", "uova", "pane", "passata"], 50], ["Insalata di farro", ["farro", "pomodori"], 30],
  ["Toast e insalata", ["pane", "prosciutto", "formaggio", "insalata"], 10], ["Omelette al formaggio", ["uova", "formaggio"], 10],
  ["Pasta tonno e pomodorini", ["pasta", "tonno", "pomodori"], 15], ["Cous cous con verdure", ["cous cous", "verdure miste"], 15],
].map(([n, i, min], k) => ({ id: "b_" + k, n, i, min, builtin: true }));
function allRecipes() {
  const own = store.doc.data.recipes || {};
  const base = BASE_RECIPES.map(b => { const o = own[b.id]; return o && !o._deleted ? { ...b, ...clean(o), id: b.id, builtin: true } : b; });
  const mine = Object.values(own).filter(r => !r._deleted && !r.id.startsWith("b_")).map(r => ({ ...clean(r), id: r.id }));
  return [...base, ...mine].filter(r => !r.hidden && r.n);
}
const clean = r => { const { _t, _deleted, ...x } = r; return x; };
const has = name => L("pantry").some(p => p.name.toLowerCase() === name && (daysLeft(p) === null || daysLeft(p) >= 0));
const missing = r => (r.i || []).map(x => x.toLowerCase()).filter(x => !STAPLES.has(x) && !has(x));
function recipeFor(items) {
  const names = items.map(p => p.name.toLowerCase());
  return allRecipes().map(r => ({ ...r, score: (r.i || []).filter(x => names.includes(x.toLowerCase())).length }))
    .filter(r => r.score >= 2 && !missing(r).length).sort((a, b) => b.score - a.score || (b.fav ? 1 : 0) - (a.fav ? 1 : 0))[0];
}
const quickMeal = (excl = new Set()) => allRecipes().filter(r => (r.min || 99) <= 15 && !missing(r).length && !excl.has(r.n)).sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0))[0] || { n: "Piadina con quello che c'è", min: 10, i: [] };

const logIt = (type, name, count = 1) => store.put("log", "l_" + uid(), { type, name, count, date: TODAY, by: me() });

/* ---------- Casa nuova ---------- */
function seedHouse(s, { n1, n2, demo }) {
  const T = TODAY;
  s.put("players", "p1", { name: n1 || "Giocatore 1" });
  s.put("players", "p2", { name: n2 || "Giocatore 2" });
  s.put("settings", "household", { name: "Il Regno di Cristallo" });
  const R = [["ingresso", "Ingresso", "🚪"], ["balcone", "Balcone", "🌿"], ["cucina", "Cucina", "🍳"], ["soggiorno", "Soggiorno", "🛋️"], ["bagno", "Bagno", "🛁"], ["camera", "Camera", "🛏️"], ["studio", "Studio", "🎲"]];
  R.forEach(([id, name, e], i) => s.put("rooms", id, { name, e, order: i }));
  const Q = [["ingresso", "Pulire la scarpiera", 30, -5, 10], ["balcone", "Innaffiare le piante", 2, -2, 5], ["cucina", "Lavare i piatti", 1, -1, 5],
    ["cucina", "Sgrassare il piano cottura", 3, -1, 10], ["cucina", "Pulire il frigo", 14, -20, 25], ["soggiorno", "Aspirapolvere", 3, -3, 15],
    ["soggiorno", "Spolverare", 7, -2, 10], ["bagno", "Pulire il bagno", 7, -8, 25], ["bagno", "Cambiare gli asciugamani", 4, -2, 5],
    ["camera", "Cambiare le lenzuola", 7, -7, 15], ["studio", "Riordinare la scrivania", 7, -1, 10]];
  Q.forEach(([roomId, title, every, last, xp]) => s.put("quests", "q_" + uid(), { roomId, title, every, last: demo ? addDays(T, last) : null, xp }));
  [["umido", "Umido", [1, 4]], ["plastica", "Plastica", [3]], ["carta", "Carta", [5]], ["vetro", "Vetro", [2]], ["indiff", "Indifferenziato", [6]]]
    .forEach(([id, name, days], i) => s.put("waste", id, { name, days, order: i }));
  if (!demo) return;
  [["Palestra", 0, "18:30", "attività", false], ["Dentista", 1, "17:00", "evento", false], ["Turno in negozio", 2, "21:00", "attività", true], ["Serata giochi da tavolo", 4, "21:00", "evento", false]]
    .forEach(([title, d, time, type, late]) => s.put("events", "e_" + uid(), { title, date: addDays(T, d), time, type, late }));
  s.put("meals", T, { pranzo: "Insalata di farro", cena: "" });
  s.put("meals", addDays(T, 1), { pranzo: "", cena: "Pizza fatta in casa" });
  ["Latte", "Pane", "Pomodori"].forEach((name, i) => s.put("shopping", "s_" + uid(), { name, done: false, order: i }));
  [["Zucchine", 1], ["Spinaci", 1], ["Ricotta", 2], ["Yogurt", -1], ["Uova", 6], ["Pasta", null], ["Riso", null], ["Passata", null]]
    .forEach(([name, d]) => s.put("pantry", "p_" + uid(), { name, expires: d === null ? null : addDays(T, d) }));
}

/* ---------- Avvio ---------- */
function openStore(doc) {
  store = new Store({ doc, deviceId: device.id, deviceName: device.name });
  store.onChange(() => { LS.set(K.doc, store.doc); render(); scheduleSync(); scheduleReminders(); checkAchievements(); });
  LS.set(K.doc, store.doc);
  const fileId = LS.get(K.file);
  syncer = fileId ? new Syncer(store, new DriveAdapter({ getToken: G.getToken, fileId })) : null;
  syncState = fileId ? (G.currentToken() ? "ok" : "login") : "local";
}

async function boot() {
  G.handleRedirect();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const saved = LS.get(K.doc);
  if (saved) openStore(saved);
  const intent = LS.get(K.intent);
  if (intent) { LS.del(K.intent); if (G.currentToken()) await runIntent(intent); }
  render();
  if (store) { scheduleReminders(); if (syncer) doSync(); }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && store) { refreshDay(); if (syncer) doSync(); } });
  setInterval(() => { if (store && syncer && document.visibilityState === "visible") doSync(); }, 5 * 60e3);
}
function refreshDay() { const t = iso(new Date()); if (t !== TODAY) { TODAY = t; selDay = t; render(); scheduleReminders(); } }

async function runIntent(intent) {
  try {
    if (intent.action === "found") {
      const doc = emptyDoc("casa_" + uid());
      openStore(doc);
      seedHouse(store, intent);
      LS.set(K.me, "p1");
      const adapter = await DriveAdapter.create({ getToken: G.getToken, name: CONFIG.fileName, doc: store.doc });
      LS.set(K.file, adapter.fileId); LS.set(K.mode, "drive");
      syncer = new Syncer(store, adapter); syncState = "ok";
      if (intent.email) { await adapter.shareWith(intent.email); toast("Casa fondata e condivisa"); } else toast("Casa fondata su Drive");
    }
    if (intent.action === "join") {
      const fileId = await G.pickHouseFile();
      if (!fileId) { toast("Nessun file scelto"); return; }
      const adapter = new DriveAdapter({ getToken: G.getToken, fileId });
      const remote = await adapter.read();
      if (!remote.data || remote.data.schema !== "regno-di-cristallo") { toast("Questo file non è un salvataggio del Regno"); return; }
      LS.set(K.file, fileId); LS.set(K.mode, "drive"); LS.set(K.me, intent.me || "p2");
      openStore(remote.data);
      toast("Sei entrato nel Regno");
    }
    if (intent.action === "sync") doSync();
    if (intent.action === "link" && store) {
      const adapter = await DriveAdapter.create({ getToken: G.getToken, name: CONFIG.fileName, doc: store.doc });
      LS.set(K.file, adapter.fileId); LS.set(K.mode, "drive");
      syncer = new Syncer(store, adapter); syncState = "ok"; toast("Casa salvata su Drive");
    }
  } catch (e) { toast("Qualcosa non è andato: " + (e.message || e)); }
}

/* ---------- Sincronizzazione ---------- */
let syncTimer;
function scheduleSync() { if (!syncer) return; clearTimeout(syncTimer); syncTimer = setTimeout(doSync, 3000); }
async function doSync() {
  if (!syncer || syncState === "syncing") return;
  if (!navigator.onLine) { syncState = "offline"; paintSync(); return; }
  if (!G.currentToken()) { syncState = "login"; paintSync(); return; }
  syncState = "syncing"; paintSync();
  try { const r = await syncer.sync(); syncState = "ok"; if (r.received) toast("Aggiornato con le modifiche dell'altro telefono"); }
  catch (e) { syncState = e.code === "login" || e.status === 401 ? "login" : navigator.onLine ? "error" : "offline"; }
  paintSync();
}
function paintSync() {
  const el = document.getElementById("syncpill"); if (!el) return;
  const n = store ? store.pendingCount() : 0;
  const label = { local: "solo qui", ok: n ? `${n} da inviare` : "in pari", syncing: "sincronizzo", offline: "offline", login: "accedi", error: "riprova" }[syncState];
  el.dataset.s = syncState; el.querySelector("span").textContent = label;
  el.setAttribute("aria-label", "Sincronizzazione: " + label);
  el.hidden = !store;
}

/* ---------- Promemoria ---------- */
function computeReminders() {
  const out = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(TODAY, i), b = wasteOn(addDays(d, 1));
    if (b.length) out.push({ id: "waste-" + d, at: at(d, 20), title: `Stasera porta fuori: ${b.join(", ")}`, body: "La raccolta passa domani mattina." });
  }
  const pantry = L("pantry").filter(p => p.expires);
  for (let i = 0; i < 7; i++) {
    const d = addDays(TODAY, i);
    const soon = pantry.filter(p => { const x = diffDays(d, p.expires); return x >= 0 && x <= 1; });
    if (soon.length >= 2) {
      const r = recipeFor(soon);
      out.push({ id: "exp-" + d, at: at(d, 17, 30), title: `${soon.map(p => p.name).join(", ")} scadono presto`, body: r ? `Idea per cena: ${r.n} (${r.min} min).` : "Apri l'Oracolo per una ricetta che li usi." });
    }
  }
  for (let i = 0; i < 14; i++) { const d = addDays(TODAY, i); if (parse(d).getDay() === 1) out.push({ id: "cron-" + d, at: at(d, 9), title: "La cronaca della settimana", body: "Com'è andata nel Regno: apri la sala del trono." }); }
  const lateDays = new Set([...Array(14)].map((_, i) => addDays(TODAY, i)).filter(d => eventsOn(d).some(e => e.late)));
  if (lateTonight()) lateDays.add(TODAY);
  lateDays.forEach(d => { const q = quickMeal(); out.push({ id: "late-" + d, at: at(d, 17), title: "Stasera rientro tardi", body: `Pasto rapido: ${q.n} (${q.min} min).` }); });
  return out;
}
let remTimer;
function scheduleReminders() { clearTimeout(remTimer); remTimer = setTimeout(() => deliver(computeReminders()).catch(() => {}), 800); }

function alerts() {
  const out = [];
  const b = wasteOn(addDays(TODAY, 1));
  if (b.length) out.push({ c: "var(--amber)", ic: "🗑️", t: `Stasera porta fuori: ${b.join(", ")}`, p: "La raccolta passa domani mattina." });
  const soon = L("pantry").filter(p => { const d = daysLeft(p); return d !== null && d >= 0 && d <= 2; });
  if (soon.length >= 2) {
    const r = recipeFor(soon), names = soon.map(p => p.name.toLowerCase());
    out.push({ c: "var(--teal)", ic: "🥬", t: `${names.slice(0, -1).join(", ")} e ${names.at(-1)} scadono presto`,
      p: r ? `Idea: ${r.n} (${r.min} min).` : "Chiedi all'Oracolo una ricetta che li usi tutti.",
      acts: r ? [{ a: "set-dinner", v: r.n, l: "Metti a cena stasera" }] : [{ a: "ask", v: `Cosa cucino con ${names.join(", ")}?`, l: "Chiedi all'Oracolo" }] });
  }
  L("pantry").filter(p => daysLeft(p) !== null && daysLeft(p) < 0).forEach(p =>
    out.push({ c: "var(--rose)", ic: "⚠️", t: `${p.name} è scaduto`, p: "Toglilo dall'inventario per tenere pulita la dispensa.", acts: [{ a: "pantry-del", v: p.id, l: "Rimuovi" }] }));
  if (lateTonight() || eventsOn(TODAY).some(e => e.late)) {
    const q = quickMeal();
    out.push({ c: "var(--amethyst)", ic: "🌙", t: "Rientro tardi stasera", p: `Pasto rapido con quello che avete: ${q.n} (${q.min} min).`, acts: [{ a: "set-dinner", v: q.n, l: "Metti a cena" }] });
  }
  if (parse(TODAY).getDay() === 1 && L("xp").some(x => x.date && x.date >= addDays(TODAY, -7))) out.push({ c: "var(--gold)", ic: "📖", t: "La cronaca della settimana è pronta", p: "Chi ha fatto cosa, cosa è entrato in dispensa, le nuove imprese.", acts: [{ a: "throne", v: "", l: "Apri la sala del trono" }] });
  const over = dueQuests().filter(q => questState(q) === "over").length;
  if (over) out.push({ c: "var(--rose)", ic: "🛡️", t: `${over} ${over === 1 ? "quest in ritardo" : "quest in ritardo"}`, p: "Completale per riportare gli stemmi all'oro.", acts: [{ a: "tab", v: "casa", l: "Apri la mappa" }] });
  return out;
}

/* ---------- Render ---------- */
const $ = s => document.querySelector(s);
const TITLES = ["Scudieri", "Cavalieri", "Baroni", "Visconti", "Conti", "Marchesi", "Duchi", "Principi", "Sovrani del Regno"];
function renderXP() {
  if (!store) { $("#xp").innerHTML = ""; return; }
  const x = store.xpTotal(), lvl = Math.floor(x / 150) + 1, cur = Math.round((x % 150) / 1.5);
  const title = TITLES[Math.min(lvl - 1, TITLES.length - 1)];
  $("#xp").setAttribute("role", "button"); $("#xp").tabIndex = 0; $("#xp").dataset.action = "throne"; $("#xp").setAttribute("aria-label", "Apri la sala del trono");
  $("#xp").innerHTML = `<b>${title}</b><span>liv. ${lvl}</span><div class="bar" aria-label="Esperienza"><i style="width:${cur}%"></i></div><span>${x % 150} / 150</span>`;
}
function render() {
  paintSync();
  $("#tabs").hidden = !store;
  renderXP();
  if (!store) { $("#view").innerHTML = vWelcome(); return; }
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-current", b.dataset.tab === tab ? "page" : "false"));
  const active = document.activeElement?.id;
  $("#view").innerHTML = ({ oggi: vOggi, settimana: vSettimana, spesa: vSpesa, casa: vCasa, oracolo: vOracolo })[tab]();
  if (active && document.getElementById(active) && /^(shop-in|ask-in|pan-in|evt)$/.test(active)) document.getElementById(active).focus();
  if (tab === "oracolo") $("#chatlog")?.lastElementChild?.scrollIntoView({ block: "end" });
}

function vWelcome() {
  const configured = !CONFIG.googleClientId.startsWith("INSERISCI");
  return `<div class="welcome">
    <div class="crest" aria-hidden="true">💎</div>
    <h2>Benvenuto nel Regno</h2>
    <p class="sub">Un salvataggio condiviso su Google Drive, una copia completa su ogni telefono.</p>
    <div class="choice"><h3>Fonda la casa</h3>
      <p class="note" style="margin:0 0 10px">Lo fa una sola persona: crea il file nel suo Drive e lo condivide.</p>
      <div class="stack">
        <input class="field" id="w-n1" placeholder="Il tuo nome" autocomplete="given-name">
        <input class="field" id="w-n2" placeholder="Nome dell'altra persona">
        <input class="field" id="w-mail" type="email" placeholder="Email Google dell'altra persona (facoltativa)">
        <button class="btn" data-action="found" ${configured ? "" : "disabled"}>Fonda con Google Drive</button>
      </div></div>
    <div class="choice"><h3>Unisciti alla casa</h3>
      <p class="note" style="margin:0 0 10px">Per chi ha ricevuto il file condiviso: accedi e sceglilo dal tuo Drive.</p>
      <button class="btn" data-action="join" ${configured ? "" : "disabled"}>Scegli il file del Regno</button></div>
    <div class="choice"><h3>Prova senza account</h3>
      <p class="note" style="margin:0 0 10px">Dati di esempio salvati solo su questo telefono. Potrai collegare Drive dopo.</p>
      <button class="btn ghost" data-action="demo">Entra con la casa di prova</button></div>
    ${configured ? "" : `<p class="note">Per usare Drive compila prima <b>config.js</b> (vedi README).</p>`}
    <p class="note" style="text-align:center">Versione ${VERSION}</p>
  </div>`;
}

function vOggi() {
  const al = alerts(), ev = eventsOn(TODAY), m = meal(TODAY), qs = dueQuests().slice(0, 5);
  return `
  <h2>Salve, ${esc(pname(me()))}</h2>
  <p class="sub">${esc(fmtLong(TODAY))}</p>
  ${al.map(a => `<div class="alert" style="--c:${a.c}"><div class="ic" aria-hidden="true">${a.ic}</div><div class="grow">
    <div class="t">${esc(a.t)}</div><p>${esc(a.p)}</p>
    ${a.acts ? `<div class="acts">${a.acts.map(x => `<button class="btn small" data-action="${x.a}" data-v="${esc(x.v)}">${esc(x.l)}</button>`).join("")}</div>` : ""}
  </div></div>`).join("") || `<p class="empty">Nessun avviso. Il regno è in pace.</p>`}
  <div class="late"><div><div style="font-weight:800">Rientro tardi stasera</div><div style="font-size:.86rem;color:var(--muted)">Ti propongo un pasto rapido</div></div>
    <button class="switch" role="switch" aria-checked="${lateTonight()}" data-action="toggle-late" aria-label="Rientro tardi stasera"></button></div>
  <h3>Quest di oggi</h3>
  <div class="panel">${qs.map(q => `<div class="row">
    <button class="chk" data-action="quest" data-v="${q.id}" aria-label="Completa ${esc(q.title)}"></button>
    <div class="grow"><div class="t">${esc(q.title)}</div><div class="m">${q.room.e} ${esc(q.room.name)}${q.assignee ? `, tocca a ${esc(pname(q.assignee))}` : ""}</div></div>
    <span class="tag ${questState(q) === "over" ? "rose" : "amber"}">+${q.xp} XP</span></div>`).join("") || `<p class="empty">Tutte le quest sono completate.</p>`}</div>
  <h3>In agenda</h3>
  <div class="panel">
    <div class="row"><div class="grow"><div class="m">Pranzo</div><div class="t">${esc(m.pranzo || "Da decidere")}</div></div></div>
    <div class="row"><div class="grow"><div class="m">Cena</div><div class="t">${esc(m.cena || "Da decidere")}</div></div></div>
    ${ev.map(e => `<div class="row"><div class="grow"><div class="t">${esc(e.title)}</div><div class="m">${esc(e.time || "Tutto il giorno")}${e.late ? ", rientro tardi" : ""}</div></div><span class="tag">${esc(e.type)}</span></div>`).join("")}
  </div>`;
}

function weekDays() { const off = (parse(selDay).getDay() + 6) % 7, mon = addDays(selDay, -off); return [...Array(7)].map((_, i) => addDays(mon, i)); }
function vSettimana() {
  const days = weekDays(), ev = eventsOn(selDay), m = meal(selDay), b = wasteOn(selDay);
  return `
  <h2>Settimana</h2>
  <p class="sub">Tocca un giorno per vedere pasti e impegni.</p>
  <div class="days">
  ${days.map(d => { const n = eventsOn(d).length, w = wasteOn(d).length;
    return `<button class="day ${d === TODAY ? "today" : ""}" aria-pressed="${d === selDay}" data-action="day" data-v="${d}">
      <div class="d">${DOW[parse(d).getDay()]}</div><div class="n">${parse(d).getDate()}</div>
      <div class="dots">${n ? "<i></i>" : ""}${w ? '<i class="w"></i>' : ""}</div></button>`; }).join("")}</div>
  <div style="display:flex;justify-content:space-between;gap:8px">
    <button class="btn ghost small" data-action="shift" data-v="-7">Settimana prima</button>
    <button class="btn ghost small" data-action="shift" data-v="7">Settimana dopo</button></div>
  <h3>${esc(fmtLong(selDay))}</h3>
  ${b.length ? `<p class="sub">🗑️ Raccolta: ${esc(b.join(", "))}</p>` : ""}
  <div class="panel">
    <div class="meal"><label for="mp">Pranzo</label><input id="mp" data-meal="pranzo" value="${esc(m.pranzo)}" placeholder="Aggiungi pranzo"></div>
    <div class="meal"><label for="mc">Cena</label><input id="mc" data-meal="cena" value="${esc(m.cena)}" placeholder="Aggiungi cena"></div>
  </div>
  <h3>Eventi e attività</h3>
  <div class="panel">${ev.map(e => `<div class="row"><div class="grow"><div class="t">${esc(e.title)}</div>
    <div class="m">${esc(e.time || "Tutto il giorno")}${e.late ? ", rientro tardi" : ""}${e.repeat === "weekly" ? ", ogni settimana" : ""}</div></div>
    <span class="tag ${e.type === "evento" ? "teal" : ""}">${esc(e.type)}</span>
    <button class="btn ghost small" data-action="ev-del" data-v="${e.id}" aria-label="Elimina ${esc(e.title)}">✕</button></div>`).join("") || `<p class="empty">Giornata libera.</p>`}</div>
  <h3>Aggiungi</h3>
  <div class="form">
    <input class="field" id="evt" placeholder="Cosa?">
    <input class="field" id="evh" type="time" aria-label="Ora">
    <select class="field" id="evk" aria-label="Tipo"><option value="evento">Evento</option><option value="attività">Attività</option></select>
    <button class="btn" data-action="ev-add">Aggiungi</button>
    <label class="inline full"><input type="checkbox" id="evr"> Ogni settimana, in questo giorno</label>
    <label class="inline full"><input type="checkbox" id="evl"> Rientro tardi (ti propongo un pasto rapido)</label>
  </div>`;
}

function vSpesa() {
  const shop = L("shopping").sort((a, b) => (a.done - b.done) || ((a.order || 0) - (b.order || 0)));
  const done = shop.filter(s => s.done).length;
  const pantry = L("pantry").sort((a, b) => (daysLeft(a) ?? 999) - (daysLeft(b) ?? 999));
  const badge = p => { const d = daysLeft(p); if (d === null) return `<span class="tag">a lunga conservazione</span>`;
    if (d < 0) return `<span class="tag rose">scaduto</span>`; if (d === 0) return `<span class="tag rose">scade oggi</span>`;
    if (d <= 2) return `<span class="tag amber">${d === 1 ? "domani" : "tra 2 giorni"}</span>`; return `<span class="tag teal">${d} giorni</span>`; };
  return `
  <h2>Spesa</h2>
  <p class="sub">La lista è il bottino da raccogliere, la dispensa è l'inventario.</p>
  <div class="seg three" role="group" aria-label="Vista">
    <button aria-pressed="${spesaTab === "lista"}" data-action="spesa-tab" data-v="lista">Lista (${shop.length - done})</button>
    <button aria-pressed="${spesaTab === "dispensa"}" data-action="spesa-tab" data-v="dispensa">Dispensa (${pantry.length})</button>
    <button aria-pressed="${spesaTab === "ricette"}" data-action="spesa-tab" data-v="ricette">Ricette</button>
  </div>
  ${spesaTab === "ricette" ? vRicette() : spesaTab === "lista" ? `
    <div class="addbar"><input id="shop-in" placeholder="Aggiungi alla lista" enterkeyhint="done"><button class="btn" data-action="shop-add">Aggiungi</button></div>
    <div class="panel">${shop.map(s => `<div class="row">
      <button class="chk ${s.done ? "on" : ""}" data-action="shop-toggle" data-v="${s.id}" aria-label="${s.done ? "Segna da prendere" : "Segna preso"}: ${esc(s.name)}">${s.done ? "✓" : ""}</button>
      <div class="grow"><div class="t" style="${s.done ? "text-decoration:line-through;opacity:.55" : ""}">${esc(s.name)}</div></div>
      <button class="btn ghost small" data-action="shop-del" data-v="${s.id}" aria-label="Elimina ${esc(s.name)}">✕</button></div>`).join("") || `<p class="empty">Lista vuota. Aggiungi quello che manca.</p>`}</div>
    ${done ? `<p style="margin-top:12px"><button class="btn" data-action="shop-stash">Metti in dispensa i ${done} presi</button></p>` : ""}
  ` : `
    <div class="addbar"><input id="pan-in" placeholder="Nuovo oggetto"><input id="pan-exp" type="date" aria-label="Scadenza" style="flex:0 0 150px"><button class="btn" data-action="pan-add" aria-label="Aggiungi alla dispensa">+</button></div>
    <div class="panel">${pantry.map(p => `<div class="row"><div class="grow"><button class="name" data-action="pan-edit" data-v="${p.id}" style="background:none;border:0;padding:0;text-align:left;font-weight:700">${esc(p.name)}</button></div>${badge(p)}
      <button class="btn ghost small" data-action="pantry-use" data-v="${p.id}" aria-label="Usato: ${esc(p.name)}">Usato</button></div>`).join("") || `<p class="empty">Inventario vuoto.</p>`}</div>
    <p class="sub" style="margin-top:10px">Tocca un nome per cambiare la scadenza. "Usato" lo toglie dall'inventario e ti chiede se rimetterlo in lista.</p>
  `}`;
}

function vRicette() {
  const q = (LS.get("regno.rq") || "").toLowerCase();
  const list = allRecipes().filter(r => !q || r.n.toLowerCase().includes(q) || (r.i || []).some(x => x.toLowerCase().includes(q)))
    .map(r => ({ ...r, miss: missing(r) })).sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || a.miss.length - b.miss.length || a.n.localeCompare(b.n));
  return `
    <div class="addbar"><input id="rq" placeholder="Cerca piatto o ingrediente" value="${esc(q)}" enterkeyhint="search"><button class="btn" data-action="rec-new">Nuova</button></div>
    <div class="panel">${list.map(r => `<div class="row">
      <button class="chk ${r.fav ? "on" : ""}" data-action="rec-fav" data-v="${r.id}" aria-label="${r.fav ? "Togli dai preferiti" : "Preferita"}: ${esc(r.n)}">${r.fav ? "★" : "☆"}</button>
      <div class="grow"><button class="name" data-action="rec-open" data-v="${r.id}" style="background:none;border:0;padding:0;text-align:left;font-weight:700">${esc(r.n)}</button>
        <div class="m">${r.min ? r.min + " min" : "tempo libero"}${r.builtin ? "" : ", vostra"}</div></div>
      ${r.miss.length ? `<span class="tag amber">${r.miss.length === 1 ? "manca 1" : "mancano " + r.miss.length}</span>` : `<span class="tag teal">si può fare</span>`}
    </div>`).join("") || `<p class="empty">Nessuna ricetta trovata.</p>`}</div>`;
}
function recipeSheet(id) {
  const r = allRecipes().find(x => x.id === id); if (!r) return closeSheet();
  const miss = missing(r);
  openSheet(`<h2>${esc(r.n)}</h2><p class="sub">${r.min ? r.min + " minuti" : "Tempo non indicato"}${r.fav ? ", tra le preferite" : ""}</p>
  <h3>Ingredienti</h3>
  <div class="panel">${(r.i || []).map(x => `<div class="row"><span class="grow">${esc(x)}</span>${STAPLES.has(x.toLowerCase()) ? `<span class="tag">in casa</span>` : has(x.toLowerCase()) ? `<span class="tag teal">in dispensa</span>` : `<span class="tag amber">da comprare</span>`}</div>`).join("") || `<p class="empty">Nessun ingrediente segnato: aggiungili con "Modifica".</p>`}</div>
  ${r.note ? `<p class="sub" style="margin-top:10px">${esc(r.note)}</p>` : ""}
  <h3>Mettila in tavola</h3>
  <div class="form"><input class="field" id="rc-d" type="date" value="${TODAY}" aria-label="Giorno"><select class="field" id="rc-p" aria-label="Pasto"><option value="cena">Cena</option><option value="pranzo">Pranzo</option></select>
    <button class="btn full" data-action="rec-plan" data-v="${r.id}">Metti in programma</button></div>
  <div class="stack" style="margin-top:8px">
    ${miss.length ? `<button class="btn ghost" data-action="rec-shop" data-v="${r.id}">Aggiungi i mancanti alla lista (${miss.length})</button>` : ""}
    <button class="btn ghost" data-action="rec-edit" data-v="${r.id}">Modifica</button>
    <button class="btn ghost" data-action="rec-del" data-v="${r.id}">${r.builtin ? "Nascondi dal ricettario" : "Elimina"}</button></div>`);
}
function recipeEdit(id) {
  const r = id ? allRecipes().find(x => x.id === id) : { n: "", i: [], min: "", note: "" };
  openSheet(`<h2>${id ? "Modifica ricetta" : "Nuova ricetta"}</h2>
  <div class="stack">
    <input class="field" id="re-n" placeholder="Nome del piatto" value="${esc(r.n)}">
    <input class="field" id="re-i" placeholder="Ingredienti separati da virgola" value="${esc((r.i || []).join(", "))}">
    <input class="field" id="re-m" type="number" min="1" placeholder="Minuti" value="${esc(r.min || "")}">
    <textarea class="field" id="re-note" placeholder="Note, dosi, trucchi" style="min-height:90px;font-family:inherit;font-size:.95rem">${esc(r.note || "")}</textarea>
    <button class="btn" data-action="rec-save" data-v="${id || ""}">Salva nel ricettario</button></div>`);
}

function vCasa() {
  const R = rooms(), rows = []; for (let i = 0, k = 2; i < R.length; i += k, k = k === 2 ? 3 : 2) rows.push(R.slice(i, i + k));
  const hex = r => { const st = roomState(r), n = r.quests.filter(q => questState(q) !== "ok").length;
    const lbl = st === "clean" ? "In ordine" : st === "due" ? `${n} da fare` : `${n} in ritardo`;
    return `<div class="hexwrap"><button class="hex ${st}" data-action="room" data-v="${r.id}" aria-label="${esc(r.name)}: ${lbl}">
      <span class="e" aria-hidden="true">${r.e}</span><span class="n">${esc(r.name)}</span><span class="s">${lbl}</span></button></div>`; };
  return `
  <h2>La mappa del castello</h2>
  <p class="sub">Ogni stanza ha il suo stemma: torna d'oro quando le sue quest sono completate.</p>
  <div class="map">${rows.map(r => `<div class="hexrow">${r.map(hex).join("")}</div>`).join("")}</div>
  <div class="legend"><span style="--c:#D4AE48">oro, in ordine</span><span style="--c:#2F4C92">azzurro, da fare</span><span style="--c:#B0352A">rosso, in ritardo</span></div>
  <p style="text-align:center;margin:10px 0 0"><button class="btn ghost small" data-action="rooms-edit">Modifica le stanze</button></p>
  <h3>Calendario raccolta</h3>
  <p class="sub">Tocca i giorni di passaggio. L'avviso arriva la sera prima.</p>
  <div class="bins">${bins().map(b => `<div class="bin"><span class="l">${esc(b.name)}</span>
    ${DOW_ORDER.map(d => `<button aria-pressed="${(b.days || []).includes(d)}" data-action="waste" data-k="${b.id}" data-v="${d}" aria-label="${esc(b.name)} ${DOW[d]}">${DOW[d]}</button>`).join("")}</div>`).join("")}</div>
  <p style="margin-top:12px"><button class="btn ghost" data-action="ics">Aggiungi la raccolta al Calendario</button></p>
  <p class="note">Su iPhone è il modo più affidabile per l'avviso della sera prima, anche a telefono bloccato.</p>`;
}

const mdLite = t => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
function vOracolo() {
  const chat = LS.get(K.chat, []);
  const waiting = chat.some(x => x.role === "bridge" && !x.done);
  const prompts = ["Organizzaci la settimana", "Cosa cucino con quello che scade?", "Dividi le faccende tra noi due", "Stasera rientro tardi, idee?"];
  const card = (m, i) => m.actions ? `
      <div class="plan"><div class="plan-t">Modifiche proposte</div><ul>${m.actions.map(a => `<li>${esc(describe(a))}</li>`).join("")}</ul>
      ${m.state === "applied" ? `<p class="note">Applicate al Regno.</p>` : m.state === "discarded" ? `<p class="note">Scartate.</p>` :
        `<div class="acts"><button class="btn small" data-action="plan-apply" data-v="${i}">Applica al Regno</button><button class="btn ghost small" data-action="plan-discard" data-v="${i}">Scarta</button></div>`}
      ${m.actions.some(a => a.k === "meal") ? `<button class="btn ghost small" style="margin-top:8px" data-action="plan-save-recipes" data-v="${i}">Salva i piatti nel ricettario</button>` : ""}</div>` : "";
  return `
  ${chat.length ? "" : `<div class="oracle-hero"><div class="orb" aria-hidden="true"></div><h2 style="margin:0">L'Oracolo</h2>
    <p class="sub">Pianifica da solo, gratis e offline, oppure chiedigli un consiglio.</p></div>`}
  <button class="btn" data-action="plan-local" style="width:100%;margin-top:8px">Pianifica la settimana da solo</button>
  <div class="chat" id="chatlog">${chat.map((m, i) => m.role === "bridge"
      ? `<div class="msg a think">${esc(m.content)}${m.done ? "" : `<div class="acts" style="margin-top:8px"><button class="btn ghost small" data-action="recopy" data-v="${i}">Copia di nuovo</button></div>`}</div>`
      : `<div class="msg ${m.role === "user" ? "u" : "a"}">${mdLite(m.content)}${card(m, i)}</div>`).join("")}</div>
  ${waiting ? `<div class="choice" style="margin-top:0"><h3>Risposta di Claude</h3>
    <textarea class="field" id="reply-in" rows="5" placeholder="Incolla qui la risposta completa" style="min-height:110px;font-family:inherit;font-size:.95rem"></textarea>
    <div class="acts"><button class="btn" data-action="paste-reply">Leggi la risposta</button><button class="btn ghost" data-action="paste-clip">Incolla dagli appunti</button></div></div>` : ""}
  ${gemBusy ? `<div class="msg a think">L'Oracolo sta consultando il cristallo…</div>` : ""}
  <h3>${oracleMode() === "gemini" && LS.get(K.gem) ? "Chiedi all'Oracolo" : "Chiedi a Claude"}</h3>
  <div class="chips">${prompts.map(p => `<button data-action="ask" data-v="${esc(p)}">${esc(p)}</button>`).join("")}
    ${chat.length ? `<button data-action="chat-clear">Nuova conversazione</button>` : ""}</div>
  <div class="composer"><input class="field" id="ask-in" placeholder="Scrivi la tua domanda" enterkeyhint="send">
    <button class="btn" data-action="ask-send">Chiedi</button></div>
  <p class="note">${oracleMode() === "gemini" && LS.get(K.gem) ? "Risponde Gemini, gratuito. Puoi passare a Claude dall'ingranaggio." : "Si apre Claude con la domanda e i dati della casa. Se il testo non compare già scritto, incollalo: è negli appunti."}</p>`;
}

/* ---------- Oracolo ----------
 * Nessuna API a pagamento:
 * 1. "Pianifica da solo": pianificatore interno, gratuito e offline.
 * 2. "Chiedi a Claude": prepara la domanda con i dati della casa, la copia e apre Claude
 *    (usa il tuo abbonamento). La risposta si incolla qui e le modifiche diventano una scheda da applicare. */
const fmtShort = s => parse(s).toLocaleDateString("it-IT", { weekday: "short", day: "numeric" });
function toAction(x) {
  x = x || {}; const okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
  if (x.azione === "imposta_pasto" && okDate(x.data) && ["pranzo", "cena"].includes(x.pasto) && x.piatto) return { k: "meal", data: x.data, pasto: x.pasto, piatto: String(x.piatto) };
  if (x.azione === "aggiungi_impegno" && okDate(x.data) && x.titolo) return { k: "event", data: x.data, ora: x.ora || "", titolo: String(x.titolo), tipo: x.tipo === "attività" ? "attività" : "evento", rientro_tardi: !!x.rientro_tardi };
  if (x.azione === "aggiungi_alla_spesa" && Array.isArray(x.articoli) && x.articoli.length) return { k: "shop", articoli: x.articoli.map(String).slice(0, 30) };
  if (x.azione === "assegna_faccenda" && store.get("quests", x.id_faccenda) && store.get("players", x.id_giocatore)) return { k: "assign", id_faccenda: x.id_faccenda, id_giocatore: x.id_giocatore };
  return null;
}
function describe(a) {
  if (a.k === "meal") return `🍽️ ${fmtShort(a.data)}, ${a.pasto}: ${a.piatto}`;
  if (a.k === "event") return `📜 ${fmtShort(a.data)}${a.ora ? " alle " + a.ora : ""}: ${a.titolo}${a.rientro_tardi ? " (rientro tardi)" : ""}`;
  if (a.k === "shop") return `🧺 In lista: ${a.articoli.join(", ")}`;
  if (a.k === "assign") return `🛡️ ${store.get("quests", a.id_faccenda)?.title || "Faccenda"} a ${pname(a.id_giocatore)}`;
  return "";
}
function applyPlan(i) {
  const chat = LS.get(K.chat, []), m = chat[i]; if (!m?.actions || m.state) return;
  for (const a of m.actions) {
    if (a.k === "meal") store.put("meals", a.data, { [a.pasto]: a.piatto });
    if (a.k === "event") store.put("events", "e_" + uid(), { date: a.data, time: a.ora || "", title: a.titolo, type: a.tipo, late: !!a.rientro_tardi });
    if (a.k === "shop") { const have = new Set(L("shopping").filter(s => !s.done).map(s => s.name.toLowerCase()));
      a.articoli.filter(n => !have.has(n.toLowerCase())).forEach(n => store.put("shopping", "s_" + uid(), { name: n, done: false, order: Date.now() })); }
    if (a.k === "assign" && store.get("quests", a.id_faccenda)) store.put("quests", a.id_faccenda, { assignee: a.id_giocatore });
  }
  m.state = "applied"; LS.set(K.chat, chat); render(); toast("Piano applicato al Regno");
}
function discardPlan(i) { const chat = LS.get(K.chat, []); if (chat[i]) { chat[i].state = "discarded"; LS.set(K.chat, chat); render(); } }
function pushChat(m) { const chat = LS.get(K.chat, []); chat.push(m); LS.set(K.chat, chat); render(); }

/* --- 1. Pianificatore interno --- */
const hashStr = t => { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
function planLocally() {
  const days = [...Array(7)].map((_, i) => addDays(TODAY, i));
  const actions = [], used = new Set(days.map(d => meal(d).cena).filter(Boolean)), need = new Set();
  let expiring = L("pantry").filter(p => { const d = daysLeft(p); return d !== null && d >= 0 && d <= 3; });
  let dinners = 0;
  for (const d of days) {
    if (meal(d).cena) continue;
    let pick = null;
    if (eventsOn(d).some(e => e.late)) { const q = quickMeal(used); pick = { n: q.n, i: q.i || [] }; }
    if (!pick) { const r = recipeFor(expiring); if (r && !used.has(r.n)) { pick = r; expiring = expiring.filter(p => !r.i.includes(p.name.toLowerCase())); } }
    if (!pick) { const pool = allRecipes().filter(r => !used.has(r.n) && (r.min || 30) <= 60);
      pool.sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || missing(a).length - missing(b).length || (hashStr(a.n + d) % 7) - (hashStr(b.n + d) % 7));
      pick = pool[0]; }
    if (!pick) continue;
    used.add(pick.n); dinners++;
    actions.push({ k: "meal", data: d, pasto: "cena", piatto: pick.n });
    missing(pick).forEach(x => need.add(x));
  }
  const load = {}; players().forEach(p => load[p.id] = 0);
  const horizon = addDays(TODAY, 7);
  const upcoming = L("quests").filter(q => !q.last || addDays(q.last, q.every) <= horizon)
    .map(q => ({ q, times: Math.max(1, Math.round(7 / q.every)) })).sort((a, b) => b.q.xp * b.times - a.q.xp * a.times);
  for (const { q, times } of upcoming) {
    const who = Object.keys(load).sort((a, b) => load[a] - load[b])[0];
    load[who] += q.xp * times;
    if (q.assignee !== who) actions.push({ k: "assign", id_faccenda: q.id, id_giocatore: who });
  }
  const inList = new Set(L("shopping").filter(s => !s.done).map(s => s.name.toLowerCase()));
  const toBuy = [...need].filter(x => !inList.has(x)).map(x => x[0].toUpperCase() + x.slice(1));
  if (toBuy.length) actions.push({ k: "shop", articoli: toBuy });
  const summary = [
    dinners ? `Ho pensato ${dinners === 1 ? "a una cena" : `a ${dinners} cene`}, usando prima quello che scade.` : "Le cene della settimana sono già decise.",
    upcoming.length ? `Ho diviso ${upcoming.length} faccende in modo equo: ${players().map(p => `${p.name} circa ${load[p.id]} XP`).join(", ")}.` : "",
    toBuy.length ? `Per queste cene mancano: ${toBuy.join(", ").toLowerCase()}.` : "",
  ].filter(Boolean).join("\n");
  pushChat({ role: "user", content: "Pianifica la settimana" });
  pushChat({ role: "assistant", content: summary, actions: actions.length ? actions : undefined });
}

/* --- 2. Gemini (gratuito, automatico) --- */
const oracleMode = () => LS.get(K.oracle) || (LS.get(K.gem) ? "gemini" : "claude");
function oracleRules() {
  return `Sei l'Oracolo del "Regno di Cristallo", l'assistente domestico condiviso di una coppia. Rispondi in italiano, breve e pratico, con un tocco leggero da saggio consigliere di corte medievale, senza rendere oscure le indicazioni pratiche. Quando organizzi, dividi i compiti in modo equo e usa prima gli ingredienti in scadenza. Niente titoli markdown: righe brevi e trattini.

Se la risposta porta a cambiare qualcosa, chiudi con UN blocco di codice json contenente un array di azioni scelte tra queste (solo date dei prossimi 14 giorni):
{"azione":"imposta_pasto","data":"AAAA-MM-GG","pasto":"pranzo o cena","piatto":"..."}
{"azione":"aggiungi_impegno","data":"AAAA-MM-GG","ora":"HH:MM","titolo":"...","tipo":"evento o attività","rientro_tardi":false}
{"azione":"aggiungi_alla_spesa","articoli":["..."]}
{"azione":"assegna_faccenda","id_faccenda":"id dai dati","id_giocatore":"id dai dati"}
Se la domanda è solo informativa, niente blocco.`;
}
let gemBusy = false;
async function askGemini(text) {
  text = (text || "").trim(); if (!text || gemBusy) return;
  pushChat({ role: "user", content: text });
  if (!navigator.onLine) { pushChat({ role: "assistant", content: "Senza connessione l'Oracolo tace. Puoi usare \"Pianifica la settimana da solo\", che funziona offline." }); return; }
  gemBusy = true; render();
  const chat = LS.get(K.chat, []).filter(m => m.role !== "bridge").slice(-10);
  while (chat.length && chat[0].role !== "user") chat.shift();
  const contents = chat.map(m => ({ role: m.role === "user" ? "user" : "model", parts: [{ text:
    (m.content || "") + (m.actions ? `\n[Modifiche proposte: ${m.actions.map(describe).join("; ")}; ${m.state === "applied" ? "applicate" : m.state === "discarded" ? "scartate" : "in attesa"}]` : "") || "…" }] }));
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.geminiModel}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": LS.get(K.gem) },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: oracleRules() + "\n\nDati della casa (JSON):\n" + JSON.stringify(houseContext()) }] }, contents, generationConfig: { temperature: 0.7 } }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(res.status === 429 ? "limite gratuito raggiunto, riprova tra poco" : data?.error?.message || "errore " + res.status);
    const raw = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
    const { text: t, actions } = parseReply(raw);
    gemBusy = false;
    pushChat({ role: "assistant", content: t || (actions.length ? "Ecco cosa propongo:" : "…"), actions: actions.length ? actions : undefined });
  } catch (e) {
    gemBusy = false;
    pushChat({ role: "assistant", content: `L'Oracolo non ha risposto (${e.message}). Controlla la chiave di Gemini nelle impostazioni, oppure consulta Claude.` });
  }
}
function ask(text) { return oracleMode() === "gemini" && LS.get(K.gem) ? askGemini(text) : askClaude(text); }

/* --- 3. Ponte verso Claude --- */
function houseContext() {
  const wk = [...Array(7)].map((_, i) => addDays(TODAY, i));
  return {
    oggi: TODAY, giocatori: players().map(p => ({ id: p.id, nome: p.name })), chi_scrive: pname(me()), rientro_tardi_stasera: lateTonight(),
    prossimi_7_giorni: wk.map(d => ({ data: d, giorno: fmtLong(d), pasti: { pranzo: meal(d).pranzo || "", cena: meal(d).cena || "" }, raccolta: wasteOn(d),
      impegni: eventsOn(d).map(e => ({ ora: e.time, titolo: e.title, tipo: e.type, rientro_tardi: e.late })) })),
    dispensa: L("pantry").map(p => ({ nome: p.name, giorni_alla_scadenza: daysLeft(p) })),
    lista_spesa: L("shopping").filter(s => !s.done).map(s => s.name),
    faccende: rooms().flatMap(r => r.quests.map(q => ({ id: q.id, stanza: r.name, compito: q.title, ogni_giorni: q.every, stato: questState(q), affidata_a: q.assignee || null }))),
  };
}
function buildPrompt(question) {
  return `${oracleRules()}

Richiesta: ${question}

Dati della casa (JSON):
${JSON.stringify(houseContext())}`;
}
async function askClaude(text) {
  text = (text || "").trim(); if (!text) return;
  const prompt = buildPrompt(text);
  let copied = false;
  try { await navigator.clipboard.writeText(prompt); copied = true; } catch (e) {}
  pushChat({ role: "user", content: text });
  pushChat({ role: "bridge", content: copied ? "Domanda copiata con i dati della casa. Incollala in Claude, poi copia qui sotto la sua risposta." : "Non sono riuscito a copiare in automatico: usa \"Copia di nuovo\"." , prompt });
  const url = prompt.length < 6000 ? "https://claude.ai/new?q=" + encodeURIComponent(prompt) : "https://claude.ai/new";
  window.open(url, "_blank");
}
function parseReply(raw) {
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let actions = [], text = raw;
  const tryParse = src => { try { const v = JSON.parse(src); return Array.isArray(v) ? v : Array.isArray(v?.azioni) ? v.azioni : null; } catch (e) { return null; } };
  if (m) { const arr = tryParse(m[1].trim()); if (arr) { actions = arr.map(toAction).filter(Boolean); text = raw.replace(m[0], "").trim(); } }
  else { const k = raw.lastIndexOf("["); if (k >= 0) { const arr = tryParse(raw.slice(k)); if (arr) { actions = arr.map(toAction).filter(Boolean); text = raw.slice(0, k).trim(); } } }
  return { text, actions };
}
function pasteReply(raw) {
  raw = (raw || "").trim(); if (!raw) return;
  const { text, actions } = parseReply(raw);
  const chat = LS.get(K.chat, []);
  const b = chat.findLastIndex(x => x.role === "bridge" && !x.done); if (b >= 0) chat[b].done = true;
  chat.push({ role: "assistant", content: text || "Ecco cosa propone Claude:", actions: actions.length ? actions : undefined });
  LS.set(K.chat, chat); render();
  if (!actions.length && /```/.test(raw)) toast("Nel blocco non ho trovato modifiche valide");
}

/* ---------- Imprese ---------- */
const questXP = () => L("xp").filter(x => (x.reason || "").startsWith("quest:"));
const ACHIEVEMENTS = [
  { id: "primo", ic: "🗡️", n: "Primo giuramento", d: "Completate la prima quest.", ok: c => c.quests >= 1 },
  { id: "dieci", ic: "🛡️", n: "Braccia operose", d: "10 quest completate.", ok: c => c.quests >= 10 },
  { id: "cinquanta", ic: "⚜️", n: "Mani d'oro", d: "50 quest completate.", ok: c => c.quests >= 50 },
  { id: "cento", ic: "👑", n: "Leggenda del focolare", d: "100 quest completate.", ok: c => c.quests >= 100 },
  { id: "castello", ic: "🏰", n: "Castello d'oro", d: "Tutte le stanze in ordine nello stesso momento.", ok: c => c.allGold },
  { id: "alleanza", ic: "🤝", n: "Alleanza", d: "Entrambi avete completato quest nello stesso giorno.", ok: c => c.together },
  { id: "costanza", ic: "☀️", n: "Sette soli", d: "Almeno una quest al giorno per 7 giorni di fila.", ok: c => c.streak >= 7 },
  { id: "custode", ic: "🧺", n: "Custode della dispensa", d: "Almeno 8 oggetti in dispensa e nessuno scaduto.", ok: c => c.pantryOk },
  { id: "mercante", ic: "💰", n: "Mercante del Regno", d: "30 articoli portati dalla spesa alla dispensa.", ok: c => c.bought >= 30 },
  { id: "consiglio", ic: "📜", n: "Consiglio di corte", d: "Cene decise per tutti i prossimi 7 giorni.", ok: c => c.planned },
  { id: "cuoco", ic: "🍲", n: "Cuoco di corte", d: "5 ricette vostre nel ricettario.", ok: c => c.ownRecipes >= 5 },
  { id: "nullaperso", ic: "🌾", n: "Nulla va perduto", d: "Una settimana intera senza sprechi, dopo almeno 7 giorni di Regno.", ok: c => c.noWasteWeek },
  { id: "baroni", ic: "🎖️", n: "Titolo nobiliare", d: "Raggiungete il rango di Baroni.", ok: c => c.level >= 3 },
];
function achContext() {
  const qx = questXP(), days = new Set(qx.map(x => x.date).filter(Boolean));
  let streak = 0; for (let d = TODAY; days.has(d); d = addDays(d, -1)) streak++;
  const byDay = {}; qx.forEach(x => { if (x.date) (byDay[x.date] ||= new Set()).add(x.player); });
  const firstDay = [...days].sort()[0];
  const log = L("log"), R = rooms();
  return {
    quests: qx.length, streak,
    together: Object.values(byDay).some(s => s.size >= 2),
    allGold: R.length > 0 && R.every(r => r.quests.length && roomState(r) === "clean"),
    pantryOk: L("pantry").length >= 8 && !L("pantry").some(p => daysLeft(p) !== null && daysLeft(p) < 0),
    bought: log.filter(l => l.type === "spesa").reduce((s, l) => s + (l.count || 1), 0),
    planned: [...Array(7)].every((_, i) => meal(addDays(TODAY, i)).cena),
    ownRecipes: allRecipes().filter(r => !r.builtin).length,
    noWasteWeek: !!firstDay && firstDay <= addDays(TODAY, -7) && !log.some(l => l.type === "spreco" && l.date > addDays(TODAY, -7)),
    level: Math.floor(store.xpTotal() / 150) + 1,
  };
}
let achTimer;
function checkAchievements() {
  clearTimeout(achTimer);
  achTimer = setTimeout(() => {
    if (!store) return;
    const c = achContext();
    for (const a of ACHIEVEMENTS) if (!store.get("achievements", a.id) && a.ok(c)) {
      store.put("achievements", a.id, { date: TODAY, by: me() });
      setTimeout(() => toast(`🏆 Impresa: ${a.n}`), 400);
    }
  }, 1200);
}

/* ---------- Cronaca della settimana ---------- */
function chronicle(endDay = TODAY) {
  const start = addDays(endDay, -6), inWeek = d => d && d >= start && d <= endDay;
  const prevStart = addDays(start, -7), inPrev = d => d && d >= prevStart && d < start;
  const xp = L("xp").filter(x => inWeek(x.date)), prevXP = L("xp").filter(x => inPrev(x.date)).reduce((s, x) => s + x.amount, 0);
  const per = {}; players().forEach(p => per[p.id] = { xp: 0, q: 0 });
  xp.forEach(x => { if (per[x.player]) { per[x.player].xp += x.amount; if ((x.reason || "").startsWith("quest:")) per[x.player].q++; } });
  const tot = Object.values(per).reduce((s, v) => s + v.xp, 0), quests = Object.values(per).reduce((s, v) => s + v.q, 0);
  const qCount = {}; xp.filter(x => (x.reason || "").startsWith("quest:")).forEach(x => { const id = x.reason.slice(6); qCount[id] = (qCount[id] || 0) + 1; });
  const topQ = Object.entries(qCount).sort((a, b) => b[1] - a[1])[0];
  const log = L("log").filter(l => inWeek(l.date));
  const bought = log.filter(l => l.type === "spesa").reduce((s, l) => s + (l.count || 1), 0);
  const wasted = log.filter(l => l.type === "spreco").map(l => l.name);
  const dinners = [...Array(7)].filter((_, i) => meal(addDays(start, i)).cena).length;
  const newAch = ACHIEVEMENTS.filter(a => inWeek(store.get("achievements", a.id)?.date));
  const title = TITLES[Math.min(Math.floor(store.xpTotal() / 150), TITLES.length - 1)];
  const lines = [];
  const art = /^[Ss][cptn]|^[Zz]|^[AEIOUaeiou]/.test(title) ? "gli" : "i";
  lines.push(quests ? `Nella settimana che si chiude, ${art} ${title} del Regno hanno portato a termine ${quests === 1 ? "una quest" : quests + " quest"}, per ${tot} XP${prevXP ? tot >= prevXP ? `, più dei ${prevXP} della settimana prima` : `, contro i ${prevXP} della settimana prima` : ""}.` : "Settimana quieta nel Regno: nessuna quest registrata.");
  if (quests) lines.push(players().map(p => `${p.name}: ${per[p.id].q} quest, ${per[p.id].xp} XP`).join(". ") + ".");
  const ps = players(); if (ps.length === 2 && tot >= 40) { const [a, b] = ps.map(p => per[p.id].xp), lo = a < b ? ps[0] : ps[1];
    if (Math.abs(a - b) / tot > 0.3) lines.push(`La bilancia pende: la prossima settimana ${lo.name} potrebbe prendere qualche quest in più.`); else lines.push("I carichi sono ben divisi: il Regno è in equilibrio."); }
  if (topQ) lines.push(`L'impresa più ripetuta: ${store.get("quests", topQ[0])?.title || "una quest ormai scomparsa"} (${topQ[1] === 1 ? "una volta" : topQ[1] + " volte"}).`);
  lines.push(bought ? (bought === 1 ? "Dalla spesa è entrato in dispensa un articolo." : `Dalla spesa sono entrati in dispensa ${bought} articoli.`) : "Nessuna spesa registrata in dispensa.");
  lines.push(wasted.length ? `Andati perduti: ${wasted.join(", ").toLowerCase()}.` : "Nulla è andato perduto in dispensa.");
  lines.push(`Cene decise: ${dinners} su 7.`);
  if (newAch.length) lines.push(`Nuove imprese: ${newAch.map(a => a.n).join(", ")}.`);
  return { start, end: endDay, lines };
}
function throneSheet() {
  const x = store.xpTotal(), lvl = Math.floor(x / 150) + 1, title = TITLES[Math.min(lvl - 1, TITLES.length - 1)], next = TITLES[Math.min(lvl, TITLES.length - 1)];
  const c = chronicle();
  const got = ACHIEVEMENTS.filter(a => store.get("achievements", a.id)).length;
  openSheet(`<h2>La sala del trono</h2>
  <p class="sub">Rango: <b>${title}</b>, livello ${lvl}. ${lvl < TITLES.length ? `Mancano ${150 - (x % 150)} XP per diventare ${next}.` : "Più in alto non si sale."}</p>
  <h3>Cronaca della settimana</h3>
  <p class="sub" style="margin-top:-4px">Dal ${esc(fmtLong(c.start))} a oggi</p>
  <div class="panel chronicle">${c.lines.map(l => `<p>${esc(l)}</p>`).join("")}</div>
  <h3>Imprese (${got} su ${ACHIEVEMENTS.length})</h3>
  <div class="ach">${ACHIEVEMENTS.map(a => { const r = store.get("achievements", a.id);
    return `<div class="badge ${r ? "on" : ""}"><span class="bi" aria-hidden="true">${r ? a.ic : "🔒"}</span><b>${esc(a.n)}</b><span>${esc(a.d)}</span>${r ? `<i>${esc(fmtShort(r.date))}, ${esc(pname(r.by))}</i>` : ""}</div>`; }).join("")}</div>`);
}

/* ---------- Pannelli ---------- */
function openSheet(html) { $("#sheet-body").innerHTML = `<div class="grab"></div>${html}`; $("#sheet").classList.add("open"); $("#scrim").classList.add("open"); }
function closeSheet() { $("#sheet").classList.remove("open"); $("#scrim").classList.remove("open"); }
function roomSheet(id) {
  const r = rooms().find(x => x.id === id);
  openSheet(`<h2>${r.e} ${esc(r.name)}</h2><p class="sub">Quest ricorrenti di questa stanza.</p>
  <div class="panel">${r.quests.map(q => { const st = questState(q), next = q.last ? addDays(q.last, q.every) : TODAY;
    return `<div class="row"><button class="chk" data-action="quest" data-v="${q.id}" data-room="${r.id}" aria-label="Completa ${esc(q.title)}"></button>
    <div class="grow"><div class="t">${esc(q.title)}</div><div class="m">Ogni ${q.every === 1 ? "giorno" : q.every + " giorni"}${q.assignee ? `, tocca a ${esc(pname(q.assignee))}` : ""}${st === "ok" ? `, prossima ${esc(fmtLong(next))}` : ""}</div></div>
    <span class="tag ${st === "over" ? "rose" : st === "due" ? "amber" : "teal"}">${st === "ok" ? "fatta" : st === "due" ? "oggi" : "in ritardo"}</span>
    <button class="btn ghost small" data-action="quest-del" data-v="${q.id}" data-room="${r.id}" aria-label="Elimina ${esc(q.title)}">✕</button></div>`; }).join("") || `<p class="empty">Nessuna quest.</p>`}</div>
  <h3>Nuova quest</h3>
  <div class="form"><input class="field" id="q-t" placeholder="Compito"><input class="field" id="q-e" type="number" min="1" value="7" aria-label="Ogni quanti giorni">
  <button class="btn full" data-action="quest-add" data-v="${r.id}">Aggiungi quest (ogni N giorni)</button></div>`);
}
function roomsSheet() {
  openSheet(`<h2>Le stanze del castello</h2><p class="sub">Rinomina, riordina o aggiungi le stanze della vostra casa.</p>
  <div class="panel">${rooms().map((r, i) => `<div class="row">
    <input class="field" data-room-e="${r.id}" value="${esc(r.e)}" aria-label="Simbolo" style="flex:0 0 52px;text-align:center">
    <input class="field" data-room-n="${r.id}" value="${esc(r.name)}" aria-label="Nome stanza">
    ${i ? `<button class="btn ghost small" data-action="room-up" data-v="${r.id}" aria-label="Sposta su">↑</button>` : ""}
    <button class="btn ghost small" data-action="room-del" data-v="${r.id}" aria-label="Elimina ${esc(r.name)}">✕</button></div>`).join("")}</div>
  <h3>Nuova stanza</h3>
  <div class="addbar"><input class="field" id="nr-e" placeholder="🏠" style="flex:0 0 52px;text-align:center" aria-label="Simbolo"><input class="field" id="nr-n" placeholder="Nome"><button class="btn" data-action="room-add">Aggiungi</button></div>`);
}
function settingsSheet() {
  const fileId = LS.get(K.file);
  openSheet(`<h2>Impostazioni</h2>
  <h3>Giocatori</h3>
  <div class="panel">${players().map(p => `<div class="row"><input class="field" data-player="${p.id}" value="${esc(p.name)}" aria-label="Nome giocatore">
    <button class="btn small ${me() === p.id ? "" : "ghost"}" data-action="me" data-v="${p.id}">${me() === p.id ? "Sei tu" : "Sono io"}</button></div>`).join("")}</div>
  <h3>Google Drive</h3>
  ${fileId ? `<p class="sub">Il file del Regno è collegato. ${syncState === "login" ? "L'accesso è scaduto." : ""}</p>
    <div class="stack">
      <button class="btn" data-action="relogin">${syncState === "login" ? "Accedi di nuovo" : "Sincronizza ora"}</button>
      <input class="field" id="share-mail" type="email" placeholder="Email Google dell'altra persona">
      <button class="btn ghost" data-action="share">Condividi il file</button>
    </div>` : `<p class="sub">Stai usando la casa solo su questo telefono.</p>
    <button class="btn" data-action="link-drive" ${CONFIG.googleClientId.startsWith("INSERISCI") ? "disabled" : ""}>Salva questa casa su Drive</button>`}
  <h3>Oracolo</h3>
  <p class="sub">Chi risponde alle domande? Il pianificatore interno funziona sempre.</p>
  <div class="seg" role="group" aria-label="Chi risponde">
    <button aria-pressed="${oracleMode() === "gemini"}" data-action="oracle-mode" data-v="gemini">Gemini, automatico</button>
    <button aria-pressed="${oracleMode() === "claude"}" data-action="oracle-mode" data-v="claude">Claude, copia e incolla</button></div>
  ${oracleMode() === "gemini" ? `<div class="addbar"><input class="field" id="gem-key" type="password" autocomplete="off" placeholder="Chiave gratuita di Google AI Studio" value="${esc(LS.get(K.gem) || "")}"><button class="btn" data-action="gem-save">Salva</button></div>
  <p class="note" style="margin-top:0">Gratis, senza carta. In cambio Google può usare domande e dati della casa inviati per migliorare i suoi prodotti.</p>` : `<p class="note" style="margin-top:0">Usa il tuo abbonamento Claude, nessun costo aggiuntivo.</p>`}
  <h3>Promemoria</h3>
  <div class="stack">
    <button class="btn ghost" data-action="notif">Consenti le notifiche</button>
    <button class="btn ghost" data-action="ics">Aggiungi la raccolta al Calendario</button>
  </div>
  <p class="note">Nell'app da schermata Home le notifiche arrivano solo con l'app aperta. Il Calendario invece avvisa sempre.</p>
  <h3>Copia di sicurezza</h3>
  <div class="stack">
    <button class="btn ghost" data-action="export">Esporta il file della casa</button>
    <label class="btn ghost" style="text-align:center">Importa un file<input type="file" accept="application/json,.json" id="imp" hidden></label>
    <button class="btn ghost" data-action="leave">Scollega questo telefono</button>
  </div>
  <p class="note" style="text-align:center">Versione ${VERSION}</p>`);
}

/* ---------- Toast ---------- */
let tt; function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => t.classList.remove("show"), 2200); }

/* ---------- Azioni ---------- */
document.addEventListener("click", e => { handleClick(e).catch(err => showError(err.message || String(err))); });
async function handleClick(e) {
  const tb = e.target.closest("[data-tab]"); if (tb) { tab = tb.dataset.tab; render(); window.scrollTo(0, 0); return; }
  const b = e.target.closest("[data-action]"); if (!b) return;
  const a = b.dataset.action, v = b.dataset.v;
  switch (a) {
    /* benvenuto */
    case "found": LS.set(K.intent, { action: "found", n1: $("#w-n1").value.trim(), n2: $("#w-n2").value.trim(), email: $("#w-mail").value.trim() }); G.login(); break;
    case "join": LS.set(K.intent, { action: "join" }); G.login(); break;
    case "demo": openStore(emptyDoc("casa_" + uid())); seedHouse(store, { n1: "Rocco", n2: "Giocatore 2", demo: true }); LS.set(K.me, "p1"); LS.set(K.mode, "local"); render(); break;
    /* generale */
    case "settings": if (store) settingsSheet(); break;
    case "close-sheet": closeSheet(); break;
    case "tab": tab = v; render(); break;
    case "sync": if (syncState === "login") { LS.set(K.intent, { action: "sync" }); G.login({ silent: true }); } else if (syncer) doSync(); else settingsSheet(); break;
    case "relogin": if (syncState === "login") { LS.set(K.intent, { action: "sync" }); G.login({ silent: true }); } else { closeSheet(); doSync(); } break;
    case "share": { const m = $("#share-mail").value.trim(); if (!m) return; try { await syncer.adapter.shareWith(m); toast("File condiviso"); } catch (err) { toast("Condivisione non riuscita"); } break; }
    case "link-drive": LS.set(K.intent, { action: "link" }); G.login(); break;
    case "notif": { const r = await askPermission(); toast(r === "granted" ? "Notifiche consentite" : r === "unsupported" ? "Aggiungi prima l'app alla schermata Home" : "Notifiche non consentite"); scheduleReminders(); break; }
    case "ics": await shareOrDownload("raccolta-rifiuti.ics", wasteICS(bins()), "text/calendar"); break;
    case "export": await shareOrDownload(`regno-di-cristallo-${TODAY}.json`, JSON.stringify(store.doc, null, 2), "application/json"); break;
    case "leave": if (confirm("Scollegare questo telefono? I dati restano sul file Drive, ma spariscono da qui.")) { [K.doc, K.file, K.me, K.chat, K.mode].forEach(LS.del); G.forgetToken(); location.reload(); } break;
    case "me": LS.set(K.me, v); render(); settingsSheet(); break;
    /* oggi */
    case "toggle-late": store.put("settings", "late-" + TODAY, { value: !lateTonight() }); break;
    case "set-dinner": store.put("meals", TODAY, { cena: v }); toast("Cena di stasera aggiornata"); break;
    case "pantry-del": { const p = store.get("pantry", v); if (p && daysLeft(p) !== null && daysLeft(p) < 0) logIt("spreco", p.name); store.del("pantry", v); toast("Rimosso dall'inventario"); break; }
    /* quest */
    case "quest": { const q = store.get("quests", v); store.put("quests", v, { last: TODAY }); store.addXP(me(), q.xp, "quest:" + v);
      const r = rooms().find(x => x.id === q.roomId); toast(r && roomState(r) === "clean" ? `+${q.xp} XP, ${r.name} torna d'oro` : `+${q.xp} XP`);
      if (b.dataset.room) roomSheet(b.dataset.room); break; }
    case "quest-add": { const t = $("#q-t").value.trim(), n = Math.max(1, parseInt($("#q-e").value) || 7); if (!t) return;
      store.put("quests", "q_" + uid(), { roomId: v, title: t, every: n, last: null, xp: Math.min(30, 5 + n) }); roomSheet(v); break; }
    case "quest-del": if (confirm("Eliminare questa quest?")) { store.del("quests", v); roomSheet(b.dataset.room); } break;
    case "room": roomSheet(v); break;
    case "pan-edit": { const it = store.get("pantry", v);
      openSheet(`<h2>${esc(it.name)}</h2><p class="sub">Nome e scadenza nell'inventario.</p>
        <div class="stack"><input class="field" id="pe-n" value="${esc(it.name)}"><input class="field" id="pe-d" type="date" value="${esc(it.expires || "")}" aria-label="Scadenza">
        <button class="btn" data-action="pan-save" data-v="${v}">Salva</button><button class="btn ghost" data-action="pan-noexp" data-v="${v}">Senza scadenza</button></div>`); break; }
    case "pan-save": store.put("pantry", v, { name: $("#pe-n").value.trim() || store.get("pantry", v).name, expires: $("#pe-d").value || null }); closeSheet(); toast("Salvato"); break;
    case "pan-noexp": store.put("pantry", v, { expires: null }); closeSheet(); break;
    /* stanze */
    case "rooms-edit": roomsSheet(); break;
    case "room-add": { const n = $("#nr-n").value.trim(); if (!n) return; store.put("rooms", "r_" + uid(), { name: n, e: $("#nr-e").value.trim() || "🏠", order: Date.now() }); roomsSheet(); break; }
    case "room-del": { const r = store.get("rooms", v); if (!confirm(`Eliminare ${r.name} e le sue quest?`)) return;
      L("quests").filter(q => q.roomId === v).forEach(q => store.del("quests", q.id)); store.del("rooms", v); roomsSheet(); break; }
    case "room-up": { const ids = rooms().map(r => r.id), k = ids.indexOf(v); if (k > 0) { [ids[k - 1], ids[k]] = [ids[k], ids[k - 1]]; ids.forEach((id, n) => store.put("rooms", id, { order: n })); } roomsSheet(); break; }
    /* settimana */
    case "day": selDay = v; render(); break;
    case "shift": selDay = addDays(selDay, Number(v)); render(); break;
    case "ev-add": { const t = $("#evt").value.trim(); if (!t) { $("#evt").focus(); return; }
      store.put("events", "e_" + uid(), { date: selDay, time: $("#evh").value, title: t, type: $("#evk").value, late: $("#evl").checked, repeat: $("#evr").checked ? "weekly" : "none" }); toast("Aggiunto"); break; }
    case "ev-del": { const e = store.get("events", v);
      if (e.repeat === "weekly" && e.date !== selDay && !confirm("Evento settimanale. OK elimina tutta la serie, Annulla toglie solo questo giorno.")) store.put("events", v, { skip: [...(e.skip || []), selDay] });
      else store.del("events", v); break; }
    /* spesa */
    case "spesa-tab": spesaTab = v; render(); break;
    case "rec-new": recipeEdit(null); break;
    case "rec-open": recipeSheet(v); break;
    case "rec-edit": recipeEdit(v); break;
    case "rec-fav": { const r = allRecipes().find(x => x.id === v); store.put("recipes", v, { fav: !r.fav }); break; }
    case "rec-save": { const n = $("#re-n").value.trim(); if (!n) { $("#re-n").focus(); return; }
      const id = v || "r_" + uid();
      store.put("recipes", id, { n, i: $("#re-i").value.split(",").map(x => x.trim().toLowerCase()).filter(Boolean), min: parseInt($("#re-m").value) || null, note: $("#re-note").value.trim() });
      recipeSheet(id); toast("Ricetta salvata"); break; }
    case "rec-del": { const r = allRecipes().find(x => x.id === v); if (!confirm(r.builtin ? "Nascondere questa ricetta?" : "Eliminare questa ricetta?")) return;
      r.builtin ? store.put("recipes", v, { hidden: true }) : store.del("recipes", v); closeSheet(); break; }
    case "rec-plan": { const r = allRecipes().find(x => x.id === v), d = $("#rc-d").value || TODAY;
      store.put("meals", d, { [$("#rc-p").value]: r.n }); closeSheet(); toast(`${r.n}: ${fmtShort(d)}`); break; }
    case "rec-shop": { const r = allRecipes().find(x => x.id === v), have = new Set(L("shopping").filter(s => !s.done).map(s => s.name.toLowerCase()));
      missing(r).filter(x => !have.has(x)).forEach(x => store.put("shopping", "s_" + uid(), { name: x[0].toUpperCase() + x.slice(1), done: false, order: Date.now() }));
      toast("Aggiunti alla lista"); recipeSheet(v); break; }
    case "plan-save-recipes": { const m = LS.get(K.chat, [])[Number(v)], known = new Set(allRecipes().map(r => r.n.toLowerCase())); let n = 0;
      (m?.actions || []).filter(a => a.k === "meal" && !known.has(a.piatto.toLowerCase())).forEach(a => { known.add(a.piatto.toLowerCase()); n++;
        store.put("recipes", "r_" + uid(), { n: a.piatto, i: [], min: null, note: "Proposta dall'Oracolo: aggiungi gli ingredienti." }); });
      toast(n ? `${n} ${n === 1 ? "piatto salvato" : "piatti salvati"} nel ricettario` : "Sono già tutti nel ricettario"); break; }
    case "throne": throneSheet(); break;
    case "shop-add": addShop(); break;
    case "shop-toggle": store.put("shopping", v, { done: !store.get("shopping", v).done }); break;
    case "shop-del": store.del("shopping", v); break;
    case "shop-stash": { const got = L("shopping").filter(s => s.done);
      got.forEach(s => { store.put("pantry", "p_" + uid(), { name: s.name, expires: null }); store.del("shopping", s.id); });
      logIt("spesa", got.map(s => s.name).join(", "), got.length); store.addXP(me(), 5 * got.length, "spesa"); toast(`${got.length} oggetti in inventario, +${5 * got.length} XP`); break; }
    case "pan-add": { const n = $("#pan-in").value.trim(); if (!n) return; store.put("pantry", "p_" + uid(), { name: n, expires: $("#pan-exp").value || null }); break; }
    case "pantry-use": { const p = store.get("pantry", v); if (p) logIt(daysLeft(p) !== null && daysLeft(p) < 0 ? "spreco" : "usato", p.name); store.del("pantry", v);
      if (p && confirm(`Rimettere "${p.name}" nella lista della spesa?`)) store.put("shopping", "s_" + uid(), { name: p.name, done: false, order: Date.now() }); break; }
    /* casa */
    case "waste": { const w = store.get("waste", b.dataset.k), d = Number(v), days = [...(w.days || [])]; const i = days.indexOf(d); i < 0 ? days.push(d) : days.splice(i, 1);
      store.put("waste", w.id, { days }); break; }
    /* oracolo */
    case "ask": tab = "oracolo"; ask(v); break;
    case "ask-send": ask($("#ask-in").value); break;
    case "oracle-mode": LS.set(K.oracle, v); settingsSheet(); break;
    case "gem-save": LS.set(K.gem, $("#gem-key").value.trim()); if ($("#gem-key").value.trim()) LS.set(K.oracle, "gemini"); toast("Chiave salvata"); settingsSheet(); break;
    case "plan-local": planLocally(); break;
    case "recopy": { const m = LS.get(K.chat, [])[Number(v)]; try { await navigator.clipboard.writeText(m.prompt); toast("Copiato"); } catch (err) { toast("Copia non riuscita"); } break; }
    case "paste-reply": pasteReply($("#reply-in").value); break;
    case "paste-clip": try { pasteReply(await navigator.clipboard.readText()); } catch (err) { toast("Incolla a mano nel riquadro"); } break;
    case "chat-clear": LS.set(K.chat, []); render(); break;
    case "plan-apply": applyPlan(Number(v)); break;
    case "plan-discard": discardPlan(Number(v)); break;
  }
}
function addShop() { const n = $("#shop-in").value.trim(); if (!n) return; store.put("shopping", "s_" + uid(), { name: n, done: false, order: Date.now() }); }
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeSheet();
  if (e.key !== "Enter") return;
  if (e.target.id === "xp" && store) throneSheet();
  if (e.target.id === "shop-in") addShop();
  if (e.target.id === "ask-in") ask(e.target.value);
  if (e.target.id === "rq") { LS.set("regno.rq", e.target.value); render(); }
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.meal) { store.put("meals", selDay, { [t.dataset.meal]: t.value.trim() }); toast("Pasto salvato"); }
  if (t.id === "rq") { LS.set("regno.rq", t.value); render(); }
  if (t.dataset.roomN) store.put("rooms", t.dataset.roomN, { name: t.value.trim() || "Stanza" });
  if (t.dataset.roomE) store.put("rooms", t.dataset.roomE, { e: t.value.trim() || "🏠" });
  if (t.dataset.player) store.put("players", t.dataset.player, { name: t.value.trim() || "Giocatore" });
  if (t.id === "imp" && t.files[0]) {
    t.files[0].text().then(txt => { const d = JSON.parse(txt); if (d.schema !== "regno-di-cristallo") throw 0;
      if (d.householdId === store.doc.householdId) store.adopt(mergeDocs(store.doc, d));
      else if (!syncer) store.adopt(d);
      else { toast("Questo file è di un'altra casa"); return; }
      closeSheet(); toast("File importato"); })
      .catch(() => toast("File non valido: serve un salvataggio del Regno"));
  }
});
window.addEventListener("online", () => { if (syncer) doSync(); });
window.addEventListener("offline", () => { if (syncer) { syncState = "offline"; paintSync(); } });

boot();
