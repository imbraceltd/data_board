import { describe, it, expect } from "vitest";
import {
  iriForBoard,
  iriForField,
  iriForItem,
  parseFieldIri,
  parseItemIri,
  toLiteral,
} from "../../core/rdf/vocab";

describe("vocab — IRI helpers", () => {
  it("builds and parses board / item / field IRIs round-trip", () => {
    expect(iriForBoard("b1").value).toBe("urn:imbrace:board:b1");
    expect(iriForItem("i1").value).toBe("urn:imbrace:item:i1");
    expect(iriForField("b1", "f1").value).toBe("urn:imbrace:field:b1/f1");

    expect(parseItemIri("urn:imbrace:item:abc")).toBe("abc");
    expect(parseItemIri("not-an-item-iri")).toBeNull();

    expect(parseFieldIri("urn:imbrace:field:b1/f1")).toEqual({
      boardId: "b1",
      fieldId: "f1",
    });
    expect(parseFieldIri("urn:imbrace:field:bad")).toBeNull();
    expect(parseFieldIri("urn:imbrace:other:foo/bar")).toBeNull();
  });

  it("escapes special characters in IRIs and decodes them back", () => {
    const iri = iriForField("board id with space", "f/with/slash");
    expect(iri.value).toBe(
      "urn:imbrace:field:board%20id%20with%20space/f%2Fwith%2Fslash",
    );
    expect(parseFieldIri(iri.value)).toEqual({
      boardId: "board id with space",
      fieldId: "f/with/slash",
    });
  });
});

describe("vocab — toLiteral", () => {
  it("returns null for null/undefined", () => {
    expect(toLiteral(null)).toBeNull();
    expect(toLiteral(undefined)).toBeNull();
  });

  it("encodes booleans with xsd:boolean", () => {
    const t = toLiteral(true)!;
    expect(t.value).toBe("true");
    expect(t.datatype.value).toBe("http://www.w3.org/2001/XMLSchema#boolean");
  });

  it("encodes integers with xsd:integer and floats with xsd:decimal", () => {
    const i = toLiteral(42)!;
    expect(i.value).toBe("42");
    expect(i.datatype.value).toBe("http://www.w3.org/2001/XMLSchema#integer");
    const f = toLiteral(3.14)!;
    expect(f.datatype.value).toBe("http://www.w3.org/2001/XMLSchema#decimal");
  });

  it("encodes ISO-like date strings as xsd:dateTime", () => {
    const d = toLiteral("2026-05-08T10:00:00Z")!;
    expect(d.datatype.value).toBe(
      "http://www.w3.org/2001/XMLSchema#dateTime",
    );
  });

  it("encodes plain strings as plain literals (xsd:string by default)", () => {
    const s = toLiteral("hello world")!;
    expect(s.value).toBe("hello world");
  });

  it("encodes arrays/objects as JSON string literals", () => {
    const a = toLiteral([1, 2, 3])!;
    expect(a.value).toBe("[1,2,3]");
    const o = toLiteral({ a: 1 })!;
    expect(o.value).toBe('{"a":1}');
  });
});
