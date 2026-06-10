"""pdf2x4 — Kernkonvertierung: beliebiges (sRGB-)Druck-PDF -> druckfertiges PDF/X-4.

Zweistufige Pipeline (identisch zur md2bookpdf-Logik, aber serverseitig & gehärtet):
  1. Ghostscript (nativ, -dSAFER): sRGB -> DeviceCMYK, ALLE Fonts einbetten
     (inkl. Standard-14), OutputIntent (GTS_PDFX) mit eingebettetem ICC-Profil,
     Link-Annotationen/Aktionen verwerfen, PDF 1.6.
  2. pikepdf: TrimBox/BleedBox je Seite, UNkomprimiertes XMP mit
     pdfxid:GTS_PDFXVersion=PDF/X-4, Dokument-Info (UTF-16), Aktions-Reste raus.

Sicherheit: Im Gegensatz zum Original (pdfx4_fix.py, -dNOSAFER) läuft gs hier mit
-dSAFER. Da fremde Uploads verarbeitet werden, ist das Pflicht. Der Lesezugriff auf
das ICC-Profil im Arbeitsverzeichnis wird gezielt per --permit-file-read freigegeben.

Lizenz: Dieses Modul ruft Ghostscript (AGPL-3.0) als separaten Prozess auf. pdf2x4
ist insgesamt unter AGPL-3.0 veröffentlicht (siehe ../LICENSE); der Quellcode-Link
im Footer der Website erfüllt die AGPL-§13-Pflicht gegenüber Netz-Nutzern.
"""

from __future__ import annotations

import datetime
import subprocess
import tempfile
import uuid
from pathlib import Path

import pikepdf
from pikepdf import Name, String

PT_PER_MM = 72 / 25.4

# Bekannte Ausgabebedingungen (Output-Intent). identifier -> (Klartext, ICC-Dateiname)
OUTPUT_CONDITIONS = {
    "FOGRA39": ("ISO Coated v2 (ECI)", "ISOcoated_v2_300_eci.icc"),
    "FOGRA47": ("PSO Uncoated v3 (FOGRA47)", "PSO_Uncoated_ISO12647_eci.icc"),
}

ASSETS_DIR = Path(__file__).parent / "assets"


# --------------------------------------------------------------------------- #
# Ghostscript-Stufe
# --------------------------------------------------------------------------- #
def _gs_prolog(icc_path: str, icc_channels: int, cond: str, ident: str) -> str:
    esc = lambda s: s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return f"""%!
% Vollständige Font-Einbettung erzwingen (NeverEmbed [] hebt die Standard-14-Ausnahme auf).
<< /EmbedAllFonts true /SubsetFonts true /MaxSubsetPct 100 /NeverEmbed [ ] >> setdistillerparams
% OutputIntent (GTS_PDFX) mit eingebettetem ICC-Profil aus dem Arbeitsverzeichnis.
[/_objdef {{icc_PDFX}} /type /stream /OBJ pdfmark
[{{icc_PDFX}} <</N {icc_channels}>> /PUT pdfmark
[{{icc_PDFX}} ({esc(icc_path)}) (r) file /PUT pdfmark
[/_objdef {{OutputIntent_PDFX}} /type /dict /OBJ pdfmark
[{{OutputIntent_PDFX}} <<
  /Type /OutputIntent /S /GTS_PDFX
  /OutputCondition ({esc(cond)})
  /OutputConditionIdentifier ({esc(ident)})
  /RegistryName (http://www.color.org)
  /DestOutputProfile {{icc_PDFX}}
>> /PUT pdfmark
[{{Catalog}} <</OutputIntents [ {{OutputIntent_PDFX}} ]>> /PUT pdfmark
"""


def _icc_channels(icc_path: Path) -> int:
    b = icc_path.read_bytes()
    sig = b[16:20].decode("latin1") if len(b) >= 20 else "CMYK"
    return {"GRAY": 1, "RGB ": 3, "Lab ": 3, "XYZ ": 3, "CMYK": 4}.get(sig, 4)


