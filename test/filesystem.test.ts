import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFsDeps } from "../src/fsdeps.ts";
import { applyLinks, planLinks, undoLinks } from "../src/link.ts";
import { createJournalWriter } from "../src/journal.ts";

test("real files survive a journalled link and undo with independent identities restored", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-link-test-"));
  try {
    const paths = [join(root, "a.bin"), join(root, "b.bin")];
    await Promise.all(paths.map((path) => writeFile(path, "fixture bytes")));
    const deps = makeFsDeps();
    const plan = await planLinks([{ name: "fixture", size: 13, paths, wasted: 13 }], deps, { minSize: 0 });
    const journalPath = join(root, "journal.json");
    const save = createJournalWriter(journalPath);
    const result = await applyLinks(plan, deps, save);
    expect(result.linked).toBe(1);
    expect((await deps.facts(paths[0]!))?.ino).toBe((await deps.facts(paths[1]!))?.ino);
    expect((await deps.facts(paths[0]!))?.ino).toBe(String((await lstat(paths[0]!, { bigint: true })).ino));
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const restored = await undoLinks(journal, deps);
    expect(restored.restored).toBe(1);
    expect((await deps.facts(paths[0]!))?.ino).not.toBe((await deps.facts(paths[1]!))?.ino);
    for (const path of paths) expect(await readFile(path, "utf8")).toBe("fixture bytes");
    expect(() => createJournalWriter(journalPath)).toThrow();
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toEqual(journal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quick sampling is rejected for a real apply before Everything is queried", async () => {
  const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "link", "--quick", "--yes"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, EV_CONFIG: "/nonexistent/ev/config.json", EV_ES_PATH: "/nonexistent/es.exe" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("--quick is only available for dry runs");
});

async function runCli(args: string[]) {
  const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, EV_CONFIG: "/nonexistent/ev/config.json", EV_ES_PATH: "/nonexistent/es.exe" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

test("a saved quick plan can be shown but never applied", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-plan-test-"));
  try {
    const planPath = join(root, "plan.json");
    await writeFile(planPath, JSON.stringify({
      version: 1, created: "x", quick: true, skipped: [], hashedBytes: 0,
      groups: [{ keeper: join(root, "a"), replace: [join(root, "b")], size: 5, hash: "h", reclaim: 5 }],
    }));
    const shown = await runCli(["link", "--plan", planPath]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain(`Apply with: ev link --plan "${planPath}" --yes`);
    const applied = await runCli(["link", "--plan", planPath, "--yes"]);
    expect(applied.code).toBe(1);
    expect(applied.stderr).toContain("planned with --quick");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--under twice is refused where it would silently mean one root", async () => {
  const r = await runCli(["find", "--under", "D:\\a", "--under", "D:\\b"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("only dupes and link accept --under more than once");
});

test("nested --under roots are refused before Everything is queried", async () => {
  const r = await runCli(["dupes", "--under", "D:\\Downloads", "--under", "D:\\Downloads\\n"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("give disjoint trees");
});

test("flags agents guess are accepted or pointed at the right name", async () => {
  const wrong = await runCli(["find", "--size", "5G"]);
  expect(wrong.code).toBe(1);
  expect(wrong.stderr).toContain("--larger");
  // --limit=3 parses as -n 3, so the only complaint left is --paths on du.
  const alias = await runCli(["du", "F:\\", "--limit=3", "--paths"]);
  expect(alias.code).toBe(1);
  expect(alias.stderr).toContain("--paths applies to find, recent and big");
});
