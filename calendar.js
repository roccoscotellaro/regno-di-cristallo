/* Google Calendar: lettura dei vostri calendari e scrittura nel "calendario del Regno".
 * Ambiti OAuth: calendar.readonly (leggere) e calendar.app.created
 * (gestire solo i calendari creati da questa app). */
import { getToken } from "./drive.js";

const API = "https://www.googleapis.com/calendar/v3";

async function call(path, { method = "GET", body, query } = {}) {
  const u = new URL(API + path);
  if (query) Object.entries(query).forEach(([k, v]) => v != null && u.searchParams.set(k, v));
  const res = await fetch(u, { method, headers: { Authorization: `Bearer ${await getToken()}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(data?.error?.message || `Calendar ${res.status}`); e.status = res.status; throw e; }
  return data;
}

export async function listCalendars() {
  const r = await call("/users/me/calendarList", { query: { minAccessRole: "reader", maxResults: 250 } });
  return (r.items || []).map(c => ({ id: c.id, name: c.summaryOverride || c.summary, color: c.backgroundColor || "#888", primary: !!c.primary }));
}

export async function createCalendar(summary, timeZone) {
  const c = await call("/calendars", { method: "POST", body: { summary, timeZone, description: "Creato dal Regno di Cristallo" } });
  return c.id;
}

export function share(calId, email) {
  return call(`/calendars/${encodeURIComponent(calId)}/acl`, { method: "POST", query: { sendNotifications: "true" }, body: { role: "writer", scope: { type: "user", value: email } } });
}

/* Eventi (ricorrenze già espanse) dei calendari scelti, in un intervallo. */
export async function events(cals, timeMin, timeMax) {
  const out = [];
  for (const c of cals) {
    let pageToken;
    do {
      const r = await call(`/calendars/${encodeURIComponent(c.id)}/events`, { query: { timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: 250, pageToken } });
      (r.items || []).filter(e => e.status !== "cancelled").forEach(e => out.push({
        cal: c.id, color: c.color, calName: c.name, id: e.id, title: e.summary || "(senza titolo)",
        allDay: !!e.start?.date, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
      }));
      pageToken = r.nextPageToken;
    } while (pageToken);
  }
  return out;
}

/* Id stabile per ogni elemento del Regno: lo stesso record aggiorna sempre lo stesso evento. */
export const gid = s => "rg" + [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, "0")).join("");

export async function upsert(calId, id, body) {
  const path = `/calendars/${encodeURIComponent(calId)}/events`;
  try { return await call(`${path}/${id}`, { method: "PUT", body: { ...body, status: "confirmed" } }); }
  catch (e) { if (e.status !== 404) throw e; }
  return call(path, { method: "POST", body: { ...body, id } });
}

export async function remove(calId, id) {
  try { await call(`/calendars/${encodeURIComponent(calId)}/events/${id}`, { method: "DELETE" }); }
  catch (e) { if (![404, 410].includes(e.status)) throw e; }
}
