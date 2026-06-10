// pdf2x4 — PDF/X-4-Erzeugung KOMPLETT IM BROWSER (GS-WASM + pdf-lib).
// Es wird nichts hochgeladen — die Datei verlässt den Browser nie.
//
// Pipeline:
//   1. Ghostscript-WASM: sRGB → DeviceCMYK, OutputIntent mit eingebettetem ICC,
//      alle Fonts einbetten (inkl. Standard-14), PDF 1.6, Link-Annots verwerfen.
//   2. pdf-lib: TrimBox/BleedBox je Seite, unkomprimiertes XMP mit
//      pdfxid:GTS_PDFXVersion, Dokument-Info — Autor/Titel in Info UND XMP
//      KONSISTENT (Adobe-Preflight: „Uneinheitliche Angaben zum Autor" vermeiden).
//
// AGPL-3.0: Ghostscript ist AGPL; pdf2x4 ist als Ganzes unter AGPL veröffentlicht
// (Footer-Quellcode-Link). Daher ist das Ausliefern von gs.wasm an den Browser ok.
import { PDFDocument, PDFName, PDFString, PDFRef, PDFDict, PDFArray } from "pdf-lib";

export interface ConvertSettings {
  meta: { title: string; author: string };
  page: { widthMm: number; heightMm: number; bleedMm: number; cropMarks: boolean };
  print: {
    pdfxVersion: "PDF/X-4" | "PDF/X-3";
    iccProfile: "ISOcoated_v2_300_eci" | "PSO_Uncoated_v3" | "custom";
    customIccDataUrl?: string;
    outputCondition: string;
    outputConditionIdentifier: string;
    renderingIntent: "Perceptual" | "RelativeColorimetric";
    keepLinks: boolean;
  };
}

export interface PreflightCheck { ok: boolean; label: string; detail?: string; }
export interface PreflightReport { passed: boolean; checks: PreflightCheck[]; }
export interface ConvertResult { bytes: Uint8Array; report: PreflightReport; }

const ICC_PROFILE_PATHS: Record<string, string> = {
  ISOcoated_v2_300_eci: "/assets/ISOcoated_v2_300_eci.icc",
  PSO_Uncoated_v3: "/assets/PSO_Uncoated_ISO12647_eci.icc",
  custom: "",
};
const PT_PER_MM = 72 / 25.4;
const mmToPt = (mm: number) => mm * PT_PER_MM;

