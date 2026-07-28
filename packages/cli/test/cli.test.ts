import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { CapabilitySnapshot } from "../src/types";

const execFileAsync = promisify(execFile);

const packageRoot = resolve(import.meta.dirname, "..");
const binary = join(packageRoot, "dist", "cli.js");
const apps = join(packageRoot, "test", "apps");

/**
 * Drives the built binary end to end: argument parsing, the child-process
 * loader, exit codes. CI builds before it tests; locally this self-skips
 * rather than reporting a failure that only means "not built yet".
 */
const describeBuilt = existsSync(binary) ? describe : describe.skip;

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binary, ...args], {
      cwd: packageRoot,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "orpc-agent-cli-")), name);
}

describeBuilt("orpc-agent", () => {
  it("prints the inventory of an application entry", async () => {
    const { code, stdout } = await run(["inspect", "--entry", join(apps, "app.ts")]);

    expect(code).toBe(0);
    expect(stdout).toContain("orders.refund");
    expect(stdout).toContain("orders.list");
    // The plain procedure carries no meta.agent and is a capability nowhere.
    expect(stdout).toContain("internal");
    expect(stdout).toContain("Excluded");
  });

  it("emits a snapshot that round-trips and is stable across runs", async () => {
    const first = await run(["snapshot", "--entry", join(apps, "app.ts"), "-o", "-"]);
    const second = await run(["snapshot", "--entry", join(apps, "app.ts"), "-o", "-"]);

    expect(first.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);

    const snapshot = JSON.parse(first.stdout) as CapabilitySnapshot;
    expect(snapshot.version).toBe(1);
    expect(snapshot.capabilities.map((c) => c.id)).toEqual(["orders.list", "orders.refund"]);
    expect(snapshot.excluded).toEqual(["internal"]);
  });

  it("passes check against its own snapshot", async () => {
    const path = tempFile("capabilities.snapshot.json");
    await run(["snapshot", "--entry", join(apps, "app.ts"), "-o", path]);

    const { code, stdout } = await run([
      "check",
      "--entry",
      join(apps, "app.ts"),
      "--snapshot",
      path,
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("No capability drift");
  });

  it("fails with exit 1 and names the widening when the app gained exposure", async () => {
    const path = tempFile("capabilities.snapshot.json");
    const built = await run(["snapshot", "--entry", join(apps, "app.ts"), "-o", "-"]);
    const snapshot = JSON.parse(built.stdout) as CapabilitySnapshot;
    const refund = snapshot.capabilities.find((c) => c.id === "orders.refund");
    refund!.expose = ["aiSdk"];
    refund!.approval = { required: true };
    writeFileSync(path, JSON.stringify(snapshot));

    const { code, stdout } = await run([
      "check",
      "--entry",
      join(apps, "app.ts"),
      "--snapshot",
      path,
    ]);

    expect(code).toBe(1);
    expect(stdout).toContain("WIDENING");
    expect(stdout).toContain("now exposed on mcp");
  });

  it("passes with --fail-on=widening when the only drift narrows", async () => {
    const path = tempFile("capabilities.snapshot.json");
    const built = await run(["snapshot", "--entry", join(apps, "app.ts"), "-o", "-"]);
    const snapshot = JSON.parse(built.stdout) as CapabilitySnapshot;
    snapshot.capabilities.push({
      id: "orders.void",
      description: "gone",
      sideEffect: "write",
      risk: "high",
      expose: ["mcp"],
      idempotent: false,
      tags: [],
      policies: [],
      inputSchemaHash: null,
    });
    writeFileSync(path, JSON.stringify(snapshot));

    const strict = await run(["check", "--entry", join(apps, "app.ts"), "--snapshot", path]);
    const lenient = await run([
      "check",
      "--entry",
      join(apps, "app.ts"),
      "--snapshot",
      path,
      "--fail-on",
      "widening",
    ]);

    expect(strict.code).toBe(1);
    expect(lenient.code).toBe(0);
  });

  it("renders GitHub annotations with widening as errors", async () => {
    const path = tempFile("capabilities.snapshot.json");
    const built = await run(["snapshot", "--entry", join(apps, "app.ts"), "-o", "-"]);
    const snapshot = JSON.parse(built.stdout) as CapabilitySnapshot;
    snapshot.capabilities.find((c) => c.id === "orders.refund")!.expose = ["aiSdk"];
    writeFileSync(path, JSON.stringify(snapshot));

    const { stdout } = await run([
      "check",
      "--entry",
      join(apps, "app.ts"),
      "--snapshot",
      path,
      "--format",
      "github",
    ]);

    expect(stdout).toMatch(/^::error title=widening: orders\.refund/m);
  });

  it("exits 2 when the snapshot file is missing, and says how to create it", async () => {
    const { code, stderr } = await run([
      "check",
      "--entry",
      join(apps, "app.ts"),
      "--snapshot",
      tempFile("absent.json"),
    ]);

    expect(code).toBe(2);
    expect(stderr).toContain("was not found");
    expect(stderr).toContain("orpc-agent snapshot");
  });

  it("refuses to call a factory export", async () => {
    const { code, stderr } = await run([
      "inspect",
      "--entry",
      join(apps, "factory.ts"),
      "--export",
      "makeApp",
    ]);

    expect(code).toBe(2);
    expect(stderr).toContain("is a function");
  });

  it("asks which export to use when several registries are exported", async () => {
    const ambiguous = await run(["inspect", "--entry", join(apps, "ambiguous.ts")]);
    const chosen = await run([
      "inspect",
      "--entry",
      join(apps, "ambiguous.ts"),
      "--export",
      "internalRegistry",
    ]);

    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stderr).toContain("publicRegistry");
    expect(ambiguous.stderr).toContain("internalRegistry");
    expect(chosen.code).toBe(0);
  });

  it("exits 2 with a usable message when no registry is exported", async () => {
    const { code, stderr } = await run(["inspect", "--entry", join(apps, "factory.ts")]);

    expect(code).toBe(2);
    expect(stderr).toContain("no capability registry");
  });

  it("sets ORPC_AGENT_INSPECT so applications can guard import-time work", async () => {
    const { code, stdout } = await run([
      "inspect",
      "--entry",
      join(apps, "guarded.ts"),
      "--json",
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).capabilities[0].description).toBe("inspected");
  });

  it("times out instead of hanging on an entry that never finishes importing", async () => {
    const { code, stderr } = await run([
      "inspect",
      "--entry",
      join(apps, "hangs.ts"),
      "--timeout",
      "1500",
    ]);

    expect(code).toBe(2);
    expect(stderr).toContain("timed out");
  });
});
