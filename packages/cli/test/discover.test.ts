import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addScript,
  discoverEntries,
  hasScript,
  readAgentConfig,
  writeAgentConfig,
} from "../src/discover";

/**
 * The logic behind `init`, tested without Ink: the wizard's view is
 * replaceable, this is what decides what lands in a consumer's package.json.
 */
function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "orpc-discover-"));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "demo" }, null, 2)}\n`);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

describe("discoverEntries", () => {
  it("finds the conventional entry modules that exist", () => {
    const dir = project({ "src/app.ts": "", "src/registry.ts": "", "src/unrelated.ts": "" });

    expect(discoverEntries(dir)).toEqual(["src/app.ts", "src/registry.ts"]);
  });

  it("ranks the module that assembles the app first", () => {
    const dir = project({ "src/index.ts": "", "src/app.ts": "" });

    expect(discoverEntries(dir)[0]).toBe("src/app.ts");
  });

  it("returns nothing rather than guessing when no candidate exists", () => {
    expect(discoverEntries(project())).toEqual([]);
  });
});

describe("writeAgentConfig", () => {
  it("merges into orpcAgent so a hand-set field survives a re-run", () => {
    const dir = project();
    writeAgentConfig(dir, { entry: "src/app.ts", snapshot: "governance/caps.json" });
    writeAgentConfig(dir, { entry: "src/runtime.ts", export: "governanceRuntime" });

    expect(readAgentConfig(dir)).toEqual({
      entry: "src/runtime.ts",
      export: "governanceRuntime",
      snapshot: "governance/caps.json",
    });
  });

  it("leaves the rest of package.json intact, two-space with a trailing newline", () => {
    const dir = project();
    writeAgentConfig(dir, { entry: "src/app.ts" });
    const raw = readFileSync(join(dir, "package.json"), "utf8");

    expect(JSON.parse(raw).name).toBe("demo");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw).toContain('\n  "orpcAgent"');
  });

  it("reads an absent config as empty rather than throwing", () => {
    expect(readAgentConfig(mkdtempSync(join(tmpdir(), "orpc-empty-")))).toEqual({});
  });
});

describe("addScript", () => {
  it("adds the CI script only when one is not already defined", () => {
    const dir = project();
    expect(hasScript(dir, "check:capabilities")).toBe(false);

    addScript(dir, "check:capabilities", "orpc-agent check");
    expect(hasScript(dir, "check:capabilities")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts).toEqual({
      "check:capabilities": "orpc-agent check",
    });
  });
});
