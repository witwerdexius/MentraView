# MentraView – Setup-Anleitung

## Lokale Entwicklung

```bash
# 1. Abhängigkeiten installieren
bun install

# 2. Umgebungsvariablen anlegen
cp .env.example .env
# → .env öffnen und MENTRA_API_KEY + PACKAGE_NAME eintragen

# 3. Server starten
bun dev

# 4. ngrok starten (neues Terminal)
ngrok http --url=<DEINE_NGROK_URL> 3000
```

## Deployment auf Render

1. GitHub-Repo erstellen und Code pushen
2. Auf render.com → New → Web Service → Repo verbinden
3. Build-Einstellungen:
   - **Build Command:** `bun install`
   - **Start Command:** `bun start`
4. Umgebungsvariablen in Render setzen:
   - `MENTRA_API_KEY` – aus console.mentraglass.com
   - `PACKAGE_NAME` – z.B. `com.deinname.reader`
5. Deploy starten

## Mentra Developer Console

- **Server URL:** `https://deine-app.onrender.com` (Port 3000)
- **Webview URL:** `https://deine-app.onrender.com:PORT+1` (Port 3001)
  - MentraOS hängt automatisch `?userId=...` an

## TouchBar-Steuerung

| Geste | Aktion |
|-------|--------|
| Kurz tippen | Nächste Seite |
| Lang drücken | Vorherige Seite |

## Architektur

```
G1-Brille ──BLE──► Handy (MentraOS) ──WebSocket──► Server :3000 (MentraOS SDK)
                         Webview ──HTTP──► Server :3001 (Express Web UI)
```