def _run_ghostscript(
    src: Path, icc: Path, cond: str, ident: str, intent: int, out: Path,
    workdir: Path, timeout: int = 180,
) -> None:
    """gs-Lauf in einem isolierten Arbeitsverzeichnis, gehärtet mit -dSAFER."""
    icc_local = (workdir / icc.name).resolve()
    icc_local.write_bytes(icc.read_bytes())
    # NICHT "PDFX_def.ps" nennen — dieser gs-reservierte Name aktiviert eine
    # PDF/X-Sonderbehandlung, die unter -dSAFER ein Phantom-Profil zu öffnen
    # versucht ("ISO Coated sb.icc" aus dem desc-Tag) und mit invalidfileaccess
    # abbricht. Ein neutraler Name umgeht das vollständig.
    prolog = workdir / "oi_setup.ps"
    # ICC im Prolog mit ABSOLUTEM Pfad öffnen — unter -dSAFER matcht der
    # --permit-file-read-Check sonst den relativen Open nicht (invalidfileaccess).
    prolog.write_text(
        _gs_prolog(str(icc_local), _icc_channels(icc), cond, ident), encoding="utf-8"
    )
    args = [
        "gs",
        "-dSAFER",                          # Härtung: fremde Uploads dürfen kein Dateisystem/Netz anfassen
        f"--permit-file-read={icc_local}",  # nur genau das ICC-Profil zusätzlich lesbar
        "-dBATCH", "-dNOPAUSE", "-q",
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.6",
        "-sColorConversionStrategy=CMYK",
        f"-dRenderIntent={intent}",
        "-dEmbedAllFonts=true", "-dSubsetFonts=true",
        "-dPreserveAnnots=false",        # Chromium-<a>-Link-Annots verwerfen (in X unzulässig)
        f"-sOutputFile={out.name}",
        prolog.name, src.name,
    ]
    r = subprocess.run(
        args, cwd=workdir, capture_output=True, text=True, timeout=timeout
    )
    if r.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        raise RuntimeError(
            "Ghostscript-Konvertierung fehlgeschlagen "
            f"(Exit {r.returncode}).\n{r.stdout}\n{r.stderr}\n"
            "Tipp: Prüfe, ob das Eingabe-PDF alle Schriften eingebettet hat."
        )


# --------------------------------------------------------------------------- #
# pikepdf-Stufe (Finalisierung) + Preflight
# --------------------------------------------------------------------------- #
def _descriptor_has_fontfile(fd) -> bool:
    if not isinstance(fd, pikepdf.Dictionary):
        return False
    return any(k in fd for k in ("/FontFile", "/FontFile2", "/FontFile3"))


def _find_non_embedded_fonts(pdf: pikepdf.Pdf) -> list[str]:
    """Sicherheitsnetz: findet Fonts ohne eingebettetes Font-Programm."""
    bad: set[str] = set()
    for obj in pdf.objects:
        if not isinstance(obj, pikepdf.Dictionary):
            continue
        if obj.get("/Type") != Name.Font:
            continue
        st = str(obj.get("/Subtype", ""))
        name = str(obj.get("/BaseFont", "(unbenannt)"))
        if st == "/Type3":
            continue  # Glyphen stecken im Content-Stream
        if st == "/Type0":
            desc = obj.get("/DescendantFonts")
            cid = desc[0] if isinstance(desc, pikepdf.Array) and len(desc) else None
            fd = cid.get("/FontDescriptor") if isinstance(cid, pikepdf.Dictionary) else None
            if not _descriptor_has_fontfile(fd):
                bad.add(name)
        else:
            if not _descriptor_has_fontfile(obj.get("/FontDescriptor")):
                bad.add(name)
    return sorted(bad)


