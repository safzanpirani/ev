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

## Linux

No open-source Linux tool pairs Everything-style instant name search with a
command line, live folder sizes and machine-readable output, so on Linux `ev`
composes two standard pieces: [plocate](https://plocate.sesse.net/) names the
matches from a database `ev` builds for itself, and `lstat` supplies each match's
size, dates and file identity at query time.

```bash
sudo pacman -S plocate                       # plocate + its updatedb
bun run build:linux && install -m755 dist/ev-linux-x64 ~/.local/bin/ev
ev index                                     # first build reads every disk
install -Dm644 deploy/linux/ev-index.{service,timer} -t ~/.config/systemd/user/
systemctl --user enable --now ev-index.timer # hourly refresh
ev doctor
```

- **Names come from `ev`'s own database** (`~/.local/share/ev/plocate.db`, or
  `$EV_LOCATE_DB`). `updatedb -l 0` builds it without root. Its prune list drops
  kernel views, tmpfs, network and cloud mounts, and keeps every real disk,
  including NTFS through `ntfs3` or `ntfs-3g`, which the stock
  `/etc/updatedb.conf` leaves out (it prunes all of `/mnt`). `ev` reads `/proc/self/mountinfo` to decide
  the rest: btrfs subvolumes such as `/home` stay in although updatedb's own
  bind-mount check drops them, real bind mounts are pruned so nothing is listed
  twice, and a systemd automount with nothing mounted is pruned, because
  entering it waits out the 90 s device timeout.
- **Folder sizes come from a cache** (`~/.local/share/ev/sizes.db`, or
  `$EV_SIZES_DB`). An `lstat` through `ntfs-3g` costs about 38 µs, so adding up a
  4M-entry NTFS drive at query time took 77 s. `ev index` therefore also walks
  each mount once with `find -printf` and stores every folder's total in SQLite.
  `du` reads folder totals from it and stats only the loose files of the folders
  it shows. A folder the cache does not know is added up at query time.
- **Names and folder totals are as fresh as the last `ev index`; file sizes and
  dates are current.** A listing says when matched entries no longer exist and
  when the index is more than two hours old.
- **Every verb works.** `big`, `ext` and `dupes` stat their matches at query time
  (`--cap`, default 2,000,000 entries), so narrow them with `--larger` or `--ext`
  on large NTFS drives. Hard links count once. `dupes` folds hard links, `link`
  uses the same verified planner as on main with Linux system trees (`/usr`,
  `/etc`, `/boot`, `/var/lib`, btrfs `/.snapshots`, and so on) refused, and
  `--grep` reads the files the index names.
- **Query words** are substrings or globs matched against names (`--match-path`
  for the whole path), ignoring case unless `--case`; `!word` excludes. Everything
  syntax words such as `size:` or `dm:` are refused with the flags that replace
  them.

## macOS

