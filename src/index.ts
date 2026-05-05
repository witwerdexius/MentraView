import { AppServer, AppSession } from "@mentra/sdk";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import express from "express";
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
    // Kurz tippen  → nächste Seite
    // Lang drücken → vorherige Seite
    session.events.onButtonPress((data) => {
      const state = activeSessions.get(userId);
      if (!state || state.pages.length === 0) {
        session.layouts.showTextWall(
          "Noch kein Artikel geladen.\nÖffne die Web-UI am Handy."
        );
        return;
      }

      if (data.pressType === "short") {
        // Nächste Seite
        if (state.currentPage < state.pages.length - 1) {
          state.currentPage++;
          showCurrentPage(state);
        } else {
          session.layouts.showTextWall(
            "— Ende des Artikels —\n\nLang drücken = zurück scrollen"
          );
        }
      } else if (data.pressType === "long") {
        // Vorherige Seite
        if (state.currentPage > 0) {
          state.currentPage--;
          showCurrentPage(state);
        } else {
          session.layouts.showTextWall(
            "— Erste Seite —\n\nKurz tippen = vorwärts scrollen"
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

// ─── Web UI (Express) ─────────────────────────────────────────────────────────

const webApp = express();
webApp.use(express.json());
webApp.use(express.static(path.join(__dirname, "..", "public")));

/**
 * POST /load
 * Body: { userId: string, url: string }
 * Lädt eine URL und schickt den Text an die Brille des Nutzers.
 */
webApp.post("/load", async (req, res) => {
  const { userId, url } = req.body as { userId?: string; url?: string };

  if (!userId || !url) {
    res.status(400).json({ error: "userId und url sind erforderlich." });
    return;
  }

  // Einfache URL-Validierung
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Nur http:// und https:// URLs erlaubt.");
    }
  } catch {
    res.status(400).json({ error: "Ungültige URL." });
    return;
  }

  try {
    await loadUrl(userId, parsedUrl.href);
    const state = activeSessions.get(userId);
    res.json({
      success: true,
      title: state?.title ?? "",
      pages: state?.pages.length ?? 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /status
 * Gibt an, ob ein Nutzer gerade eine aktive Brille verbunden hat.
 */
webApp.get("/status", (req, res) => {
  const userId = req.query.userId as string | undefined;
  if (!userId) {
    res.json({ connected: false });
    return;
  }
  res.json({
    connected: activeSessions.has(userId),
    pages: activeSessions.get(userId)?.pages.length ?? 0,
    currentPage: (activeSessions.get(userId)?.currentPage ?? 0) + 1,
    title: activeSessions.get(userId)?.title ?? "",
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

// MentraOS AppServer starten
const mentraApp = new ReaderApp({
  packageName: PACKAGE_NAME,
  apiKey: API_KEY,
  port: PORT,
});

// Express Web UI auf PORT+1 starten
// (Auf Render: Haupt-Port = PORT für MentraOS, PORT+1 für Web UI
//  → In der Render-Console beide Ports freigeben, oder Port anpassen)
const WEB_PORT = PORT + 1;
webApp.listen(WEB_PORT, () => {
  console.log(`[Web UI] läuft auf http://localhost:${WEB_PORT}`);
});

mentraApp.start().then(() => {
  console.log(`[MentraOS] Reader App läuft auf Port ${PORT}`);
});
