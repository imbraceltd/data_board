/**
 * Response-format helper used by the RDF/SPARQL controllers.
 *
 * Lets callers opt into YAML output via `?format=yaml` for ~25-40% token
 * savings vs JSON on the same payload shape. The structure is preserved
 * exactly — only the serialization differs.
 */

import type { Context } from "hono";
import yaml from "js-yaml";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ResponseFormat } from "../schemas/board-rdf.schema";

export function respond(
  c: Context,
  payload: unknown,
  format: ResponseFormat,
  status: ContentfulStatusCode = 200,
): Response {
  if (format === "yaml") {
    // lineWidth: -1 disables auto-wrap (LLMs read whole strings better);
    // noRefs: true avoids YAML anchors/aliases that confuse LLM consumers.
    const body = yaml.dump(payload, { lineWidth: -1, noRefs: true });
    return c.body(body, status, {
      "content-type": "application/yaml; charset=utf-8",
    });
  }
  return c.json(payload as object, status);
}