def _finalize(
    gs_pdf: Path, out: Path, title: str, author: str,
    width_mm: float, height_mm: float, bleed_mm: float, crop_marks: bool,
) -> None:
    when = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    now = when.isoformat()
    pdf = pikepdf.open(str(gs_pdf))

    unembedded = _find_non_embedded_fonts(pdf)
    if unembedded:
        pdf.close()
        raise RuntimeError(
            "Nicht alle Schriften eingebettet: " + ", ".join(unembedded)
            + ".\nDas Eingabe-PDF referenziert vermutlich eine Schrift ohne "
            "verfügbares Font-Programm."
        )

    # --- TrimBox + BleedBox je Seite ---
    trim_w, trim_h = width_mm * PT_PER_MM, height_mm * PT_PER_MM
    bleed_pt = bleed_mm * PT_PER_MM
    bleed_active = bleed_mm > 0 or crop_marks
    for page in pdf.pages:
        x0, y0, x1, y1 = (float(v) for v in page.MediaBox)
        w, h = x1 - x0, y1 - y0
        if not bleed_active:
            page.TrimBox = [x0, y0, x1, y1]
            page.BleedBox = [x0, y0, x1, y1]
        else:
            ix, iy = max(0, (w - trim_w) / 2), max(0, (h - trim_h) / 2)
            page.TrimBox = [x0 + ix, y0 + iy, x1 - ix, y1 - iy]
            bix, biy = max(0, ix - bleed_pt), max(0, iy - bleed_pt)
            page.BleedBox = [x0 + bix, y0 + biy, x1 - bix, y1 - biy]

    # --- XMP (unkomprimiert) + Dokument-Info synchron ---
    with pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=True) as meta:
        meta["dc:format"] = "application/pdf"
        meta["dc:title"] = title
        meta["dc:creator"] = [author] if author else []
        meta["xmp:CreatorTool"] = "pdf2x4"
        meta["xmp:CreateDate"] = now
        meta["xmp:ModifyDate"] = now
        meta["xmp:MetadataDate"] = now
        meta["pdf:Producer"] = "pdf2x4"
        meta["pdf:Trapped"] = "False"
        meta["xmpMM:DocumentID"] = "uuid:" + str(uuid.uuid4())
        meta["xmpMM:InstanceID"] = "uuid:" + str(uuid.uuid4())
        meta["xmpMM:RenditionClass"] = "default"
        meta["pdfxid:GTS_PDFXVersion"] = "PDF/X-4"

    pdf.docinfo[Name.Trapped] = Name("/False")
    pdf.docinfo[Name("/GTS_PDFXVersion")] = String("PDF/X-4")
    pdf.docinfo[Name.Creator] = String("pdf2x4")
    pdf_date = "D:" + when.strftime("%Y%m%d%H%M%S") + "+00'00'"
    pdf.docinfo[Name("/CreationDate")] = String(pdf_date)
    pdf.docinfo[Name("/ModDate")] = String(pdf_date)

    # --- Interaktivität restlos entfernen ---
    for k in ("/OpenAction", "/AA", "/Names", "/AcroForm"):
        if Name(k) in pdf.Root:
            del pdf.Root[Name(k)]
    for page in pdf.pages:
        for k in ("/Annots", "/AA"):
            if Name(k) in page:
                del page[Name(k)]

    pdf.save(str(out), force_version="1.6")
    pdf.close()


