import { createRequire } from "node:module";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Standard Schema → JSON Schema conversion for adapter wire formats
 * (ADR-009). Built-in converter: Zod v4 via `z.toJSONSchema`. Other vendors
 * register a converter once at startup.
 */

export type JsonSchemaObject = { [key: string]: unknown };

type SchemaConverter = (schema: StandardSchemaV1) => JsonSchemaObject;

const converters = new Map<string, SchemaConverter>();
const cache = new WeakMap<StandardSchemaV1, JsonSchemaObject>();

export function registerSchemaConverter(
  vendor: string,
  convert: (schema: StandardSchemaV1) => JsonSchemaObject,
): void {
  if (typeof vendor !== "string" || vendor.length === 0) {
    throw new TypeError("registerSchemaConverter: vendor must be a non-empty string");
  }
  if (typeof convert !== "function") {
    throw new TypeError("registerSchemaConverter: convert must be a function");
  }
  converters.set(vendor, convert);
}

export function toJsonSchema(schema: StandardSchemaV1): JsonSchemaObject {
  const cached = cache.get(schema);
  if (cached) return cached;

  const standard = (schema as { "~standard"?: { vendor?: unknown } })["~standard"];
  const vendor = standard?.vendor;
  if (typeof vendor !== "string") {
    throw new TypeError("toJsonSchema: value is not a Standard Schema (missing ~standard.vendor)");
  }

  const converter = converters.get(vendor) ?? (vendor === "zod" ? zodConverter : undefined);
  if (!converter) {
    throw new Error(
      `No JSON Schema converter registered for schema vendor "${vendor}". ` +
        `Built-in support covers Zod v4; for other vendors call ` +
        `registerSchemaConverter("${vendor}", convert) once at startup.`,
    );
  }

  const result = converter(schema);
  if (typeof result !== "object" || result === null) {
    throw new Error(`JSON Schema converter for vendor "${vendor}" returned a non-object`);
  }
  cache.set(schema, result);
  return result;
}

let zodToJsonSchema: ((schema: unknown, options?: unknown) => unknown) | undefined;

function zodConverter(schema: StandardSchemaV1): JsonSchemaObject {
  if (!zodToJsonSchema) {
    let zod: { toJSONSchema?: unknown };
    try {
      zod = createRequire(import.meta.url)("zod");
    } catch (cause) {
      throw new Error(
        'The built-in Zod converter requires the "zod" package (v4) to be installed. ' +
          "Install zod, or register a custom converter for vendor \"zod\".",
        { cause },
      );
    }
    if (typeof zod.toJSONSchema !== "function") {
      throw new Error(
        "The built-in Zod converter requires Zod v4 (z.toJSONSchema was not found). " +
          'Upgrade zod, or register a custom converter for vendor "zod".',
      );
    }
    const fn = zod.toJSONSchema as (schema: unknown, options?: unknown) => unknown;
    zodToJsonSchema = fn;
  }
  // io: "input" — tools describe what callers must PRODUCE (pre-parse shape:
  // defaults optional, transforms untransformed).
  return zodToJsonSchema(schema, { io: "input" }) as JsonSchemaObject;
}
