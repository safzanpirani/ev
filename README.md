# ev

File search and disk-usage measurement over [Everything](https://www.voidtools.com)'s
live index on `main`. Built for agents: structured output, bounded result sets,
honest totals, error messages that name the fix.

```
$ ev du 'F:\'
    736G  / SteamLibrary
    218G  / Games
    143G  / Downloads
   68.4G  / anewbeginning
   68.1G  / specprojects
-- F:\: 1.43T total (1.43T in folders, 54.0M in loose files).
```

That answer comes from the index, not a filesystem walk. Everything 1.5a indexes
folder sizes, so a rollup over 9.8M indexed items returns in milliseconds.

## Install

`ev` runs on main and is invoked through Fleet:

```bash
fleet exec main "ev du 'F:\'"
```

To rebuild and deploy:

```bash
bun install
bun run check                # typecheck + tests
bun run build:windows        # dist/ev.exe
fleet cp dist/ev.exe main:'C:\Users\Admin\.local\bin\ev.exe'
```

`C:\Users\Admin\.local\bin` sits on main's live session PATH. `C:\Tools\ev` would
not: Windows caches the machine environment block in `services.exe` at boot, so a
machine-PATH edit does not reach SSH sessions until main reboots.

Requires voidtools' `es.exe` on main (defaults to `C:\Tools\es\es.exe`) and
Everything running.

## Reclaiming space with hard links

`ev link` replaces verified duplicates with hard links. It is a dry run unless
you pass `--yes`.

```
$ ev link --ext onnx --larger 100M
    548M  4 links @ 137M
          keep  F:\anewbeginning\Rope-Pearl\models\w600k_r50.onnx
          link  F:\textgen\Deep-Live-Cam-cuda\tmp\.insightface\models\buffalo_l\w600k_r50.onnx
          ...
-- 7 groups, 2.16G reclaimable, 3.44G hashed.
-- skipped: 62 cross-volume
-- DRY RUN. Nothing changed. Re-run with --yes to apply.
```

What it guarantees:

- **Content is hashed before anything is replaced.** Everything's index matches
  on name and size, which is not grounds for touching a file. Two files with the
  same name and size but different bytes are left alone.
- **Hard links cannot cross volumes**, so each group is partitioned by volume
  and cross-volume copies are reported, never silently dropped.
- **Replacement is atomic.** Each duplicate is linked to a temporary name and
  then renamed over the original, so an interruption leaves either the original
  or the link — never a missing file.
- **Apply reserves an undo journal before replacing files.** Each intended
  replacement is flushed to the journal before its rename. Existing journals
  are never overwritten. After an interruption, a journal may include a pending
  entry; undo checks the actual file identity and contents before restoring it.
- **Changed files are preserved.** Apply rechecks full hashes and file identities.
  Undo refuses paths that no longer share the recorded contents and restores an
  independent copy of each verified link. Stop writers before deduplicating:
  these checks do not lock out concurrent applications.
- **Re-running plans nothing.** Files already sharing an inode are reported as
  already-linked.
- **ReadOnly targets are handled.** Windows refuses to rename over a read-only
  file. Since the bytes are already verified identical, the attribute is cleared
  and the rename retried.

What it refuses to link, because a hard link is only safe when tools *replace* a
file rather than *modify it in place*: databases, VM disks, logs, lock files,
Windows system directories, and `.git` internals.

The tradeoff to understand: deduplication removes redundancy. After linking, one
bad sector takes out every path that shared those bytes rather than one copy.
Weigh that on removable enclosures.

## Architecture

```
cli.ts      parse, call, render, exit
core.ts     search and aggregation actions — never prints
link.ts     plan / apply / undo for hard-link dedupe
query.ts    pure: ergonomic flags in, es.exe argv out
render.ts   pure: data in, string out
es.ts       the one file that owns es.exe
fsdeps.ts   the one file that owns the filesystem
config.ts   optional; defaults are correct on main
```

Every action takes an injectable runner, so the tests drive a fake `es.exe` and
assert on real values without a mocking library.

`--quick` swaps the full hash for a 1 MB head+tail sample. It is much faster and
it is a heuristic. It is available only for dry runs; `--quick --yes` is rejected.

## Two things that will bite you in `es.exe`

Both are pinned as tests, because prose cannot fail and a test can.

**Instance names, not sessions.** A bare `es.exe` run over SSH fails with
`Error 8: Everything IPC not found` even while Everything is running. Everything
1.5a registers under the IPC instance name `1.5a` rather than the unnamed
default. Every call here passes `-instance`, and falls back through the other
known names on Error 8 so an Everything upgrade does not break every command.
`ev doctor` reports which instance actually answered.

**Search terms must be separate argv tokens.** ES joins multiple non-switch
arguments into one search, but a single argument containing spaces is treated as
one literal phrase. `es -get-result-count "ext:mkv size:>1gb"` matched 0 files;
the same two terms as separate arguments matched 578.

## Behaviour worth knowing

- **stdout is data, stderr is diagnostics.** The trailing summary line goes to
  stderr so `ev find … > out.txt` stays clean. `-q` silences it.
- **Totals are always true.** A capped listing still reports the real match count
  and total size, so a caller never mistakes the first 50 rows for the whole set.
  `du` totals include all indexed files regardless of `-n` or depth. If Everything
  reports an unknown size, search/size return `null` in JSON and an explicit
  unavailable-size message in text instead of displaying the sentinel as bytes.
- **`ext` and `dupes` aggregate over a bounded set** (`--cap`, default 50000) and
  say in their footer whether the answer was complete or sampled.
- **`dupes` matches name and byte size, not content.** It returns candidates.
  Hash before deleting.
- **Everything indexes names and metadata, never file contents.** Content search
  is ripgrep's job.

## Configuration

None required. Override with `$EV_ES_PATH`, `$EV_INSTANCE`, or
`~/.config/ev/config.json`:

```json
{ "esPath": "C:\\Tools\\es\\es.exe", "instance": "1.5a", "limit": 50 }
```

`ev --help` is the source of truth for flags.