On the Mac, `ev` answers from [fsearch](https://github.com/noahdunnagan/fsearch)'s
index instead of Everything. The backend follows the platform (`$EV_BACKEND=es|fsearch|locate`
overrides it), and the verbs, flags, row shape and `--json` shape stay the same.

```bash
cd ~/Development/vendor/fsearch && cargo build --release && ./target/release/fsearch install   # ~/.local/bin/fsearch
cd ~/Development/ev && bun install && bun link                                                   # ~/.bun/bin/ev
ev doctor
```

The first `ev` call starts the fsearch daemon. Its first run lists the whole disk
(4.0M entries in 17 s here), then follows FSEvents. The index lives in
`~/Library/Application Support/FSearch` (about 1.3 GB with the content index).

**Full Disk Access.** Without it, the daemon skips Desktop, Documents, Downloads,
iCloud Drive, `~/Library/Containers` and `/Volumes` rather than trigger privacy
prompts. `ev doctor` lists what is missing. To fix it, grant Full Disk Access to the
terminal app that starts the daemon (or run `fsearch install --login` and grant it to
`~/.local/bin/fsearch`, again after each rebuild), then `pkill -f 'fsearch serve'`.
The next call restarts it and rescans the skipped folders.

| Verb | On macOS |
|---|---|
| `find`, `recent`, `big`, `count`, `size`, `ext`, `raw`, `doctor` | work |
| `find --grep <text>`, `--grep-regex <re>` | content search from fsearch's content index (main reads candidate files instead) |
| `find grep:…`, `regex:…`, `sym:…` | content search words, macOS only |
| `du` | refuses: fsearch has no folder-size rollups. Use `sweep dust <dir>` |
| `dupes` | refuses: APFS clones look like duplicates but share blocks |
| `link` | shows saved plans and undoes; refuses to plan or apply |

What differs from Everything:

- **Query words are fsearch syntax.** They are fuzzy and typo-tolerant (`mian.rs`
  finds `main.rs`), and accept `'exact`, `^prefix`, `suffix$`, `!exclude` and
  fsearch filters. `find` without `--sort` keeps fsearch's relevance ranking.
- **Totals are counted up to a cap.** fsearch has no count query, so `find` fetches
  up to 10,000 matches (`count` and `size` use `--cap`, default 100,000). Past the
  cap, the total is a floor (`totalExact: false` / `atLeast: true`) and the size is
  unknown; `size` refuses rather than print part of a sum.
- **Largest and newest are still exact.** `big`, `recent` and `--sort size|modified`
  narrow a size or age threshold until the matches above it fit in one fetch.
  `--sort name|path|extension` and `--asc` need every match and refuse past the cap.
- **Unsupported flags fail by name:** `--case`, `--whole-word`, `--sort created`,
  `--match-path` without `--regex`, and `--under` with `--parent`.
- Folder rows carry no size. Dates are converted to ages, since fsearch filters by
  age: `--after` takes `2026-01-01`, `2026-01-01T09:30`, `today`, `yesterday`, `7d`, `12h`.
- Content search is smart-case and covers text files. Its index leaves out
  `node_modules`, `Library`, `vendor`, build output and caches, so an unscoped
  `--grep` misses them; scope it with `--under` into such a folder and fsearch
  scans disk instead.
  Native `grep:`, `regex:` and `sym:` words (including `content:` and `symbol:`
  aliases) use the same content result and `--json` shape as `--grep`, including
  line matches, `-n`, `--offset` and `-q`. For example,
  `ev find sym:apply_dir --ext rs` or `ev find "grep:pub fn" --under ~/Development`.
  Fsearch interprets the native pattern and mode; an explicit `--grep` or
  `--grep-regex` takes precedence. Content queries require `find`, and `--sort`
  is unsupported, just as with the content flags.

## Content search on main

Everything does not index file contents. `ev find --grep <text>` (or
`--grep-regex <re>`) asks the index for candidate files and then reads them, so
every name filter narrows the read set before any file is opened:

```
$ ev find --grep effort --under 'C:\Strata-data' -n 3
C:\Strata-data\packs\iq3_s\tokenizer\chat_template.jinja:59: {%- set resolved_reasoning_effort = ...
...
-- 3 files with matches; read 96 of 96 candidate files (under 10M) named by the Everything index.
-- 24 binary or UTF-16 files were skipped.
```

- Candidates are files under 10 MB in path order, at most `--cap` (default
  5000). Matching ignores case unless `--case` is given.
- Files under `node_modules`, `.git`, `site-packages`, `__pycache__`, `venv` and
  `.venv` are excluded in the index query, so they never use up the cap.
  `--all-dirs` reads them.
- Files with a NUL byte in their first 8000 bytes are treated as binary and
  skipped. That includes UTF-16 text, which Windows writes for some logs.
- `-n` counts files with matches. Reading stops once that many matched, and the
  footer says the answer is partial. `--paths` prints only the matching files.
- Without `--under` or name filters the candidates are the first 5000 files on
  the machine by path; the footer reports when the cap cut the list.

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
  already-linked, and each inode is hashed once, so an already-linked tree costs
  no extra reads.
- **ReadOnly targets are handled.** Windows refuses to rename over a read-only
  file. Since the bytes are already verified identical, the attribute is cleared
  and the rename retried.

Mirrors between two trees take several `--under` roots. `--keep` names a tree
whose files are never replaced; they become the keepers, so another application
reading that tree sees the same inode, timestamps and bytes as before. Save the
verified plan, review it, then apply exactly that plan:

```
$ ev link --under 'D:\Downloads\n' --under 'D:\Media' --keep 'D:\Downloads\n' --save-plan plan.json
$ ev link --plan plan.json            # show it again
$ ev link --plan plan.json --yes      # apply it; every file is re-verified first
```

Planning and applying print a progress line to stderr every few seconds, with
elapsed time and a byte-based estimate of the time left, so a long run can go
into a detached job and its log shows how far it got and when it should end.

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
grep.ts     content search: the index names candidates, ev reads them
maccli.ts   macOS frontend: the same verbs, answered by fsearch
mac.ts      macOS actions: find, count, size, ext, grep, doctor — never prints
fsquery.ts  pure: QuerySpec in, fsearch query out; unsupported flags fail here
fsearch.ts  the one file that owns fsearch (socket, daemon start, reply parsing)
macrender.ts pure: macOS results in, string out
linuxcli.ts Linux frontend: the same verbs, answered by plocate and lstat
linux.ts    Linux actions: collect, rollups, dupes, grep — never prints
locate.ts   the one file that owns plocate and updatedb
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
the same two terms as separate arguments matched 578. A token that carries its
own quote characters also matches nothing, because the Windows command line
escapes those quotes as `\"` before ES reads them.

`ev` splits each query argument on whitespace, so `ev find "walking dead"` and
`ev find walking dead` both search for two words that must each appear in the
name, as Everything's search box does. A double-quoted run inside an argument,
as in `ev find '"red dead" ext:exe'`, stays one phrase and is passed without its
quotes, which ES reads as a phrase. Dates follow the same rule:
`--after "2026-10-23 10:00"` becomes `dm:>=2026-10-23T10:00`.

## Behaviour worth knowing

- **The summary line follows the rows on stdout.** Several `ev` calls batched
  into one `fleet exec` then keep each footer under its own rows; on stderr the
  footers all arrived after the last command. `--paths` prints bare paths for
  piping and moves the summary to stderr. `-q` drops it.
- **A missing folder is an error.** `ev du`, `ev big`, `ev ext`, `--under`,
  `--parent` and `--keep` refuse a path that does not exist, where Everything
  would answer 0B and 0 matches. A bare drive letter such as `C:` means the
  drive root; Windows would read it as the current folder on that drive.
- **Common flag guesses work.** `--limit` is `-n`, `--name=value` equals
  `--name value`, and an unknown flag names the one you probably meant
  (`--size` points at `--larger`, `--smaller` and `ev size`).
- **Totals are always true.** A capped listing still reports the real match count
  and total size, so a caller never mistakes the first 50 rows for the whole set.
  `du` totals include all indexed files regardless of `-n` or depth. If Everything
  reports an unknown size, search/size return `null` in JSON and an explicit
  unavailable-size message in text instead of displaying the sentinel as bytes.
- **`ext` and `dupes` aggregate over a bounded set** (`--cap`, default 50000) and
  say in their footer whether the answer was complete or sampled.
- **`dupes` matches name and byte size, not content.** It returns candidates.
  Hash before deleting.
- **`dupes` folds existing hard links.** The index sees names, not inodes, so a
  library built from hard links looks like a full copy. `dupes` stats each
  candidate and counts paths that share an inode once, reporting that shared
  space on its own footer line. `--index-only` skips the stat.
- **An empty result set has zero bytes.** ES reports the unknown-size sentinel
  for an empty set as well as for a genuinely unknown size. `du` over a folder
  with no loose files, and `size` over no matches, report 0.
- **Everything indexes names and metadata, never file contents.** `ev find --grep`
  on main bridges that: see [Content search on main](#content-search-on-main).
- **`du --depth 2` and deeper show the largest 12 entries per folder** and leave
  folders under 2% of their parent closed, because each expanded folder costs a
  query. The footer says so; `-n` raises the per-folder count.
- **`--regex` keeps the query whole.** A pattern such as `red dead|walking dead`
  is one token; splitting it into words would AND its pieces.

## Configuration

None required. Override with `$EV_ES_PATH`, `$EV_INSTANCE`, or
`~/.config/ev/config.json`:

```json
{ "esPath": "C:\\Tools\\es\\es.exe", "instance": "1.5a", "limit": 50 }
```

`ev --help` is the source of truth for flags.
