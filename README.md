# pdf2x4

Druck-PDF → **PDF/X-4** (ISO 15930-7) für die Druckerei — **komplett im Browser, ohne Upload**.
Live: **https://pdf2x4.services.gutermann.gmbh** · Schwesterprojekt: [md2bookpdf](https://md2bookpdf.services.gutermann.gmbh)

Aus einem normalen (sRGB-)Druck-PDF wird eine X-4-konforme Datei: sRGB→DeviceCMYK,
Output-Intent mit eingebettetem ICC-Profil (FOGRA39 / FOGRA47), alle Schriften
eingebettet, TrimBox/BleedBox, konsistente XMP-/Info-Metadaten, Interaktiv-Elemente
entfernt, PDF 1.6.

> **Datenschutz:** Die Umwandlung läuft per WebAssembly **vollständig in deinem Browser**
> (Ghostscript-WASM + pdf-lib). Deine PDF wird zu keinem Zeitpunkt an einen Server gesendet.

## Lizenz / Warum AGPL

pdf2x4 nutzt **Ghostscript** (AGPL-3.0, als WebAssembly) für die CMYK-Farbkonversion.
Damit das gebührenfrei und ohne Lizenz-Grauzone ist, ist **pdf2x4 selbst unter
[AGPL-3.0](LICENSE) veröffentlicht** — der „Quellcode“-Link im Footer erfüllt die
AGPL-§13-Pflicht. Keine kommerzielle Ghostscript-Lizenz nötig.

Bibliotheken: Ghostscript-WASM (AGPL-3.0), pdf-lib (MIT), Vite (MIT).

## Projektstruktur

```
app/        Vite-Client-App (TypeScript, kein Backend)
  src/convert.ts   GS-WASM + pdf-lib Pipeline (inkl. Preflight-Selbstcheck)
  src/main.ts      UI: Datei lokal wählen, Optionen, Theme, Einstellungs-JSON, Convert
  index.html       UI + Styles + Logo + Hell/Dunkel
  public/assets/   ICC-Profile (ISO Coated v2 / PSO Uncoated)
Dockerfile          Multi-Stage: Vite-Build → nginx (statisch)
nginx.conf, docker-compose.yml
backend/pdfx4.py    OPTIONALES CLI (nativer gs + pikepdf) für Batch — nicht Teil der Web-App
systemd/            Caddy-Snippet (Reverse-Proxy-Block)
```

## Lokal starten (Entwicklung)

```bash
cd app
npm install
npm run dev        # http://localhost:5173
```

## Build & Deployment (Docker)

```bash
docker compose up -d --build      # baut Vite → nginx, Container auf 127.0.0.1:8011
```
Davor ein Reverse-Proxy (z. B. Caddy, siehe `systemd/caddy-snippet.txt`):
`pdf2x4.services.gutermann.gmbh` → `reverse_proxy 127.0.0.1:8011`.

## Optionales CLI (ohne Browser)

`backend/pdfx4.py` macht dasselbe server-seitig mit nativem Ghostscript + pikepdf —
nützlich für Batch-Verarbeitung. Bei Verwendung als Netzdienst gelten dieselben
AGPL-Pflichten.

```bash
pip install -r backend/requirements.txt   # pikepdf; zusätzlich `gs` im System
python3 backend/pdfx4.py EIN.pdf AUS.X4.pdf --title "Titel" --condition FOGRA39
```

## Hinweis zum Preflight

Der eingebaute Check (OutputIntent, GTS_PDFXVersion, TrimBox, Font-Einbettung,
Autor-Konsistenz Info↔XMP, keine Interaktivität) ist ein schneller Selbst-Check,
**kein** vollständiger ISO-Validator. Für kritische Aufträge zusätzlich im
Acrobat-Preflight prüfen.
