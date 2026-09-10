import { test, expect, describe } from "bun:test";
import { makeClient, type Runner } from "../src/es.ts";
import { buildArgs, buildCountArgs, buildSearchTokens, parseSize } from "../src/query.ts";
import { find, du, duTree, byExtension, dupes, doctor } from "../src/core.ts";
import { humanSize } from "../src/render.ts";

/** A fake es.exe. Records argv, replays canned stdout — no mocking library. */
function fakeEs(responses: Array<{ match?: RegExp; stdout: string; code?: number }>) {
  const calls: string[][] = [];
  const run: Runner = async (_exe, args) => {
    calls.push(args);
    const joined = args.join(" ");
    const hit = responses.find((r) => !r.match || r.match.test(joined));
    const code = hit?.code ?? 0;
    return { ok: code === 0, stdout: hit?.stdout ?? "", stderr: "", code };
  };
  return { run, calls };
}

describe("parseSize", () => {
  test("accepts the forms an agent actually types", () => {
    expect(parseSize("500")).toBe(500);
    expect(parseSize("10K")).toBe(10240);
    expect(parseSize("1.5G")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseSize("2tb")).toBe(2 * 1024 ** 4);
  });
  test("rejects junk with a message naming the accepted forms", () => {
    expect(() => parseSize("big")).toThrow(/use forms like/);
  });
});

describe("query building", () => {
  test("ergonomic flags become Everything search syntax", () => {
    const s = buildSearchTokens({ terms: ["wukong"], ext: ["mkv", "mp4"], larger: 1024 });
    expect(s).toEqual(["wukong", "ext:mkv;mp4", "size:>=1024"]);
  });

  // Pinned from a real ES probe: "ext:mkv size:>1gb" as ONE argv token matched 0
  // files, while the same two terms as separate tokens matched 578.
  test("each search term is its own argv token, never one space-joined string", () => {
    const args = buildArgs({ terms: [], ext: ["mkv"], larger: 1024 ** 3 }, []);
    expect(args).toEqual(["ext:mkv", "size:>=1073741824"]);
    expect(args.some((a) => a.includes(" "))).toBe(false);
  });

  test("a multi-word user term stays one token, quoted as an Everything phrase", () => {
    expect(buildSearchTokens({ terms: ["black myth"] })).toEqual(['"black myth"']);
    expect(buildSearchTokens({ terms: ['"already quoted"'] })).toEqual(['"already quoted"']);
  });

  test("path and type filters are switches, not search terms", () => {
    // parent:/folder: as query terms silently return nothing; ES wants -parent and /ad.
    const args = buildArgs({ terms: [], parent: "F:\\", type: "folders", sort: "size", limit: 5 }, ["-size"]);
    expect(args).toEqual(["-parent", "F:\\", "/ad", "-sort", "size-descending", "-n", "5", "-size"]);
  });

  test("files-only uses /a-d", () => {
    expect(buildArgs({ terms: [], type: "files" }, [])).toContain("/a-d");
  });

  test("count args carry no -n and no columns, which -get-result-count rejects", () => {
    const args = buildCountArgs({ terms: ["x"], limit: 10, sort: "size", under: "F:\\" });
    expect(args).toEqual(["-path", "F:\\", "x"]);
    expect(args).not.toContain("-n");
  });

  test("terms and filters stay separate tokens", () => {
    const args = buildArgs({ terms: ["black myth"], ext: ["exe"] }, []);
    expect(args).toEqual(['"black myth"', "ext:exe"]);
  });

  test("ascending flips the sort direction", () => {
    expect(buildArgs({ terms: [], sort: "modified", ascending: true }, [])).toContain("date-modified-ascending");
  });
});

