import { convertToPdfX4, type ConvertSettings, type PreflightReport } from "./convert";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;

// --- Theme (hell/dunkel) ---
const root = document.documentElement;
function applyTheme(t: "dark" | "light") {
  root.setAttribute("data-theme", t);
  localStorage.setItem("pdf2x4-theme", t);
  $("#themeIcon").textContent = t === "dark" ? "🌙" : "☀️";
  $("#themeLabel").textContent = t === "dark" ? "Dunkel" : "Hell";
}
const saved = localStorage.getItem("pdf2x4-theme") as "dark" | "light" | null;
applyTheme(saved ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
$("#themeBtn").addEventListener("click", () =>
  applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark"));

// --- Datei (lokal, KEIN Upload) ---
const fileInput = $<HTMLInputElement>("#fileInput");
const go = $<HTMLButtonElement>("#go");
let chosen: File | null = null;

function setFile(f: File | undefined | null) {
  if (!f) return;
  if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") { alert("Bitte eine PDF-Datei wählen."); return; }
  chosen = f;
  $("#fileName").textContent = `✓ ${f.name}  (${(f.size / 1048576).toFixed(1)} MB)`;
  go.disabled = false;
  $("#status").innerHTML = "";
  if (!$<HTMLInputElement>("#title").value) $<HTMLInputElement>("#title").value = f.name.replace(/\.pdf$/i, "");
}
const drop = $("#drop");
drop.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => setFile((e.target as HTMLInputElement).files?.[0]));
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => setFile((e as DragEvent).dataTransfer?.files?.[0]));

// --- Trim-Felder nur bei Anschnitt > 0 ---
const bleed = $<HTMLInputElement>("#bleed"), width = $<HTMLInputElement>("#width"), height = $<HTMLInputElement>("#height");
function syncTrim() { const on = parseFloat(bleed.value) > 0; width.disabled = !on; height.disabled = !on; }
bleed.addEventListener("input", syncTrim); syncTrim();

// --- Einstellungs-JSON aus md2bookpdf laden ---
$<HTMLInputElement>("#jsonInput").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    if (s.meta?.title != null) $<HTMLInputElement>("#title").value = s.meta.title;
    if (s.meta?.author != null) $<HTMLInputElement>("#author").value = s.meta.author;
    if (s.page?.bleedMm != null) bleed.value = String(s.page.bleedMm);
    if (s.page?.widthMm != null) width.value = String(s.page.widthMm);
    if (s.page?.heightMm != null) height.value = String(s.page.heightMm);
    if (s.page?.cropMarks != null) $<HTMLInputElement>("#crop").checked = !!s.page.cropMarks;
    const id = s.print?.outputConditionIdentifier;
    if (id) $<HTMLSelectElement>("#condition").value = String(id).toUpperCase().includes("47") ? "FOGRA47" : "FOGRA39";
    if (s.print?.renderingIntent) $<HTMLSelectElement>("#intent").value =
      String(s.print.renderingIntent).toLowerCase().startsWith("per") ? "perceptual" : "relative";
    syncTrim();
    $("#jsonInfo").textContent = "✓ Einstellungen übernommen";
    ($("#jsonInfo") as HTMLElement).style.color = "var(--ok)";
  } catch {
    $("#jsonInfo").textContent = "✗ JSON nicht lesbar";
    ($("#jsonInfo") as HTMLElement).style.color = "var(--bad)";
  }
});

// --- Formular -> ConvertSettings ---
function buildSettings(): ConvertSettings {
  const cond = $<HTMLSelectElement>("#condition").value;
  const fogra47 = cond === "FOGRA47";
  return {
    meta: { title: $<HTMLInputElement>("#title").value.trim() || "Buch", author: $<HTMLInputElement>("#author").value.trim() },
    page: {
      widthMm: parseFloat(width.value) || 148, heightMm: parseFloat(height.value) || 210,
      bleedMm: parseFloat(bleed.value) || 0, cropMarks: $<HTMLInputElement>("#crop").checked,
    },
    print: {
      pdfxVersion: "PDF/X-4",
      iccProfile: fogra47 ? "PSO_Uncoated_v3" : "ISOcoated_v2_300_eci",
      outputCondition: fogra47 ? "PSO Uncoated v3 (FOGRA47)" : "ISO Coated v2 (ECI)",
      outputConditionIdentifier: fogra47 ? "FOGRA47" : "FOGRA39",
      renderingIntent: $<HTMLSelectElement>("#intent").value === "perceptual" ? "Perceptual" : "RelativeColorimetric",
      keepLinks: false,
    },
  };
}

const esc = (s: string) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));

go.addEventListener("click", async () => {
  if (!chosen) return;
  go.disabled = true;
  $("#status").innerHTML = `<div style="display:flex;align-items:center;gap:12px;color:var(--mut)"><span class="spinner"></span> Wird im Browser umgewandelt … (beim ersten Mal lädt einmalig die Umwandlungs-Engine ~16 MB; große Bücher dauern bis ~1 Min)</div>`;
  try {
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    const { bytes: out, report } = await convertToPdfX4(bytes, buildSettings());
    const outName = chosen.name.replace(/\.pdf$/i, "") + ".X4.pdf";
    renderResult(out, outName, report);
  } catch (e) {
    $("#status").innerHTML = `<div class="err">${esc(String((e as Error)?.message || e))}</div>`;
    go.disabled = false;
  }
});

function renderResult(out: Uint8Array, name: string, rep: PreflightReport) {
  const url = URL.createObjectURL(new Blob([out as BlobPart], { type: "application/pdf" }));
  let html = `<div class="report ${rep.passed ? "passed" : "failed"}">`;
  html += `<h3>${rep.passed ? "✓ PDF/X-4 erstellt" : "⚠ Erstellt — bitte Hinweise prüfen"}</h3>`;
  for (const c of rep.checks)
    html += `<div class="check"><span class="ic ${c.ok ? "ok" : "no"}">${c.ok ? "✓" : "✕"}</span><span>${esc(c.label)}${c.detail ? ` <span class="det">— ${esc(c.detail)}</span>` : ""}</span></div>`;
  html += `<div style="margin-top:18px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <a class="btn" href="${url}" download="${esc(name)}">⬇ ${esc(name)} herunterladen</a>
      <button class="btn secondary" id="again">Weitere Datei</button></div>`;
  html += `<div class="hint" style="margin-top:10px">Größe: ${(out.byteLength / 1048576).toFixed(1)} MB · alles lokal erzeugt, nichts hochgeladen.</div></div>`;
  $("#status").innerHTML = html;
  $("#again").addEventListener("click", () => {
    chosen = null; $("#fileName").textContent = ""; fileInput.value = ""; $("#status").innerHTML = "";
    go.disabled = true; window.scrollTo({ top: 0, behavior: "smooth" });
  });
}
