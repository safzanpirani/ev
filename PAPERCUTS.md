# PAPERCUTS

Small, non-blocking frictions encountered by agents while working. Review this file periodically and sand them down.

## 73e9c6 · 2026-10-27T17:27:41.626Z — claude-code — unknown-model

- **Directory:** `/Users/safzan/.wt/ev-1104/pc-ev`
- **About:** `ev`
- **Tags:** `bug`

ev index/du on Linux: walk() runs find -xdev per mount, so a nested btrfs subvolume that is not its own mount (/srv/strata on omarchy, 81G) is never counted and du shows /srv as 0B; root-only trees (/var/lib/containerd 53G, /.snapshots) are also missing because the walk runs unprivileged. Split from 58be5a.

