import { toJSONSchema, type ZodType } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { registerSchemaConverter, type JsonSchemaObject } from "./index";
/** Static import makes the converter visible to Lambda bundlers. Call before registry creation. */
export function registerZodSchemaConverter(): void {
  registerSchemaConverter("zod", (schema: StandardSchemaV1) => toJSONSchema(schema as ZodType, { io: "input" }) as JsonSchemaObject);
}
