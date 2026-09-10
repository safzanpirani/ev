// Pure rendering: data in, string out. No IO, no colour decisions of its own.

import type { EsRow } from "./es.ts";
import type { DuResult, ExtEntry, DupeGroup, FindResult, DoctorReport } from "./core.ts";

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return "?";
  const units = ["B", "K", "M", "G", "T", "P"];
  let n = Math.abs(bytes);
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  const s = u === 0 ? String(Math.round(n)) : n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
  return `${bytes < 0 ? "-" : ""}${s}${units[u]}`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

export function renderFind(r: FindResult, opts: { showDate?: boolean } = {}): string {
  const lines: string[] = [];
  for (const row of r.rows) {
    const size = row.size === undefined ? "" : pad(humanSize(row.size), 8);
    const date = opts.showDate && row.date_modified ? `  ${row.date_modified}` : "";
    lines.push(`${size}${date}  ${row.filename}`);
  }
  lines.push(summaryLine(r));
  return lines.join("\n");
}

export function summaryLine(r: FindResult): string {
  const scale = `${r.total.toLocaleString()} match${r.total === 1 ? "" : "es"}, ${humanSize(r.totalSize)} total`;
  return r.truncated ? `-- ${scale}; showing ${r.shown}. Raise with -n, page with --offset.` : `-- ${scale}.`;
}

export function renderDu(d: DuResult): string {
  const lines: string[] = [];
  for (const e of d.entries) {
    const marker = e.kind === "folder" ? "/" : " ";
    lines.push(`${pad(humanSize(e.size), 8)}  ${marker} ${e.name}`);
  }
  lines.push(
    `-- ${d.root}: ${humanSize(d.grandTotal)} total (${humanSize(d.folderTotal)} in folders, ${humanSize(d.fileTotal)} in loose files).`,
  );
  return lines.join("\n");
}

export function renderExt(r: { entries: ExtEntry[]; scanned: number; total: number; sampled: boolean }, limit: number): string {
  const lines: string[] = [];
  for (const e of r.entries.slice(0, limit)) {
    lines.push(`${pad(humanSize(e.size), 8)}  ${pad(e.count.toLocaleString(), 9)}  .${e.ext}`);
  }
  lines.push(
    r.sampled
      ? `-- grouped the ${r.scanned.toLocaleString()} largest of ${r.total.toLocaleString()} files; smaller files are not counted. Raise with --cap.`
      : `-- grouped all ${r.scanned.toLocaleString()} files.`,
  );
  return lines.join("\n");
}

export function renderDupes(r: { groups: DupeGroup[]; scanned: number; wastedTotal: number }, limit: number): string {
  const lines: string[] = [];
  for (const g of r.groups.slice(0, limit)) {
    lines.push(`${pad(humanSize(g.wasted), 8)}  ${g.paths.length}x ${humanSize(g.size)}  ${g.name}`);
    for (const p of g.paths) lines.push(`              ${p}`);
  }
  lines.push(
    `-- ${r.groups.length.toLocaleString()} candidate group${r.groups.length === 1 ? "" : "s"} across ${r.scanned.toLocaleString()} files, ${humanSize(r.wastedTotal)} reclaimable.`,
  );
  lines.push("-- Matched on name and byte size, not content. Hash before deleting.");
  return lines.join("\n");
}

export function renderRows(rows: EsRow[]): string {
  return rows.map((r) => r.filename).join("\n");
}

export function renderDoctor(d: DoctorReport): string {
  if (!d.ok) {
    return [`ev: cannot reach Everything`, `  es.exe:   ${d.exe}`, `  instance: ${d.instance}`, `  ${d.error ?? "unknown error"}`].join("\n");
  }
  return [
    `ev: ok`,
    `  es.exe:   ${d.exe}`,
    `  instance: ${d.instance}`,
    d.everythingVersion ? `  Everything: ${d.everythingVersion}` : `  Everything: (version not reported)`,
    `  indexed:  ${(d.indexedFiles ?? 0).toLocaleString()} items`,
  ].join("\n");
}
