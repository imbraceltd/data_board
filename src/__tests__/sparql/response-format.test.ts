import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import yaml from "js-yaml";
import { respond } from "../../presentation/utils/response-format";

// Smallest possible Hono app to exercise the helper through real Context
// plumbing — same Response object the actual controllers would emit.
function appForFormat(format: "json" | "yaml", payload: unknown): Hono {
  const app = new Hono();
  app.get("/", (c) => respond(c, payload, format));
  return app;
}

describe("respond — JSON output", () => {
  it("returns application/json with the payload intact", async () => {
    const payload = { head: { vars: ["s"] }, results: { bindings: [] } };
    const res = await appForFormat("json", payload).request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/);
    expect(await res.json()).toEqual(payload);
  });
});

describe("respond — YAML output", () => {
  it("returns application/yaml with a body that round-trips through yaml.load", async () => {
    const payload = {
      head: { vars: ["s"] },
      results: {
        bindings: [
          { s: { type: "uri", value: "urn:imbrace:board:abc" } },
        ],
      },
    };
    const res = await appForFormat("yaml", payload).request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/application\/yaml/);
    const body = await res.text();
    expect(yaml.load(body)).toEqual(payload);
  });

  it("emits unquoted plain scalars and no anchors (LLM-friendly output)", async () => {
    // Two items with the same blank node would normally trigger a YAML
    // anchor/alias — `noRefs: true` should prevent that.
    const shared = { type: "uri", value: "urn:imbrace:item:shared" };
    const payload = { a: shared, b: shared };
    const res = await appForFormat("yaml", payload).request("/");
    const body = await res.text();
    // No anchors / aliases in the body.
    expect(body).not.toMatch(/&\w+/);
    expect(body).not.toMatch(/\*\w+/);
    // Plain string scalars are unquoted in YAML block style.
    expect(body).toMatch(/type: uri/);
    expect(body).toMatch(/value: urn:imbrace:item:shared/);
  });
});
