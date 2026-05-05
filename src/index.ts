import { AppServer, AppSession } from "@mentra/sdk";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import Bring from "bring-shopping";
import path from "path";
import { fileURLToPath } from "url";

// ─── Konfiguration ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000");
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.beispiel.reader";
const API_KEY = process.env.MENTRA_API_KEY || "";

const BRING_EMAIL = process.env.BRING_EMAIL ?? "";
const BRING_PASSWORD = process.env.BRING_PASSWORD ?? "";

/** Maximale Zeichen pro Seite auf dem G1-HUD */
const CHARS_PER_PAGE = 260;
/** Polling-Intervall für die Einkaufsliste in ms */
const BRING_POLL_MS = 5_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Typen ────────────────────────────────────────────────────────────────────

interface SessionState {
  pages: string[];
  currentPage: number;
  session: AppSession;
  title: string;
  /** "list" = Einkaufsliste aktiv, "article" = Artikel geladen */
  displayMode: "list" | "article";
  pollTimer: ReturnType<typeof setInterval> | null;
  /** Serialisierter Snapshot der letzten Liste — für Änderungserkennung */
  lastListSnapshot: string;
}

// Aktive Sessions: userId → State
const activeSessions = new Map<string, SessionState>();

// ─── Bring! Client ────────────────────────────────────────────────────────────

let bringClient: InstanceType<typeof Bring> | null = null;
let bringListUuid: string | null = null;

async function initBring(): Promise<void> {
  if (!BRING_EMAIL || !BRING_PASSWORD) {
    console.warn("[Bring] BRING_EMAIL oder BRING_PASSWORD nicht gesetzt — Liste deaktiviert.");
    return;
  }
  try {
    const client = new Bring({ mail: BRING_EMAIL, password: BRING_PASSWORD });
    await client.login();
    const { lists } = await client.loadLists();
    const zuhause = lists.find((l) => l.name === "Zuhause");
    if (!zuhause) {
      console.warn(
        `[Bring] 'Zuhause'-Liste nicht gefunden. Verfügbare Listen: ${lists.map((l) => l.name).join(", ")}`
      );
      return;
    }
    bringClient = client;
    bringListUuid = zuhause.listUuid;
    console.log(`[Bring] Login OK. Zuhause-Liste: ${bringListUuid}`);
  } catch (err) {
    console.error("[Bring] Login fehlgeschlagen:", err);
  }
}

async function fetchBringItems(): Promise<{ name: string; specification: string }[]> {
  if (!bringClient || !bringListUuid) return [];
  try {
    const response = await bringClient.getItems(bringListUuid);
    return response.purchase;
  } catch {
    // Token abgelaufen → erneut einloggen und nochmal versuchen
    try {
      await bringClient.login();
      const response = await bringClient.getItems(bringListUuid!);
      return response.purchase;
    } catch (err) {
      console.error("[Bring] Listenabfrage fehlgeschlagen:", err);
      return [];
    }
  }
}

// G1 display: 576 px wide, ~11 px/char average → 52 chars per line, 5 lines max
// Two equal columns: 25 chars each + 2-char gap = 52
const DISPLAY_COLS = 52;
const COL_GAP = 2;
const COL_WIDTH = Math.floor((DISPLAY_COLS - COL_GAP) / 2); // 25

function itemLabel(item: { name: string; specification: string }): string {
  const s = item.specification ? `${item.name} (${item.specification})` : item.name;
  return s.length > COL_WIDTH ? s.slice(0, COL_WIDTH - 1) + "…" : s;
}

