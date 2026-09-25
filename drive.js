/* Accesso a Google e selettore file. Flusso OAuth a reindirizzamento:
 * funziona anche nell'app aggiunta alla schermata Home di iPhone. */
import { CONFIG } from "./config.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const TK = "regno.gtoken";
const redirectUri = () => location.origin + location.pathname;

/* Da chiamare all'avvio: raccoglie il token tornando da Google. */
export function handleRedirect() {
  if (!location.hash.includes("access_token")) {
    if (location.hash.includes("error=")) history.replaceState(null, "", redirectUri());
    return false;
  }
  const p = new URLSearchParams(location.hash.slice(1));
  const tok = { t: p.get("access_token"), exp: Date.now() + (Number(p.get("expires_in") || 3600) - 60) * 1000 };
  try { localStorage.setItem(TK, JSON.stringify(tok)); } catch (e) {}
  history.replaceState(null, "", redirectUri());
  return true;
}
export function currentToken() {
  try { const t = JSON.parse(localStorage.getItem(TK)); return t && t.exp > Date.now() ? t.t : null; } catch (e) { return null; }
}
export function forgetToken() { try { localStorage.removeItem(TK); } catch (e) {} }

/* Porta a Google e poi di nuovo all'app. silent=true salta la scelta dell'account. */
export function login({ silent = false } = {}) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: CONFIG.googleClientId, redirect_uri: redirectUri(), response_type: "token",
    scope: SCOPE, include_granted_scopes: "true", prompt: silent ? "" : "select_account",
  }).toString();
  location.href = u.toString();
}

export async function getToken() {
  const t = currentToken();
  if (t) return t;
  const e = new Error("Serve un nuovo accesso a Google"); e.code = "login"; throw e;
}

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}

/* Selettore di Google Drive: serve alla seconda persona per aprire il file condiviso.
 * Con il permesso drive.file l'app può leggere solo i file scelti qui o creati da lei. */
export async function pickHouseFile() {
  if (!window.gapi) await loadScript("https://apis.google.com/js/api.js");
  await new Promise(r => window.gapi.load("picker", r));
  const token = await getToken();
  const P = window.google.picker;
  return new Promise(res => {
    const view = new P.DocsView(P.ViewId.DOCS).setMimeTypes("application/json").setQuery(CONFIG.fileName.replace(".json", "")).setIncludeFolders(false);
    new P.PickerBuilder()
      .addView(view)
      .setOAuthToken(token).setDeveloperKey(CONFIG.googleApiKey).setAppId(CONFIG.googleAppId)
      .setLocale("it").setTitle("Scegli il file del Regno")
      .setCallback(d => {
        if (d.action === P.Action.PICKED) res(d.docs[0].id);
        else if (d.action === P.Action.CANCEL) res(null);
      })
      .build().setVisible(true);
  });
}
