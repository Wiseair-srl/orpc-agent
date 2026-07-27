import { describe, expect, test } from "vitest";
import * as z from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { registerSchemaConverter, toJsonSchema } from "../src/schema/index";
import { createCapabilityRegistry } from "../src/registry";
import { agentBase, readMeta } from "./fixtures";

describe("toJsonSchema", () => {
  test("converts Zod v4 schemas via the built-in converter (input shape)", () => {
    const schema = z.object({
      query: z.string().min(2),
      limit: z.number().int().max(50).default(10),
    });
    const json = toJsonSchema(schema) as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(json.type).toBe("object");
    expect(Object.keys(json.properties)).toEqual(["query", "limit"]);
    // io: "input" — defaulted fields are optional for the caller.
    expect(json.required).toEqual(["query"]);
  });

  test("throws a clear startup-style error for unknown vendors", () => {
    const fake: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "mystery",
        validate: (value) => ({ value }),
      },
    };
    expect(() => toJsonSchema(fake)).toThrowError(
      /No JSON Schema converter registered for schema vendor "mystery"/,
    );
  });

  test("registered converters take over for their vendor", () => {
    const fake: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "acme",
        validate: (value) => ({ value }),
      },
    };
    registerSchemaConverter("acme", () => ({ type: "object", "x-acme": true }));
    expect(toJsonSchema(fake)).toEqual({ type: "object", "x-acme": true });
  });

  test("non-standard-schema values are rejected", () => {
    expect(() => toJsonSchema({} as never)).toThrowError(/not a Standard Schema/);
  });
});

describe("registry schema convertibility gate", () => {
  const mystery: StandardSchemaV1 = {
    "~standard": {
      version: 1,
      vendor: "unregistered-vendor",
      validate: (value) => ({ value }),
    },
  };

  test("unknown vendor on a schema-consuming surface fails at build", () => {
    const cap = agentBase
      .meta({ agent: readMeta({ expose: { aiSdk: true } }) })
      .input(mystery as never)
      .handler(async () => ({}));
    expect(() => createCapabilityRegistry({ cap })).toThrowError(
      /input schema cannot be converted to JSON Schema/,
    );
  });

  test("unknown vendor on direct-only exposure builds fine", () => {
    const cap = agentBase
      .meta({ agent: readMeta({ expose: { direct: true } }) })
      .input(mystery as never)
      .handler(async () => ({}));
    expect(() => createCapabilityRegistry({ cap })).not.toThrow();
  });
});
