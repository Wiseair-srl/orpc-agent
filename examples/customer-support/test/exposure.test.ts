import { describe, expect, test } from "vitest";
import { makeApp } from "../src/app";

/**
 * Exposure snapshots per surface — surface drift shows up as a failing
 * snapshot, i.e. a reviewed diff (acceptance criterion 5).
 */

describe("exposure per surface", () => {
  const app = makeApp();
  const dana = app.sessions.dana;
  const options = { actor: app.actorFrom(dana), context: app.contextFor(dana) };

  test("aiSdk listing matches the capability inventory", async () => {
    const ids = (await app.runtime.describe("aiSdk", options)).map((d) => d.id);
    expect(ids).toMatchInlineSnapshot(`
      [
        "customers.search",
        "customers.get",
        "orders.list",
        "orders.get",
        "orders.checkRefundEligibility",
        "orders.refund",
        "messages.draft",
        "messages.send",
        "messages.getCustomerThread",
        "cases.escalate",
      ]
    `);
  });

  test("mcp listing is reads only — refund and all writes are absent", async () => {
    const ids = (await app.runtime.describe("mcp", options)).map((d) => d.id);
    expect(ids).toMatchInlineSnapshot(`
      [
        "customers.search",
        "customers.get",
        "orders.list",
        "orders.get",
        "orders.checkRefundEligibility",
      ]
    `);
    expect(ids).not.toContain("orders.refund");
  });

  test("messages.send is annotated as requiring approval", async () => {
    const descriptors = await app.runtime.describe("aiSdk", options);
    expect(descriptors.find((d) => d.id === "messages.send")?.requiresApproval).toBe(true);
    expect(descriptors.find((d) => d.id === "orders.list")?.requiresApproval).toBeUndefined();
  });

  test("accounts.delete does not exist at all — the strongest exposure decision", () => {
    expect(app.runtime.registry.get("accounts.delete")).toBeUndefined();
    expect(app.runtime.registry.ids()).toHaveLength(10);
  });

  test("classification snapshot: the governed surface is a reviewed diff", () => {
    const rows = app.runtime.registry.capabilities().map((c) => ({
      id: c.id,
      sideEffect: c.meta.sideEffect,
      risk: c.meta.risk,
      expose: Object.keys(c.meta.expose).filter((s) => c.meta.expose[s as never]),
    }));
    expect(rows).toMatchSnapshot();
  });
});
