import { AppServer, AppSession } from "@mentra/sdk";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";

// ─── Konfiguration ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000");
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.beispiel.reader";
const API_KEY = process.env.MENTRA_API_KEY || "";

/** Maximale Zeichen pro Seite auf dem G1-HUD */
const CHARS_PER_PAGE = 260;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Typen ────────────────────────────────────────────────────────────────────

interface SessionState {
  pages: string[];
  currentPage: number;
  session: AppSession;
  title: string;
}

// Aktive Sessions: userId → State
const activeSessions = new Map<string, SessionState>();

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

/**
 * Teilt einen langen Text in Seiten mit maximal `maxChars` Zeichen auf.
 * Bricht nur an Wortgrenzen um.
 */
function paginateText(text: string, maxChars: number): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ");
  const pages: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current.length > 0) {
      pages.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) pages.push(current.trim());

  return pages;
}

/**
 * Zeigt die aktuelle Seite auf der Brille an.
 */
function showCurrentPage(state: SessionState): void {
  const { pages, currentPage, session, title } = state;
  const header = `[${currentPage + 1}/${pages.length}] ${title}`;
  const content = pages[currentPage];
  session.layouts.showTextWall(`${header}\n\n${content}`);
}

/**
 * Lädt eine URL, extrahiert den Lesbarkeits-Text (Firefox Reader Mode)
 * und speichert die paginierten Seiten in der Session.
 */
async function loadUrl(userId: string, url: string): Promise<void> {
  const state = activeSessions.get(userId);
  if (!state) throw new Error("Keine aktive G1-Session gefunden.");

  state.session.layouts.showTextWall(`⏳ Lade Artikel…\n\n${url}`);

  // URL fetchen
  let html: string;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; MentraReader/1.0; +https://mentra.glass)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP-Fehler ${response.status}`);
    html = await response.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.session.layouts.showTextWall(`❌ Abruf fehlgeschlagen:\n\n${msg}`);
    throw err;
  }

  // Readability (Firefox Reader Mode)
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.textContent?.trim()) {
    state.session.layouts.showTextWall(
      "❌ Kein lesbarer Inhalt gefunden.\n\nVersuche eine andere URL."
    );
    throw new Error("Kein lesbarer Inhalt");
  }

  // Paginieren
  const pages = paginateText(article.textContent, CHARS_PER_PAGE);
  state.pages = pages;
  state.currentPage = 0;
  state.title = article.title?.slice(0, 30) || "Artikel";

  showCurrentPage(state);
}

// ─── MentraOS App ─────────────────────────────────────────────────────────────

class ReaderApp extends AppServer {
  protected async onSession(
    session: AppSession,
    sessionId: string,
    userId: string
  ): Promise<void> {
    console.log(`[Session] Neue Verbindung: userId=${userId}`);

    // State initialisieren
    activeSessions.set(userId, {
      pages: [],
      currentPage: 0,
      session,
      title: "",
    });

    // Willkommenstext
    session.layouts.showTextWall(
      "📖 Web Reader\n\nÖffne die App-URL am Handy,\ngib eine Website-Adresse ein\nund die Brille zeigt den Text."
    );

    // ── TouchBar-Steuerung ──────────────────────────────────────────
    // Vorwärts : single_tap  oder forward_swipe
    // Rückwärts: long_press  oder backward_swipe
    session.events.onTouchEvent((data) => {
      // Jede Geste loggen – sichtbar in Render-Logs und beim Debuggen
      console.log(`[Touch] userId=${userId} gesture=${data.gesture_name} model=${data.device_model ?? "?"}`);

      const state = activeSessions.get(userId);
      if (!state || state.pages.length === 0) {
        // Kein Artikel geladen → Gesture auf dem HUD anzeigen (Debug-Hilfe)
        session.layouts.showTextWall(
          `TouchBar erkannt: ${data.gesture_name}\n\nLade zuerst einen Artikel über die Web-UI.`
        );
        return;
      }

      const isForward  = data.gesture_name === "single_tap"  || data.gesture_name === "forward_swipe";
      const isBackward = data.gesture_name === "long_press"   || data.gesture_name === "backward_swipe";

      if (isForward) {
        if (state.currentPage < state.pages.length - 1) {
          state.currentPage++;
          showCurrentPage(state);
        } else {
          session.layouts.showTextWall(
            "— Ende des Artikels —\n\nLang drücken = zurück scrollen"
          );
        }
      } else if (isBackward) {
        if (state.currentPage > 0) {
          state.currentPage--;
          showCurrentPage(state);
        } else {
          session.layouts.showTextWall(
            "— Erste Seite —\n\nEinmal tippen = vorwärts scrollen"
          );
        }
      }
    });

    // Session aufräumen wenn Brille trennt
    session.events.onSessionEnd?.(() => {
      console.log(`[Session] Beendet: userId=${userId}`);
      activeSessions.delete(userId);
    });
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

// AppServer extends Hono — beide auf einem einzigen PORT
const mentraApp = new ReaderApp({
  packageName: PACKAGE_NAME,
  apiKey: API_KEY,
  port: PORT,
  publicDir: path.join(__dirname, "..", "public"),
});

/**
 * POST /load
 * Body: { userId: string, url: string }
 * Lädt eine URL und schickt den Text an die Brille des Nutzers.
 */
mentraApp.post("/load", async (c) => {
  let body: { userId?: string; url?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "userId und url sind erforderlich." }, 400);
  }

  const { userId, url } = body;

  if (!userId || !url) {
    return c.json({ error: "userId und url sind erforderlich." }, 400);
  }

  // Einfache URL-Validierung
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Nur http:// und https:// URLs erlaubt.");
    }
  } catch {
    return c.json({ error: "Ungültige URL." }, 400);
  }

  try {
    await loadUrl(userId, parsedUrl.href);
    const state = activeSessions.get(userId);
    return c.json({
      success: true,
      title: state?.title ?? "",
      pages: state?.pages.length ?? 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
    return c.json({ error: msg }, 500);
  }
});

/**
 * GET /sessions
 * Gibt alle aktuell verbundenen userIds zurück.
 */
mentraApp.get("/sessions", (c) => {
  return c.json({ sessions: Array.from(activeSessions.keys()) });
});

/**
 * GET /status
 * Gibt an, ob ein Nutzer gerade eine aktive Brille verbunden hat.
 */
mentraApp.get("/status", (c) => {
  const userId = c.req.query("userId");
  if (!userId) {
    return c.json({ connected: false });
  }
  return c.json({
    connected: activeSessions.has(userId),
    pages: activeSessions.get(userId)?.pages.length ?? 0,
    currentPage: (activeSessions.get(userId)?.currentPage ?? 0) + 1,
    title: activeSessions.get(userId)?.title ?? "",
  });
});

// start() initialises the SDK connection but does not bind the HTTP server —
// Bun.serve() must be called explicitly to keep the process alive.
await mentraApp.start();
Bun.serve({ port: PORT, fetch: mentraApp.fetch.bind(mentraApp) });
console.log(`[MentraOS] Reader App läuft auf Port ${PORT}`);
