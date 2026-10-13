import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

interface OpenApiDoc {
  components: { schemas: Record<string, unknown> };
}

interface OpenApiPaths {
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<
          string,
          { content?: { "application/json": { schema: object } } }
        >;
      }
    >
  >;
}

export function loadOpenApi(): OpenApiDoc {
  const url = new URL("../../spec/openapi.yaml", import.meta.url);
  return parse(readFileSync(fileURLToPath(url), "utf8")) as OpenApiDoc;
}

/** Compiles a validator for a named component schema in spec/openapi.yaml (Acceptance #3). */
export function schemaValidator(
  name: string,
): (data: unknown) => string | null {
  const doc = loadOpenApi();
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  const validate = ajv.compile({
    $id: `urn:openapi:${name}`,
    components: doc.components,
    $ref: `#/components/schemas/${name}`,
  });
  return (data) => (validate(data) ? null : ajv.errorsText(validate.errors));
}

/** Validator for the JSON response schema openapi.yaml declares for a path, method and status. */
export function responseValidator(
  path: string,
  method: string,
  status: number,
): (data: unknown) => string | null {
  const doc = loadOpenApi() as OpenApiDoc & OpenApiPaths;
  const schema =
    doc.paths[path]?.[method]?.responses[String(status)]?.content?.[
      "application/json"
    ].schema;
  if (!schema)
    throw new Error(`openapi.yaml has no ${status} for ${method} ${path}`);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  const validate = ajv.compile({
    $id: `urn:openapi:${method}:${path}:${status}`,
    components: doc.components,
    ...schema,
  });
  return (data) => (validate(data) ? null : ajv.errorsText(validate.errors));
}
