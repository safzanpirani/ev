// Pure rendering for the macOS (fsearch) backend: data in, string out.

import { humanSize, renderFind, summaryLine } from "./render.ts";
import type { GrepResult, MacDoctorReport, MacExtResult, MacFindResult } from "./mac.ts";

/** The es summary line when the total is exact; otherwise say it is a floor, never a count. */
export function macSummaryLine(r: MacFindResult): string {
  if (r.totalExact) return summaryLine(r);
  return `-- more than ${r.total.toLocaleString()} matches (fsearch has no count; total size unknown); showing ${r.shown}. Raise with -n, page with --offset, or narrow the query.`;
}

/** Rows exactly as the es backend renders them, without its summary line. */
export function renderMacRows(r: MacFindResult, opts: { showDate?: boolean } = {}): string {
  return renderFind(r, opts).split("\n").slice(0, -1).join("\n");
}

export function renderMacExt(r: MacExtResult, limit: number): string {
  const pad = (s: string, w: number) => (s.length >= w ? s : " ".repeat(w - s.length) + s);
  const lines = r.entries.slice(0, limit).map((e) => `${pad(humanSize(e.size), 8)}  ${pad(e.count.toLocaleString(), 9)}  .${e.ext}`);
  lines.push(
    r.sampled
      ? `-- grouped the ${r.scanned.toLocaleString()} largest of more than ${r.total.toLocaleString()} files; smaller files are not counted. Raise with --cap.`
      : `-- grouped all ${r.scanned.toLocaleString()} files.`,
  );
  return lines.join("\n");
}

/** One `path:line: text` per match, like grep -n. */
export function renderGrepLines(r: Pick<GrepResult, "files">): string {
  const lines: string[] = [];
  for (const f of r.files) for (const m of f.matches) lines.push(`${f.path}:${m.line}: ${m.text.trim()}`);
  return lines.join("\n");
}

export function grepSummaryLine(r: GrepResult): string {
  const files = `${r.shown.toLocaleString()} file${r.shown === 1 ? "" : "s"} with matches`;
  const work = `read ${r.read.toLocaleString()} of ${r.candidates.toLocaleString()} candidate files ${r.source === "index" ? "via the content index" : "by scanning disk (outside the content index)"}`;
  const notes = [
    !r.complete ? "search stopped at its time budget, so more files may match" : "",
    r.indexing > 0 ? `${r.indexing.toLocaleString()} files still waiting for the content index` : "",
  ].filter(Boolean);
  return `-- ${files}; ${work}.${notes.length ? ` ${notes.join("; ")}.` : ""}`;
}

export function renderMacDoctor(d: MacDoctorReport): string {
  const ix = d.index;
  const lines = [
    d.ok ? "ev: ok (macOS, fsearch backend)" : "ev: fsearch is not ready (macOS, fsearch backend)",
    `  fsearch:  ${d.binary}${d.binaryExists ? "" : "  (missing)"}`,
    `  version:  not reported by fsearch (no --version)${d.binaryModified ? `; binary built ${d.binaryModified}` : ""}`,
    `  daemon:   ${d.daemonAnswering ? `answering on ${d.socket}` : `not answering on ${d.socket}`}${d.pid ? `  (pid ${d.pid}, ${humanSize(d.rssBytes ?? null)} resident)` : ""}`,
  ];
  if (ix.ready) {
    lines.push(
      `  indexed:  ${(ix.entries ?? 0).toLocaleString()} entries in ${(ix.dirs ?? 0).toLocaleString()} folders`,
      `  content:  ${(ix.contentDocs ?? 0).toLocaleString()} files${ix.contentPending ? `, ${ix.contentPending.toLocaleString()} pending` : ""}`,
    );
  } else if (ix.progress) {
    lines.push(`  indexing: ${ix.progress}`);
  }
  lines.push(`  on disk:  ${humanSize(ix.onDiskBytes)} in ${ix.dataDir}`);
  if (d.fullDiskAccess !== null) lines.push(`  full disk access: ${d.fullDiskAccess ? "yes" : "no"}`);
  if (d.skippedGated.length) lines.push(`  not indexed (consent-gated): ${d.skippedGated.join(", ")}`);
  if (d.skippedRefused) lines.push(`  not indexed (refused by macOS): ${d.skippedRefused.toLocaleString()} more folders`);
  for (const f of d.fixes) lines.push(`  fix: ${f}`);
  return lines.join("\n");
}
