import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import type { Journal } from "./link.ts";

/** Reserve the requested path before any link operation; never overwrite a journal. */
export function createJournalWriter(path: string): (journal: Journal) => void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ version: 1, created: new Date().toISOString(), entries: [] }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return (journal) => {
    const temporary = `${path}.tmp-${crypto.randomUUID()}`;
    const next = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(next, JSON.stringify(journal, null, 2));
        fsyncSync(next);
      } finally {
        closeSync(next);
      }
      renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); } catch { /* renamed or unavailable */ }
    }
  };
}
