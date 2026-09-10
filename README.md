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

## Architecture

```
cli.ts      parse, call, render, exit
core.ts     actions — never prints
query.ts    pure: ergonomic flags in, es.exe argv out
render.ts   pure: data in, string out
es.ts       the one file that owns es.exe
config.ts   optional; defaults are correct on main
```

Every action takes an injectable runner, so the tests drive a fake `es.exe` and
assert on real values without a mocking library.

## Two things that will bite you in `es.exe`

Both are pinned as tests, because prose cannot fail and a test can.

**Instance names, not sessions.** A bare `es.exe` run over SSH fails with
`Error 8: Everything IPC not found` even while Everything is running. Everything
1.5a registers under the IPC instance name `1.5a` rather than the unnamed
default. Every call here passes `-instance`.

**Search terms must be separate argv tokens.** ES joins multiple non-switch
arguments into one search, but a single argument containing spaces is treated as
one literal phrase. `es -get-result-count "ext:mkv size:>1gb"` matched 0 files;
the same two terms as separate arguments matched 578.

## Behaviour worth knowing

- **stdout is data, stderr is diagnostics.** The trailing summary line goes to
  stderr so `ev find … > out.txt` stays clean. `-q` silences it.
- **Totals are always true.** A capped listing still reports the real match count
  and total size, so a caller never mistakes the first 50 rows for the whole set.
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