async function loadIccProfile(s: ConvertSettings): Promise<Uint8Array> {
  if (s.print.iccProfile === "custom") {
    const d = s.print.customIccDataUrl;
    if (!d) throw new Error("Eigenes ICC-Profil gewählt, aber keine Datei hinterlegt.");
    const comma = d.indexOf(",");
    const bin = atob(d.slice(comma + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const url = ICC_PROFILE_PATHS[s.print.iccProfile];
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ICC-Profil nicht ladbar (HTTP ${r.status}): ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

function iccChannelCount(icc: Uint8Array): number {
  if (icc.length < 20) return 4;
  const sig = String.fromCharCode(icc[16], icc[17], icc[18], icc[19]);
  return ({ "GRAY": 1, "RGB ": 3, "Lab ": 3, "XYZ ": 3, "CMYK": 4 } as Record<string, number>)[sig] ?? 4;
}

function buildGsProlog(s: ConvertSettings, iccFileName: string, iccChannels: number): string {
  const ident = s.print.outputConditionIdentifier || "FOGRA39";
  const cond = s.print.outputCondition || "ISO Coated v2 (ECI)";
  const esc = (x: string) => x.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  return `%!
<< /EmbedAllFonts true /SubsetFonts true /MaxSubsetPct 100 /NeverEmbed [ ] >> setdistillerparams
[/_objdef {icc_PDFX} /type /stream /OBJ pdfmark
[{icc_PDFX} <</N ${iccChannels}>> /PUT pdfmark
[{icc_PDFX} (${iccFileName}) (r) file /PUT pdfmark
[/_objdef {OutputIntent_PDFX} /type /dict /OBJ pdfmark
[{OutputIntent_PDFX} <<
  /Type /OutputIntent
  /S /GTS_PDFX
  /OutputCondition (${esc(cond)})
  /OutputConditionIdentifier (${esc(ident)})
  /RegistryName (http://www.color.org)
  /DestOutputProfile {icc_PDFX}
>> /PUT pdfmark
[{Catalog} <</OutputIntents [ {OutputIntent_PDFX} ]>> /PUT pdfmark
`;
}

function uuid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const xmpDate = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "+00:00");
function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+00'00'`;
}
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildXmp(title: string, author: string, versionId: string, when: Date): string {
  const now = xmpDate(when);
  // Autor NUR ausgeben, wenn gesetzt — sonst muss auch /Author im Info-Dict fehlen
  // (sonst „Uneinheitliche Angaben zum Autor").
  const creator = author
    ? `\n   <dc:creator><rdf:Seq><rdf:li>${xmlEsc(author)}</rdf:li></rdf:Seq></dc:creator>`
    : "";
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="pdf2x4">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(title)}</rdf:li></rdf:Alt></dc:title>${creator}
   <xmp:CreatorTool>pdf2x4</xmp:CreatorTool>
   <xmp:CreateDate>${now}</xmp:CreateDate>
   <xmp:ModifyDate>${now}</xmp:ModifyDate>
   <xmp:MetadataDate>${now}</xmp:MetadataDate>
   <pdf:Producer>pdf2x4</pdf:Producer>
   <pdf:Trapped>False</pdf:Trapped>
   <xmpMM:DocumentID>uuid:${uuid()}</xmpMM:DocumentID>
   <xmpMM:InstanceID>uuid:${uuid()}</xmpMM:InstanceID>
   <xmpMM:RenditionClass>default</xmpMM:RenditionClass>
   <xmpMM:VersionID>1</xmpMM:VersionID>
   <pdfxid:GTS_PDFXVersion>${versionId}</pdfxid:GTS_PDFXVersion>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function descriptorHasFontFile(d: any): boolean {
  if (!(d instanceof PDFDict)) return false;
  return d.get(PDFName.of("FontFile")) != null || d.get(PDFName.of("FontFile2")) != null ||
    d.get(PDFName.of("FontFile3")) != null;
}
function findNonEmbeddedFonts(doc: PDFDocument): string[] {
  const bad = new Set<string>();
  const ctx = doc.context;
  const nameOf = (d: PDFDict) => {
    const bf = d.get(PDFName.of("BaseFont"));
    return bf instanceof PDFName ? bf.asString() : "(unbenannt)";
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const type = obj.get(PDFName.of("Type"));
    if (!(type instanceof PDFName) || type.asString() !== "/Font") continue;
    const st = obj.get(PDFName.of("Subtype")) instanceof PDFName
      ? (obj.get(PDFName.of("Subtype")) as PDFName).asString() : "";
    if (st === "/Type3") continue;
    if (st === "/Type0") {
      const desc = ctx.lookup(obj.get(PDFName.of("DescendantFonts")));
      const cid = desc instanceof PDFArray && desc.size() > 0 ? ctx.lookup(desc.get(0)) : null;
      const fd = cid instanceof PDFDict ? ctx.lookup(cid.get(PDFName.of("FontDescriptor"))) : null;
      if (!descriptorHasFontFile(fd)) bad.add(nameOf(obj));
    } else {
      const fd = ctx.lookup(obj.get(PDFName.of("FontDescriptor")));
      if (!descriptorHasFontFile(fd)) bad.add(nameOf(obj));
    }
  }
  return [...bad];
}

export async function finalizePdfX(gsPdf: Uint8Array, s: ConvertSettings): Promise<Uint8Array> {
  const isX4 = s.print.pdfxVersion === "PDF/X-4";
  const versionId = isX4 ? "PDF/X-4" : "PDF/X-3:2003";
  const title = s.meta.title || "Buch";
  const author = (s.meta.author || "").trim();

  const doc = await PDFDocument.load(gsPdf, { updateMetadata: false });

  const unembedded = findNonEmbeddedFonts(doc);
  if (unembedded.length > 0) {
    throw new Error("Ghostscript hat nicht alle Schriften eingebettet: " + unembedded.join(", ") +
      ".\nPrüfe, ob im Eingabe-PDF alle Fonts eingebettet wurden.");
  }

  const now = new Date();

  // --- Dokument-Info: Titel/Autor/Creator/Producer KONSISTENT zu XMP ---
  doc.setTitle(title);
  doc.setCreator("pdf2x4");
  doc.setProducer("pdf2x4");
  const info = doc.context.lookup(doc.context.trailerInfo.Info) as PDFDict | undefined;
  if (info) {
    // Autor: gesetzt → identisch zu XMP; leer → /Author komplett entfernen
    if (author) info.set(PDFName.of("Author"), PDFString.of(author));
    else info.delete(PDFName.of("Author"));
    info.set(PDFName.of("Trapped"), PDFName.of("False"));
    info.set(PDFName.of("GTS_PDFXVersion"), PDFString.of(versionId));
    info.set(PDFName.of("CreationDate"), PDFString.of(pdfDate(now)));
    info.set(PDFName.of("ModDate"), PDFString.of(pdfDate(now)));
  }

  // --- TrimBox + BleedBox je Seite ---
  const trimWpt = mmToPt(s.page.widthMm), trimHpt = mmToPt(s.page.heightMm);
  const bleedPt = mmToPt(s.page.bleedMm || 0);
  const bleedActive = (s.page.bleedMm || 0) > 0 || !!s.page.cropMarks;
  for (const page of doc.getPages()) {
    const mb = page.getMediaBox();
    if (!bleedActive) {
      page.setTrimBox(mb.x, mb.y, mb.width, mb.height);
      page.setBleedBox(mb.x, mb.y, mb.width, mb.height);
    } else {
      const ix = Math.max(0, (mb.width - trimWpt) / 2), iy = Math.max(0, (mb.height - trimHpt) / 2);
      page.setTrimBox(mb.x + ix, mb.y + iy, mb.width - 2 * ix, mb.height - 2 * iy);
      const bx = Math.max(0, ix - bleedPt), by = Math.max(0, iy - bleedPt);
      page.setBleedBox(mb.x + bx, mb.y + by, mb.width - 2 * bx, mb.height - 2 * by);
    }
  }

  // --- Unkomprimiertes XMP (überschreibt das von GS angelegte /Metadata-Objekt) ---
  const xmpBytes = new TextEncoder().encode(buildXmp(title, author, versionId, now));
  const metaStream = doc.context.stream(xmpBytes, { Type: "Metadata", Subtype: "XML" });
  const existing = doc.catalog.get(PDFName.of("Metadata"));
  if (existing instanceof PDFRef) doc.context.assign(existing, metaStream);
  else doc.catalog.set(PDFName.of("Metadata"), doc.context.register(metaStream));

  // --- Interaktivität entfernen ---
  for (const k of ["OpenAction", "AA", "Names", "AcroForm"]) doc.catalog.delete(PDFName.of(k));
  if (!s.print.keepLinks) {
    for (const page of doc.getPages()) {
      const annots = doc.context.lookup(page.node.get(PDFName.of("Annots")));
      if (annots instanceof PDFArray) {
        for (const e of annots.asArray()) if (e instanceof PDFRef) doc.context.delete(e);
      }
      page.node.delete(PDFName.of("Annots"));
      page.node.delete(PDFName.of("AA"));
    }
  }

  let bytes = await doc.save({ useObjectStreams: false });
  // Header-Version erzwingen (X-4 = 1.6, X-3 = 1.4)
  if (bytes[0] === 0x25 && bytes[5] === 0x31 && bytes[6] === 0x2e) {
    bytes[7] = isX4 ? 0x36 : 0x34;
  }
  return bytes;
}

// --- Preflight-Selbstcheck (inkl. Autor-Konsistenz Info ↔ XMP) ---
export async function preflight(bytes: Uint8Array): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  const add = (ok: boolean, label: string, detail = "") => checks.push({ ok, label, detail });
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;

  const verOk = bytes[0] === 0x25 && bytes[7] === 0x36;
  add(verOk, "PDF-Version 1.6");

  const oi = doc.catalog.get(PDFName.of("OutputIntents"));
  const oiArr = ctx.lookup(oi);
  const first = oiArr instanceof PDFArray && oiArr.size() > 0 ? ctx.lookup(oiArr.get(0)) : null;
  add(first instanceof PDFDict && first.get(PDFName.of("DestOutputProfile")) != null,
    "OutputIntent mit eingebettetem ICC-Profil");

  const info = ctx.lookup(ctx.trailerInfo.Info) as PDFDict | undefined;
  const gts = info?.get(PDFName.of("GTS_PDFXVersion"));
  add(gts instanceof PDFString && gts.asString().startsWith("PDF/X"),
    "GTS_PDFXVersion gesetzt", gts instanceof PDFString ? gts.asString() : "");

  const noTrim = doc.getPages().filter((p) => p.node.get(PDFName.of("TrimBox")) == null).length;
  add(noTrim === 0, "TrimBox auf jeder Seite", noTrim ? `${noTrim} Seite(n) ohne` : "");

  const unembedded = findNonEmbeddedFonts(doc);
  add(unembedded.length === 0, "Alle Schriften eingebettet", unembedded.join(", "));

  // Autor-Konsistenz: Info /Author muss exakt dem XMP dc:creator entsprechen
  let infoAuthor: string | null = null;
  const a = info?.get(PDFName.of("Author"));
  if (a instanceof PDFString) infoAuthor = a.asString();
  let xmpAuthor: string | null = null;
  const metaRef = doc.catalog.get(PDFName.of("Metadata"));
  const metaObj = ctx.lookup(metaRef);
  if (metaObj && (metaObj as any).getContents) {
    const xml = new TextDecoder().decode((metaObj as any).getContents());
    const m = xml.match(/<dc:creator>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/);
    xmpAuthor = m ? m[1] : null;
  }
  add((infoAuthor || "") === (xmpAuthor || ""),
    "Autor in Info und XMP konsistent",
    (infoAuthor || xmpAuthor) ? `Info: ${infoAuthor ?? "—"} / XMP: ${xmpAuthor ?? "—"}` : "kein Autor (ok)");

  const annots = doc.getPages().filter((p) => p.node.get(PDFName.of("Annots")) != null).length;
  add(annots === 0, "Keine Annotationen im Druckbereich", annots ? `${annots} Seite(n)` : "");

  const bad = ["OpenAction", "AcroForm", "Names"].filter((k) => doc.catalog.get(PDFName.of(k)) != null);
  add(bad.length === 0, "Keine Aktionen/Formulare/JavaScript", bad.join(", "));

  return { passed: checks.every((c) => c.ok), checks };
}

// --- Öffentliche API: alles im Browser, kein Upload ---
export async function convertToPdfX4(inputPdf: Uint8Array, s: ConvertSettings): Promise<ConvertResult> {
  const [gsModule, gsWasmUrl] = await Promise.all([
    import("@jspawn/ghostscript-wasm/gs.js"),
    import("@jspawn/ghostscript-wasm/gs.wasm?url"),
  ]);
  const initGs = (gsModule as any).default ?? (gsModule as any).Module;
  if (typeof initGs !== "function") throw new Error("Ghostscript-WASM-Modul nicht ladbar.");
  const gs = await initGs({
    locateFile: (p: string) => (p.endsWith(".wasm") ? (gsWasmUrl as any).default : p),
  });

  const iccBytes = await loadIccProfile(s);
  const iccFileName = s.print.iccProfile === "custom" ? "custom_output.icc" : s.print.iccProfile + ".icc";
  gs.FS.writeFile("in.pdf", inputPdf);
  gs.FS.writeFile(iccFileName, iccBytes);
  gs.FS.writeFile("PDFX_def.ps", buildGsProlog(s, iccFileName, iccChannelCount(iccBytes)));

  const renderIntent = s.print.renderingIntent === "Perceptual" ? 0 : 1;
  const compat = s.print.pdfxVersion === "PDF/X-4" ? "1.6" : "1.4";
  const args = [
    "-dBATCH", "-dNOPAUSE", "-dNOSAFER", "-sDEVICE=pdfwrite",
    `-dCompatibilityLevel=${compat}`, "-sColorConversionStrategy=CMYK",
    `-dRenderIntent=${renderIntent}`, "-dEmbedAllFonts=true", "-dSubsetFonts=true",
    `-dPreserveAnnots=${s.print.keepLinks ? "true" : "false"}`,
    "-sOutputFile=out.pdf", "PDFX_def.ps", "in.pdf",
  ];

  // GS-WASM bindet print/printErr an console — daher console um callMain patchen.
  const gsOut: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const cap = (o: (...a: any[]) => void) => (...a: any[]) => {
    try { gsOut.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" ")); } catch {}
    o.apply(console, a);
  };
  let exit: number | undefined;
  console.log = cap(orig.log); console.warn = cap(orig.warn); console.error = cap(orig.error);
  try { exit = gs.callMain(args); }
  finally { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; }

  let out: Uint8Array | null = null;
  if (exit === 0) { try { out = gs.FS.readFile("out.pdf"); } catch { out = null; } }
  if (exit !== 0 || !out || out.length === 0) {
    const log = gsOut.join("\n").trim();
    throw new Error(`Ghostscript-Konvertierung fehlgeschlagen (Exit ${exit ?? "?"}).` +
      (log ? `\n\n${log}` : "") + "\n\nTipp: Sind im Eingabe-PDF alle Fonts eingebettet?");
  }
  const gsResult = new Uint8Array(out);

  const bytes = await finalizePdfX(gsResult, s);
  const report = await preflight(bytes);
  return { bytes, report };
}
