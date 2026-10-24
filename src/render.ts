// Pure rendering: data in, string out. No IO, no colour decisions of its own.

import type { EsRow } from "./es.ts";
import type { DuResult, ExtEntry, FindResult, DoctorReport } from "./core.ts";

export function humanSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "?";
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

export function summaryLine(r: FindResult, unknownSize = "size unavailable from index"): string {
  const size = r.totalSize === null ? unknownSize : `${humanSize(r.totalSize)} total`;
  const scale = `${r.total.toLocaleString()} match${r.total === 1 ? "" : "es"}, ${size}`;
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

export function renderDuTree(t: import("./core.ts").DuTreeResult): string {
  const lines: string[] = [];
  const walk = (nodes: import("./core.ts").DuEntryTree[]) => {
    for (const n of nodes) {
      const indent = "  ".repeat(n.depth);
      const marker = n.kind === "folder" ? "/" : " ";
      lines.push(`${pad(humanSize(n.size), 8)}  ${indent}${marker} ${n.name}`);
      if (n.children) walk(n.children);
    }
  };
  walk(t.entries);
  lines.push(
    `-- ${t.root}: ${humanSize(t.grandTotal)} total, expanded ${t.depth} level${t.depth === 1 ? "" : "s"}` +
      ` (largest ${t.perLevel} per folder; folders under ${Math.round(t.minShare * 100)}% of their parent stay closed). Raise with -n.`,
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

export function renderDupes(r: import("./core.ts").DupesResult, limit: number): string {
  const lines: string[] = [];
  for (const g of r.groups.slice(0, limit)) {
    const linked = g.linked ? ` (${g.linked} already hard-linked)` : "";
    lines.push(`${pad(humanSize(g.wasted), 8)}  ${g.paths.length}x ${humanSize(g.size)}  ${g.name}${linked}`);
    for (const p of g.paths) lines.push(`              ${p}`);
  }
  lines.push(
    `-- ${r.groups.length.toLocaleString()} candidate group${r.groups.length === 1 ? "" : "s"} across ${r.scanned.toLocaleString()} files, ${humanSize(r.wastedTotal)} reclaimable.`,
  );
  if (r.linkedTotal) lines.push(`-- ${humanSize(r.linkedTotal)} more matches paths already hard-linked together; that space is already shared.`);
  lines.push("-- Matched on name and byte size, not content. Hash before deleting.");
  if (r.sampled) lines.push(`-- sampled the ${r.scanned.toLocaleString()} largest of ${r.total.toLocaleString()} files; smaller files are not counted. Raise with --cap.`);
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
    d.requested && d.requested !== d.instance
      ? `  instance: ${d.instance}  (configured ${JSON.stringify(d.requested)} did not answer — set $EV_INSTANCE)`
      : `  instance: ${d.instance}`,
    d.everythingVersion ? `  Everything: ${d.everythingVersion}` : `  Everything: (version not reported)`,
    `  indexed:  ${(d.indexedFiles ?? 0).toLocaleString()} items`,
  ].join("\n");
}

export function renderLinkPlan(
  plan: import("./link.ts").LinkPlan,
  limit: number,
  applied: boolean,
  applyHint = "Re-run with --yes to apply.",
): string {
  const lines: string[] = [];
  for (const g of plan.groups.slice(0, limit)) {
    lines.push(`${pad(humanSize(g.reclaim), 8)}  ${g.replace.length} link${g.replace.length === 1 ? "" : "s"} @ ${humanSize(g.size)}`);
    lines.push(`          keep  ${g.keeper}`);
    for (const p of g.replace) lines.push(`          link  ${p}`);
  }
  if (plan.groups.length > limit) lines.push(`          ... ${plan.groups.length - limit} more groups`);

  const counts = new Map<string, number>();
  for (const s of plan.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const skipSummary = [...counts.entries()].map(([r, n]) => `${n} ${r}`).join(", ");

  lines.push(
    `-- ${plan.groups.length} group${plan.groups.length === 1 ? "" : "s"}, ${humanSize(plan.reclaim)} reclaimable, ${humanSize(plan.hashedBytes)} hashed.`,
  );
  if (skipSummary) lines.push(`-- skipped: ${skipSummary}`);
  if (!applied) lines.push(`-- DRY RUN. Nothing changed. ${applyHint}`);
  return lines.join("\n");
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** One stderr line per progress event, for detached jobs whose log is the only view. */
export function renderProgress(p: import("./link.ts").Progress, elapsedMs?: number): string {
  const pct = p.totalBytes > 0 ? ` (${Math.floor((p.bytes / p.totalBytes) * 100)}%)` : "";
  const verb = p.phase === "hash" ? "hashed" : "linking";
  let time = "";
  if (elapsedMs !== undefined) {
    time = `, ${duration(elapsedMs)} elapsed`;
    // Bytes set the pace, not files: one 30G model outweighs a thousand configs.
    if (p.bytes > 0 && p.bytes < p.totalBytes) time += `, ~${duration((elapsedMs * (p.totalBytes - p.bytes)) / p.bytes)} left`;
  }
  return `-- ${verb} ${p.done}/${p.total} files, ${humanSize(p.bytes)}/${humanSize(p.totalBytes)}${pct}${time}  ${p.path}`;
}

export function renderApply(r: import("./link.ts").ApplyResult, journalPath: string): string {
  const lines = [
    `-- linked ${r.linked} file${r.linked === 1 ? "" : "s"}, reclaimed ${humanSize(r.reclaimed)}.`,
    `-- journal: ${journalPath}`,
    `-- undo with: ev link --undo "${journalPath}" --yes`,
  ];
  if (r.failures.length) {
    lines.unshift(...r.failures.map((f) => `FAILED  ${f.path}: ${f.error}`));
    lines.push(`-- ${r.failures.length} failure${r.failures.length === 1 ? "" : "s"}; those files were left untouched.`);
  }
  return lines.join("\n");
}