describe("es client", () => {
  test("errorlevel 8 explains the instance-name trap rather than echoing ENOENT", async () => {
    const { run } = fakeEs([{ stdout: "", code: 8 }]);
    const es = makeClient("es.exe", "1.5a", run);
    await expect(es.count([])).rejects.toThrow(/Everything IPC not found/);
  });

  test("errorlevel 9 means no results, not failure", async () => {
    const { run } = fakeEs([{ stdout: "", code: 9 }]);
    const es = makeClient("es.exe", "1.5a", run);
    expect(await es.rows([])).toEqual([]);
  });

  test("every call carries -instance, because a bare es.exe cannot reach Everything 1.5a", async () => {
    const { run, calls } = fakeEs([{ stdout: "0" }]);
    const es = makeClient("es.exe", "1.5a", run);
    await es.count(["x"]);
    expect(calls[0]!.slice(0, 2)).toEqual(["-instance", "1.5a"]);
  });

  test("rows requests ISO dates rather than raw FILETIME integers", async () => {
    const { run, calls } = fakeEs([{ stdout: "[]" }]);
    const es = makeClient("es.exe", "1.5a", run);
    await es.rows([]);
    expect(calls[0]).toContain("-date-format");
    expect(calls[0]).toContain("1");
  });

  test("non-JSON stdout is reported as such, not swallowed", async () => {
    const { run } = fakeEs([{ stdout: "Error: something" }]);
    const es = makeClient("es.exe", "1.5a", run);
    await expect(es.rows([])).rejects.toThrow(/not JSON/);
  });
});

describe("instance fallback", () => {
  // Everything registers under a version-shaped instance name. An upgrade
  // changes it, and every command would otherwise die with a bare Error 8.
  test("falls back to another instance name when the configured one is dead", async () => {
    const calls: string[][] = [];
    const run = async (_exe: string, args: string[]) => {
      calls.push(args);
      const named = args[0] === "-instance" ? args[1] : "";
      if (named === "1.6") return { ok: true, stdout: "42", stderr: "", code: 0 };
      return { ok: false, stdout: "", stderr: "", code: 8 };
    };
    const es = makeClient("es.exe", "1.6", run);
    expect(await es.count(["x"])).toBe(42);
    expect(es.resolvedInstance()).toBe("1.6");
  });

  test("a dead configured instance resolves to a working one and sticks", async () => {
    const run = async (_exe: string, args: string[]) => {
      const named = args[0] === "-instance" ? args[1] : "";
      if (named === "1.5a") return { ok: true, stdout: "7", stderr: "", code: 0 };
      return { ok: false, stdout: "", stderr: "", code: 8 };
    };
    const es = makeClient("es.exe", "9.9-bogus", run);
    expect(await es.count(["x"])).toBe(7);
    expect(es.resolvedInstance()).toBe("1.5a");
    // Second call must not re-probe; it goes straight to the resolved name.
    expect(await es.count(["y"])).toBe(7);
  });

  test("when nothing answers, the Error 8 guidance is still what surfaces", async () => {
    const run = async () => ({ ok: false, stdout: "", stderr: "", code: 8 });
    const es = makeClient("es.exe", "1.5a", run);
    await expect(es.count(["x"])).rejects.toThrow(/Everything IPC not found/);
  });
});

describe("duTree", () => {
  test("expands only branches worth expanding, and tags depth", async () => {
    const responses: Record<string, string> = {
      "F:\\": JSON.stringify([{ filename: "F:\\big\\", size: 900 }, { filename: "F:\\tiny\\", size: 5 }]),
      "F:\\big\\": JSON.stringify([{ filename: "F:\\big\\inner\\", size: 800 }]),
    };
    const run = async (_exe: string, args: string[]) => {
      const pi = args.indexOf("-parent");
      const parent = pi >= 0 ? args[pi + 1]! : "";
      const folders = args.includes("/ad");
      return { ok: true, stdout: folders ? (responses[parent] ?? "[]") : "[]", stderr: "", code: 0 };
    };
    const es = makeClient("es.exe", "1.5a", run);
    const t = await duTree(es, "F:\\", 2, 12, 0.02);
    expect(t.entries[0]!.name).toBe("big");
    expect(t.entries[0]!.depth).toBe(0);
    expect(t.entries[0]!.children?.[0]?.name).toBe("inner");
    expect(t.entries[0]!.children?.[0]?.depth).toBe(1);
    // "tiny" holds well under 2% of the level, so it is not expanded.
    expect(t.entries[1]!.children).toBeUndefined();
  });
});

describe("find", () => {
  test("reports true scale even when rows are capped", async () => {
    const { run } = fakeEs([
      { match: /-get-result-count/, stdout: "2728" },
      { match: /-get-total-size/, stdout: "2042134283725" },
      { match: /-json/, stdout: JSON.stringify([{ filename: "F:\\a.mkv", size: 10 }]) },
    ]);
    const es = makeClient("es.exe", "1.5a", run);
    const r = await find(es, { terms: [], ext: ["mkv"], limit: 1 });
    expect(r.shown).toBe(1);
    expect(r.total).toBe(2728);
    expect(r.truncated).toBe(true);
    expect(r.totalSize).toBe(2042134283725);
  });
});