def preflight(pdf_path: Path) -> dict:
    """Schneller X-4-Selbstcheck der Ausgabedatei (kein voller ISO-Validator)."""
    checks: list[dict] = []

    def add(ok: bool, label: str, detail: str = ""):
        checks.append({"ok": bool(ok), "label": label, "detail": detail})

    with pikepdf.open(str(pdf_path)) as pdf:
        ver = pdf.pdf_version
        add(ver == "1.6", "PDF-Version 1.6", f"ist {ver}")

        oi = pdf.Root.get("/OutputIntents")
        has_oi = isinstance(oi, pikepdf.Array) and len(oi) >= 1
        oi_embedded = bool(has_oi and "/DestOutputProfile" in oi[0])
        add(has_oi and oi_embedded, "OutputIntent mit eingebettetem ICC-Profil")

        gts = str(pdf.docinfo.get("/GTS_PDFXVersion", ""))
        add(gts == "PDF/X-4", "GTS_PDFXVersion = PDF/X-4", gts)

        pages_no_trim = [i + 1 for i, p in enumerate(pdf.pages) if "/TrimBox" not in p]
        add(not pages_no_trim, "TrimBox auf jeder Seite",
            "" if not pages_no_trim else f"fehlt auf Seite {pages_no_trim[:5]}")

        unembedded = _find_non_embedded_fonts(pdf)
        add(not unembedded, "Alle Schriften eingebettet",
            "" if not unembedded else ", ".join(unembedded))

        pages_annots = [i + 1 for i, p in enumerate(pdf.pages) if "/Annots" in p]
        add(not pages_annots, "Keine Annotationen im Druckbereich",
            "" if not pages_annots else f"Seite {pages_annots[:5]}")

        bad_interactive = [k for k in ("/OpenAction", "/AcroForm", "/Names")
                           if Name(k) in pdf.Root]
        add(not bad_interactive, "Keine Aktionen/Formulare/JavaScript",
            "" if not bad_interactive else ", ".join(bad_interactive))

    passed = all(c["ok"] for c in checks)
    return {"passed": passed, "checks": checks}


# --------------------------------------------------------------------------- #
# Öffentliche API
# --------------------------------------------------------------------------- #
def convert(
    input_pdf: Path,
    output_pdf: Path,
    *,
    title: str = "Buch",
    author: str = "",
    output_condition_identifier: str = "FOGRA39",
    rendering_intent: str = "relative",   # "relative" | "perceptual"
    width_mm: float = 148.0,
    height_mm: float = 210.0,
    bleed_mm: float = 0.0,
    crop_marks: bool = False,
) -> dict:
    """Konvertiert ein sRGB-Druck-PDF nach PDF/X-4 und liefert einen Preflight-Report."""
    if output_condition_identifier not in OUTPUT_CONDITIONS:
        raise ValueError(f"Unbekannte Ausgabebedingung: {output_condition_identifier}")
    cond, icc_name = OUTPUT_CONDITIONS[output_condition_identifier]
    icc = ASSETS_DIR / icc_name
    if not icc.exists():
        raise FileNotFoundError(f"ICC-Profil fehlt: {icc}")
    intent = 0 if rendering_intent == "perceptual" else 1

    with tempfile.TemporaryDirectory() as td:
        workdir = Path(td)
        src_local = workdir / "in.pdf"
        src_local.write_bytes(input_pdf.read_bytes())
        gs_out = workdir / "cmyk.pdf"
        _run_ghostscript(src_local, icc, cond, output_condition_identifier,
                         intent, gs_out, workdir)
        _finalize(gs_out, output_pdf, title, author,
                  width_mm, height_mm, bleed_mm, crop_marks)

    return preflight(output_pdf)


if __name__ == "__main__":
    import argparse, json, sys

    ap = argparse.ArgumentParser(description="pdf2x4 CLI (Test/Batch)")
    ap.add_argument("input"); ap.add_argument("output")
    ap.add_argument("--title", default="Buch"); ap.add_argument("--author", default="")
    ap.add_argument("--condition", default="FOGRA39", choices=list(OUTPUT_CONDITIONS))
    ap.add_argument("--intent", default="relative", choices=["relative", "perceptual"])
    ap.add_argument("--width-mm", type=float, default=148.0)
    ap.add_argument("--height-mm", type=float, default=210.0)
    ap.add_argument("--bleed-mm", type=float, default=0.0)
    ap.add_argument("--crop-marks", action="store_true")
    a = ap.parse_args()

    report = convert(
        Path(a.input), Path(a.output), title=a.title, author=a.author,
        output_condition_identifier=a.condition, rendering_intent=a.intent,
        width_mm=a.width_mm, height_mm=a.height_mm, bleed_mm=a.bleed_mm,
        crop_marks=a.crop_marks,
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    sys.exit(0 if report["passed"] else 1)
