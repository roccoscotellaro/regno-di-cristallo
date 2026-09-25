/* Consegna dei promemoria.
 * - Nell'app nativa (Capacitor) usa le notifiche locali: arrivano anche a telefono bloccato.
 * - Nell'app da schermata Home: avvisi dentro l'app, notifiche solo mentre è aperta,
 *   e la raccolta rifiuti esportata nel Calendario di iPhone con il suo avviso. */

let timers = [];

export async function deliver(reminders) {
  const LN = window.Capacitor?.Plugins?.LocalNotifications;
  const future = reminders.filter(r => r.at > Date.now()).sort((a, b) => a.at - b.at).slice(0, 60);
  if (LN) {
    await LN.requestPermissions();
    const pending = await LN.getPending();
    if (pending.notifications.length) await LN.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) });
    await LN.schedule({ notifications: future.map(r => ({ id: hash(r.id), title: r.title, body: r.body, schedule: { at: new Date(r.at), allowWhileIdle: true } })) });
    return "native";
  }
  timers.forEach(clearTimeout); timers = [];
  if ("Notification" in window && Notification.permission === "granted" && navigator.serviceWorker) {
    const reg = await navigator.serviceWorker.ready;
    for (const r of future) {
      const ms = r.at - Date.now();
      if (ms < 12 * 3600e3) timers.push(setTimeout(() => reg.showNotification(r.title, { body: r.body, tag: r.id, icon: "icons/icon-192.png" }), ms));
    }
  }
  return "web";
}

export async function askPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.requestPermission();
}

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

/* Calendario della raccolta: eventi settimanali con avviso alle 20:00 della sera prima. */
export function wasteICS(bins) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Il Regno di Cristallo//IT", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Raccolta rifiuti"];
  for (const b of bins) {
    if (!b.days?.length) continue;
    const first = new Date(now); first.setDate(first.getDate() + 1);
    while (!b.days.includes(first.getDay())) first.setDate(first.getDate() + 1);
    const end = new Date(first); end.setDate(end.getDate() + 1);
    lines.push("BEGIN:VEVENT", `UID:raccolta-${b.id}@regno-di-cristallo`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(first)}`, `DTEND;VALUE=DATE:${ymd(end)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${b.days.map(d => BYDAY[d]).join(",")}`,
      `SUMMARY:Raccolta ${b.name}`, "DESCRIPTION:Il Regno di Cristallo: porta fuori il bidone la sera prima.",
      "TRANSP:TRANSPARENT",
      "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:Stasera porta fuori: ${b.name}`, "TRIGGER:-PT4H", "END:VALARM",
      "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

/* Su iPhone apre il foglio di condivisione (da lì "Calendario" o "Salva su File"). */
export async function shareOrDownload(filename, text, type) {
  const file = new File([text], filename, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; } catch (e) { if (e.name === "AbortError") return false; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return true;
}

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) % 2147483647; }