describe("du", () => {
  test("merges folders and loose files into one size-ordered listing", async () => {
    const { run } = fakeEs([
      { match: /\/ad/, stdout: JSON.stringify([{ filename: "F:\\SteamLibrary\\", size: 790513670924 }]) },
      { match: /\/a-d/, stdout: JSON.stringify([{ filename: "F:\\big.zip", size: 14065568 }]) },
    ]);
    const es = makeClient("es.exe", "1.5a", run);
    const r = await du(es, "F:\\");
    expect(r.entries[0]!.name).toBe("SteamLibrary");
    expect(r.entries[0]!.kind).toBe("folder");
    expect(r.entries[1]!.kind).toBe("file");
    expect(r.grandTotal).toBe(790513670924 + 14065568);
  });

  test("strips the trailing backslash Everything puts on folder names", async () => {
    const { run } = fakeEs([
      { match: /\/ad/, stdout: JSON.stringify([{ filename: "F:\\Games\\", size: 1 }]) },
      { match: /\/a-d/, stdout: "[]" },
    ]);
    const es = makeClient("es.exe", "1.5a", run);
    const r = await du(es, "F:\\");
    expect(r.entries[0]!.name).toBe("Games");
  });
});

describe("byExtension", () => {
  test("groups by extension and flags an incomplete sample", async () => {
    const { run } = fakeEs([
      { match: /-get-result-count/, stdout: "100" },
      {
        match: /-json/,
        stdout: JSON.stringify([
          { filename: "F:\\a.mkv", size: 100 },
          { filename: "F:\\b.MKV", size: 50 },
          { filename: "F:\\c.iso", size: 200 },
          { filename: "F:\\README", size: 5 },
        ]),
      },
    ]);
    const es = makeClient("es.exe", "1.5a", run);
    const r = await byExtension(es, { terms: [], under: "F:\\" });
    expect(r.entries[0]).toEqual({ ext: "iso", count: 1, size: 200 });
    expect(r.entries[1]).toEqual({ ext: "mkv", count: 2, size: 150 });
    expect(r.entries.find((e) => e.ext === "(none)")?.count).toBe(1);
    expect(r.sampled).toBe(true);
  });
});

describe("dupes", () => {
  test("groups on name and size, and reports reclaimable bytes", async () => {
    const { run } = fakeEs([
      {
        match: /-json/,
        stdout: JSON.stringify([
          { filename: "F:\\one\\movie.mkv", size: 1000 },
          { filename: "F:\\two\\Movie.mkv", size: 1000 },
          { filename: "F:\\three\\movie.mkv", size: 999 },
          { filename: "F:\\solo.mkv", size: 42 },
        ]),
      },
    ]);
    const es = makeClient("es.exe", "1.5a", run);
    const r = await dupes(es, { terms: [] });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.paths).toHaveLength(2);
    expect(r.groups[0]!.wasted).toBe(1000);
    expect(r.wastedTotal).toBe(1000);
  });

  test("a different byte size is not a duplicate even with the same name", async () => {
    const { run } = fakeEs([
      {
        match: /-json/,
        stdout: JSON.stringify([
          { filename: "F:\\a\\x.bin", size: 10 },
          { filename: "F:\\b\\x.bin", size: 11 },
        ]),
      },
    ]);
    const es = makeClient("es.exe", "1.5a", run);
    expect((await dupes(es, { terms: [] })).groups).toHaveLength(0);
  });
});

describe("doctor", () => {
  test("failure carries the actionable message instead of throwing", async () => {
    const { run } = fakeEs([{ stdout: "", code: 8 }]);
    const es = makeClient("es.exe", "1.5a", run);
    const d = await doctor(es, "es.exe", "1.5a");
    expect(d.ok).toBe(false);
    expect(d.error).toMatch(/ev doctor|IPC not found/);
  });
});

describe("humanSize", () => {
  test("scales without lying about magnitude", () => {
    expect(humanSize(0)).toBe("0B");
    expect(humanSize(1024)).toBe("1.00K");
    expect(humanSize(790513670924)).toBe("736G");
    expect(humanSize(2042134283725)).toBe("1.86T");
  });
});
