import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeApp, type App } from "../src/app";
import { makeMCPEndpoint } from "../src/mcp";

async function connect(app: App, sessionToken?: string) {
  const endpoint = makeMCPEndpoint(app, sessionToken ? { sessionToken } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "external-tool", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), endpoint.connect(serverTransport)]);
  return client;
}

describe("the external MCP endpoint", () => {
  test("lists exactly the read capabilities for an authenticated session", async () => {
    const app = makeApp();
    const client = await connect(app, "token-dana");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([
      "customers_search",
      "customers_get",
      "orders_list",
      "orders_get",
      "orders_checkRefundEligibility",
    ]);
  });

  test("refuses sessions without a verified principal", async () => {
    const app = makeApp();
    const client = await connect(app); // no token
    await expect(client.listTools()).rejects.toThrowError(/Unauthorized/);
  });

  test("a read works end to end with redaction applied", async () => {
    const app = makeApp();
    const client = await connect(app, "token-dana");
    const result = await client.callTool({ name: "customers_get", arguments: { id: "c_alice" } });
    const envelope = JSON.parse(
      (result.content as { text: string }[])[0]!.text,
    ) as { status: string; data: { email: string; paymentMethods?: unknown } };
    expect(envelope.status).toBe("ok");
    expect(envelope.data.email).toBe("***@example.com");
    expect(envelope.data.paymentMethods).toBeUndefined();
  });

  test("orders_refund over MCP is concealed — identical to a nonexistent tool (SI-8)", async () => {
    const app = makeApp();
    const client = await connect(app, "token-dana");
    const refund = await client.callTool({
      name: "orders_refund",
      arguments: { orderId: "ord_42", amount: 100, reason: "damaged item" },
    });
    const nonexistent = await client.callTool({ name: "no_such_tool", arguments: {} });
    const refundText = (refund.content as { text: string }[])[0]!.text;
    const nonexistentText = (nonexistent.content as { text: string }[])[0]!.text;
    expect(refundText).toBe(nonexistentText);
    expect(JSON.parse(refundText)).toEqual({
      status: "error",
      error: { code: "CAPABILITY_NOT_FOUND", message: "Capability not found.", retryable: false },
    });
    expect(refund.isError).toBe(true);
    // Nothing moved; the audit trail recorded the true reasons.
    expect(app.db.refunds).toHaveLength(0);
    const reasons = app.auditTrail
      .filter((e) => e.type === "capability.denied")
      .map((e) => (e as { data: { reason: string } }).data.reason);
    expect(reasons).toEqual(["not-exposed", "unknown"]);
  });

  test("no approval-deciding tool exists on this surface (SI-4)", async () => {
    const app = makeApp();
    const client = await connect(app, "token-dana");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /approve|decide|reject/i.test(n))).toEqual([]);
  });
});
