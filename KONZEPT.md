# pdf2x4 — Konzept

> Hosted PDF → druckfertiges **PDF/X-4**. Domain: **pdf2x4.services.gutermann.gmbh**
> Schwesterprojekt zu [md2bookpdf](../md2bookpdf) (`md2bookpdf.services.gutermann.gmbh`).
> Stand: 2026-06-10.
>
> **Aktualisierung:** pdf2x4 läuft inzwischen **vollständig im Browser** (GS-WASM +
> pdf-lib, kein Upload) statt server-seitig — siehe `app/`. Die Pipeline-Logik unten
> beschreibt die Schritte; das CLI `backend/pdfx4.py` ist die server-seitige Variante
> (nativer gs) und nur noch optional. Deployment = statischer nginx-Container.

## 1. Ausgangslage & Entscheidung

md2bookpdf erzeugte das druckfertige PDF/X-4 bisher selbst — der Farb-Schritt
(sRGB→CMYK) lief über **Ghostscript-WASM im Browser**. Ghostscript steht unter
**AGPL-3.0**. Ein eigener Server entfernt diese Pflicht **nicht** (AGPL §13 greift
gezielt bei Netz-/SaaS-Nutzung).

**Getroffene Entscheidung:** pdf2x4 wird **Open Source unter AGPL-3.0**. Damit darf
Ghostscript voll und gebührenfrei genutzt werden — die AGPL-Pflicht ist mit einem
**„Quellcode“-Link im Footer** erfüllt. Vorteil gegenüber einer Ghostscript-freien
Variante: **echte RGB→CMYK-Separation** (pikepdf allein kann das nicht; alle
permissiv lizenzierten Tools auch nicht — die einzigen Engines dafür sind copyleft).

Konsequenz: Der X-4-Schritt zieht aus md2bookpdf in diesen eigenen Dienst um.

## 2. Ablauf (zwei Schritte, zwei Seiten)

```
①  md2bookpdf.services.gutermann.gmbh (md2bookpdf): Buch → „PDF (Druck-Dialog)“ → Als PDF speichern
       ⇒ vorbereitendes Druck-PDF (sRGB, Schriften eingebettet)
                      │
②  pdf2x4.services.gutermann.gmbh: Druck-PDF hochladen ⇒ name.X4.pdf  ⇒ an die Druckerei
```

## 3. Technik

- **Backend** (Python/FastAPI, `backend/`): natives `gs` (10.02.1, **-dSAFER**) macht
  sRGB→DeviceCMYK + Output-Intent (eingebettetes ICC) + Font-Einbettung;
  `pikepdf` setzt TrimBox/BleedBox, unkomprimiertes XMP (`pdfxid:GTS_PDFXVersion =
  PDF/X-4`) + Info synchron, entfernt Annotationen/Aktionen/JS, erzwingt PDF 1.6.
  Danach ein **Preflight-Selbstcheck**.
- **Frontend** (`frontend/index.html`): One-Pager mit Upload, Optionen
  (Profil FOGRA39/47, Rendering-Intent, Anschnitt), Ergebnis + Preflight-Report,
  Erklärung „was ist X-4 / wie erzeuge ich das PDF“, Link zu md2bookpdf.
- **Hosting**: **Docker-Container** (`docker compose`, restart: unless-stopped), Caddy
  reverse_proxy `pdf2x4.services.gutermann.gmbh` → `127.0.0.1:8011`. Dateien in
  Container-`/tmp` (tmpfs), Auto-Löschung nach 30 Min. md2bookpdf läuft als eigener
  Container (Vite-Prod-Build via nginx) unter `md2bookpdf.services.gutermann.gmbh`.

### Gelöste Stolpersteine
- **gs unter -dSAFER + ICC**: ICC im Prolog mit **absolutem Pfad** öffnen und per
  `--permit-file-read` genau diese Datei freigeben (relativer Open scheitert an SAFER).
- **Prolog-Dateiname**: **nicht** `PDFX_def.ps` nennen — dieser gs-reservierte Name
  aktiviert eine PDF/X-Sonderbehandlung, die unter SAFER ein Phantom-Profil
  („ISO Coated sb.icc“, aus dem `%` im desc-Tag) zu öffnen versucht → Abbruch.
  Neutraler Name (`oi_setup.ps`) umgeht das.

## 4. Lizenz-Konformität (Checkliste)
1. Repo öffentlich unter **AGPL-3.0** (`LICENSE` liegt bei).
2. **„Quellcode“-Link im Footer** → Repo. (Die eigentliche AGPL-§13-Pflicht.)
3. Ghostscript-AGPL-Hinweis im Footer/README behalten.
→ 0 €, keine kommerzielle Ghostscript-Lizenz, keine Grauzone.

## 5. Rückbau in md2bookpdf
- **Raus:** Abhängigkeit `@jspawn/ghostscript-wasm` (~16 MB `gs.wasm`),
  `app/src/lib/pdfx3Pipeline.*`, `app/src/types/ghostscript-wasm.d.ts`,
  Export-Punkt „PDF/X (Druckerei)…“ samt Modal + AGPL-Hinweis, die ICC-/Druck-
  Einstellungen.
- **Bleibt:** „PDF (Druck-Dialog)“ (liefert genau das Eingabe-PDF für pdf2x4),
  Lesezeichen-Export.
- **Neu:** Hinweis-Block „X-4 für die Druckerei? → pdf2x4.services.gutermann.gmbh“. Rück-Link
  von pdf2x4 nach md2bookpdf.
- `tools/pdfx4_fix.py` bleibt als Legacy-Referenz (war die Vorlage für `backend/pdfx4.py`).

## 6. Offene Punkte
- Realen X-4-Validitäts-Check gegen Acrobat-Preflight / die Ziel-Druckerei fahren
  (der eingebaute Check ist nur ein Selbst-Check, kein ISO-Validator).
- Öffentliches GitHub-Repo anlegen + Footer-Link auf die echte URL setzen
  (aktuell Platzhalter `github.com/gutermannxyz/pdf2x4`).
- Profil-Auswahl bei Bedarf erweitern (weitere Papiere).