function formatBringList(items: { name: string; specification: string }[]): string {
  if (items.length === 0) return "✓ Alles erledigt!";

  const visible = items.slice(0, 10);
  const col1 = visible.slice(0, 5);
  const col2 = visible.slice(5, 10);
  const gap = " ".repeat(COL_GAP);

  return col1
    .map((item, i) => {
      const left = itemLabel(item).padEnd(COL_WIDTH);
      const right = col2[i] ? itemLabel(col2[i]) : "";
      return right ? `${left}${gap}${right.padStart(COL_WIDTH)}` : left.trimEnd();
    })
    .join("\n");
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

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

function showCurrentPage(state: SessionState): void {
  const { pages, currentPage, session, title } = state;
  const header = `[${currentPage + 1}/${pages.length}] ${title}`;
  const content = pages[currentPage];
  session.layouts.showTextWall(`${header}\n\n${content}`);
}

async function loadUrl(userId: string, url: string): Promise<void> {
  const state = activeSessions.get(userId);
  if (!state) throw new Error("Keine aktive G1-Session gefunden.");

  state.session.layouts.showTextWall(`⏳ Lade Artikel…\n\n${url}`);

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

  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.textContent?.trim()) {
    state.session.layouts.showTextWall(
      "❌ Kein lesbarer Inhalt gefunden.\n\nVersuche eine andere URL."
    );
    throw new Error("Kein lesbarer Inhalt");
  }

  const pages = paginateText(article.textContent, CHARS_PER_PAGE);
  state.pages = pages;
  state.currentPage = 0;
  state.title = article.title?.slice(0, 30) || "Artikel";
  state.displayMode = "article";

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

    const state: SessionState = {
      pages: [],
      currentPage: 0,
      session,
      title: "",
      displayMode: "list",
      pollTimer: null,
      lastListSnapshot: "",
    };
    activeSessions.set(userId, state);

    if (bringClient && bringListUuid) {
      // Erste Anzeige sofort
      const items = await fetchBringItems();
      state.lastListSnapshot = JSON.stringify(items);
      session.layouts.showTextWall(formatBringList(items));

      // Polling alle 5 Sekunden
      state.pollTimer = setInterval(async () => {
        const currentState = activeSessions.get(userId);
        if (!currentState || currentState.displayMode !== "list") return;

        const newItems = await fetchBringItems();
        const newSnapshot = JSON.stringify(newItems);
        if (newSnapshot !== currentState.lastListSnapshot) {
          currentState.lastListSnapshot = newSnapshot;
          currentState.session.layouts.showTextWall(formatBringList(newItems));
        }
      }, BRING_POLL_MS);
    } else {
      session.layouts.showTextWall(
        "📖 Web Reader\n\nÖffne die App-URL am Handy,\ngib eine Website-Adresse ein\nund die Brille zeigt den Text.\n\nTippen/wischen = Seite blättern"
      );
    }

    session.events.onSessionEnd?.(() => {
      console.log(`[Session] Beendet: userId=${userId}`);
      const s = activeSessions.get(userId);
      if (s?.pollTimer) clearInterval(s.pollTimer);
      activeSessions.delete(userId);
    });
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const mentraApp = new ReaderApp({
  packageName: PACKAGE_NAME,
  apiKey: API_KEY,
  port: PORT,
  publicDir: path.join(__dirname, "..", "public"),
});

/**
 * POST /load
 * Body: { userId: string, url: string }
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
 * POST /navigate
 * Body: { userId: string, direction: "next" | "prev" }
 */
mentraApp.post("/navigate", async (c) => {
  let body: { userId?: string; direction?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Ungültiger Body" }, 400);
  }

  const { userId, direction } = body;
  if (!userId) return c.json({ error: "userId fehlt" }, 400);

  const state = activeSessions.get(userId);
  if (!state) return c.json({ error: "Keine aktive Session" }, 404);
  if (state.pages.length === 0) return c.json({ error: "Kein Artikel geladen" }, 400);

  if (direction === "next") {
    if (state.currentPage < state.pages.length - 1) {
      state.currentPage++;
      showCurrentPage(state);
    } else {
      state.session.layouts.showTextWall(
        "— Ende des Artikels —\n\nNach oben wischen = zurück"
      );
    }
  } else if (direction === "prev") {
    if (state.currentPage > 0) {
      state.currentPage--;
      showCurrentPage(state);
    } else {
      state.session.layouts.showTextWall(
        "— Erste Seite —\n\nTippen oder nach unten wischen = vorwärts"
      );
    }
  }

  return c.json({ ok: true, page: state.currentPage + 1, total: state.pages.length });
});

/**
 * POST /showlist?userId=...
 * Zeigt die Bring!-Einkaufsliste sofort auf der Brille an.
 */
mentraApp.post("/showlist", async (c) => {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "userId fehlt" }, 400);

  const state = activeSessions.get(userId);
  if (!state) return c.json({ error: "Keine aktive Session" }, 404);

  if (!bringClient || !bringListUuid) {
    return c.json({ error: "Bring! nicht konfiguriert" }, 503);
  }

  const items = await fetchBringItems();
  state.lastListSnapshot = JSON.stringify(items);
  state.displayMode = "list";
  state.session.layouts.showTextWall(formatBringList(items));

  return c.json({ ok: true, count: items.length });
});

/**
 * GET /sessions
 */
mentraApp.get("/sessions", (c) => {
  return c.json({ sessions: Array.from(activeSessions.keys()) });
});

/**
 * GET /status
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

await initBring();
await mentraApp.start();
Bun.serve({ port: PORT, fetch: mentraApp.fetch.bind(mentraApp) });
console.log(`[MentraOS] App läuft auf Port ${PORT}`);
