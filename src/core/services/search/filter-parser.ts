/**
 * Filter Parser
 * Parses Meilisearch-style filter syntax for database queries
 * Example: "organization_id = 'org_123' AND fields.field_id = 'value'"
 */

import type {
  FilterToken,
  FilterConditionToken,
  FilterOperatorToken,
} from "../../interfaces/search-provider.interface";

export class FilterParser {
  /**
   * Tokenize Meilisearch filter syntax into structured tokens
   */
  static tokenize(filter: string): FilterToken[] {
    if (!filter || filter.trim() === "") {
      return [];
    }

    const tokens: FilterToken[] = [];

    // Split by AND/OR while preserving the operator.
    //
    // We must NOT use a plain `filter.split(/\s+(AND|OR)\s+/i)` here: that
    // splits on AND/OR even when they sit *inside* a quoted value, and the
    // case-insensitive flag means the ordinary English words "and"/"or"
    // trigger it too. A value like
    //   fields.x = 'Digital Growth and AI Brands'
    // would get torn into garbage conditions and silently match nothing.
    //
    // splitTopLevel is quote-aware and only treats the *uppercase* AND/OR
    // operators (the Meilisearch syntax) as separators when outside quotes.
    const parts = FilterParser.splitTopLevel(filter);

    for (let i = 0; i < parts.length; i += 2) {
      const condition = parts[i].trim();
      if (!condition) continue;

      // Match: field operator value
      // Supports: =, !=, >, >=, <, <=
      const match = condition.match(/^(.+?)\s*(!=|>=|<=|=|>|<)\s*(.+)$/);

      if (match) {
        const field = match[1].trim();
        const operator = match[2];
        let value: any = match[3].trim();

        // Remove quotes if present
        if (
          (value.startsWith("'") && value.endsWith("'")) ||
          (value.startsWith('"') && value.endsWith('"'))
        ) {
          value = value.slice(1, -1);
        }

        // Try to parse as number — but only when the string round-trips
        // exactly. Otherwise we corrupt values that merely look numeric:
        // phone numbers ("+84948018633" → 84948018633 drops the "+"),
        // zero-padded codes ("007" → 7), and IDs beyond 2^53 that lose
        // precision. Those must stay strings so JSONB text equality matches.
        const numValue = Number(value);
        if (value !== "" && !isNaN(numValue) && String(numValue) === value) {
          value = numValue;
        }

        tokens.push({
          type: "condition",
          field,
          operator,
          value,
        } as FilterConditionToken);

        // Add operator token if there's more
        if (i + 1 < parts.length) {
          const op = parts[i + 1].toUpperCase();
          if (op === "AND" || op === "OR") {
            tokens.push({
              type: "operator",
              value: op as "AND" | "OR",
            } as FilterOperatorToken);
          }
        }
      }
    }

    return tokens;
  }

  /**
   * Split a filter string into alternating [condition, operator, condition, …]
   * parts, splitting only on top-level (outside-quotes) uppercase AND/OR
   * operators surrounded by whitespace.
   *
   * Mirrors the shape produced by `String.split(/\s+(AND|OR)\s+/)` (operators
   * land on odd indices) so the caller's loop is unchanged — but it never
   * splits inside a single- or double-quoted value, and it ignores lowercase
   * "and"/"or" which are just words, not operators.
   */
  private static splitTopLevel(filter: string): string[] {
    const parts: string[] = [];
    let buf = "";
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < filter.length; ) {
      const ch = filter[i];

      if (quote) {
        buf += ch;
        if (ch === quote) quote = null;
        i++;
        continue;
      }

      if (ch === "'" || ch === '"') {
        quote = ch;
        buf += ch;
        i++;
        continue;
      }

      // Top-level boundary: whitespace + uppercase AND/OR + whitespace.
      const m = filter.slice(i).match(/^\s+(AND|OR)\s+/);
      if (m) {
        parts.push(buf);
        parts.push(m[1]);
        buf = "";
        i += m[0].length;
        continue;
      }

      buf += ch;
      i++;
    }

    parts.push(buf);
    return parts;
  }

  /**
   * Parse sorting array from Meilisearch format
   * Example: ["created_at:desc", "name:asc"]
   */
  static parseSort(
    sort?: string[]
  ): Array<{ field: string; direction: "asc" | "desc" }> {
    if (!sort || sort.length === 0) {
      return [];
    }

    return sort.map((s) => {
      const [field, direction = "asc"] = s.split(":");
      return {
        field: field.trim(),
        direction: (direction.toLowerCase() === "desc" ? "desc" : "asc") as
          | "asc"
          | "desc",
      };
    });
  }
}
