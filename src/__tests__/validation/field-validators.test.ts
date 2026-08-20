import { describe, it, expect } from "vitest";
import {
  validateSelectOption,
  validateMultiSelectOptions,
} from "../../core/validation/field-validators";

// Mirrors the "Document Status" field shape: options carry an `id` (UUID) and a
// human-readable `value` (label). Callers may submit either the id or the label.
const OPTIONS = [
  { id: "5ca6e347-a8de-4aef-8de8-af8182ae2276", value: "Awaiting Docs" },
  { id: "9bc7b88e-3076-49e4-88fb-d29917b14bc4", value: "Missing Docs" },
  { id: "f220c3ec-3dae-4a06-9cfa-eee3c40c810d", value: "Ready To Check" },
];

describe("validateSelectOption", () => {
  it("matches by exact option value", () => {
    expect(validateSelectOption("Missing Docs", OPTIONS)).toBe(true);
  });

  it("matches by option id", () => {
    expect(
      validateSelectOption("9bc7b88e-3076-49e4-88fb-d29917b14bc4", OPTIONS),
    ).toBe(true);
  });

  // Regression: the stored option value once had a trailing space
  // ("Missing Docs ") while the incoming value did not, causing a false reject.
  it("matches when the stored option value has trailing whitespace", () => {
    const dirty = [{ id: "x", value: "Missing Docs " }];
    expect(validateSelectOption("Missing Docs", dirty)).toBe(true);
  });

  it("matches when the incoming value has surrounding whitespace", () => {
    expect(validateSelectOption("  Missing Docs  ", OPTIONS)).toBe(true);
  });

  it("rejects an unknown option", () => {
    expect(validateSelectOption("Bogus", OPTIONS)).toBe(false);
  });

  it("passes through empty value / empty options", () => {
    expect(validateSelectOption("", OPTIONS)).toBe(true);
    expect(validateSelectOption("anything", [])).toBe(true);
  });
});

describe("validateMultiSelectOptions", () => {
  it("accepts values matching by value or id", () => {
    expect(
      validateMultiSelectOptions(
        ["Missing Docs", "f220c3ec-3dae-4a06-9cfa-eee3c40c810d"],
        OPTIONS,
      ),
    ).toBe(true);
  });

  it("matches whitespace-insensitively on both sides", () => {
    const dirty = [{ id: "x", value: "Missing Docs " }];
    expect(validateMultiSelectOptions(["  Missing Docs"], dirty)).toBe(true);
  });

  it("rejects when any value is unknown", () => {
    expect(validateMultiSelectOptions(["Missing Docs", "Bogus"], OPTIONS)).toBe(
      false,
    );
  });

  it("accepts an empty array but rejects a non-array value", () => {
    expect(validateMultiSelectOptions([], OPTIONS)).toBe(true);
    expect(validateMultiSelectOptions("Missing Docs" as any, OPTIONS)).toBe(
      false,
    );
  });
});
