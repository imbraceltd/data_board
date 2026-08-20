/**
 * PostgreSQL Search Provider
 * Database-native search using PostgreSQL's full-text search capabilities
 */

import { sql, eq, and, or, gt, gte, lt, lte, ne, SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../db/drizzle/schema";
import { boardItems } from "../../../db/drizzle/schema";
import type {
  ISearchProvider,
  SearchQuery,
  SearchResult,
  MultiSearchQuery,
  MultiSearchResult,
  FetchOptions,
  FetchResult,
} from "../../interfaces/search-provider.interface";
import { FilterParser } from "./filter-parser";

export class PostgresSearchProvider implements ISearchProvider {
  constructor(private db: NodePgDatabase<typeof schema>) {}

  async search(boardId: string, query: SearchQuery): Promise<SearchResult> {
    const startTime = Date.now();

    // Build WHERE conditions
    const conditions: SQL[] = [eq(boardItems.board_id, boardId)];

    // Parse and add filter conditions
    if (query.filter) {
      const filterConditions = this.parseFilter(query.filter);
      conditions.push(...filterConditions);
    }

    // Determine if we need full-text search
    const hasTextSearch = query.q && query.q.trim() !== "";

    // Build the query with or without full-text search
    if (hasTextSearch) {
      // Use PostgreSQL full-text search with tsvector and tsquery
      // Extract all text from JSONB fields and convert to tsvector
      const searchQuery = query.q!.trim();
      
      // Add full-text search condition using to_tsvector and plainto_tsquery
      const searchCondition = sql`to_tsvector('english',
        COALESCE(
          (SELECT string_agg(value, ' ')
           FROM jsonb_each_text(${boardItems.fields})
          ), ''
        )
      ) @@ plainto_tsquery('english', ${searchQuery})`;
      
      conditions.push(searchCondition);

      // Select with relevance ranking
      const queryWithRank = this.db
        .select({
          id: boardItems.id,
          business_unit_id: boardItems.business_unit_id,
          organization_id: boardItems.organization_id,
          board_id: boardItems.board_id,
          created_by: boardItems.created_by,
          created_type: boardItems.created_type,
          fields: boardItems.fields,
          related_board_item_id: boardItems.related_board_item_id,
          related_board_item_list: boardItems.related_board_item_list,
          conversation_ids: boardItems.conversation_ids,
          logo_url: boardItems.logo_url,
          created_at: boardItems.created_at,
          updated_at: boardItems.updated_at,
          // Add relevance rank for sorting
          rank: sql<number>`ts_rank(
            to_tsvector('english',
              COALESCE(
                (SELECT string_agg(value, ' ')
                 FROM jsonb_each_text(${boardItems.fields})
                ), ''
              )
            ),
            plainto_tsquery('english', ${searchQuery})
          )`.as('rank'),
        })
        .from(boardItems)
        .where(and(...conditions));

      // Add sorting - prioritize by relevance if text search, otherwise custom sort
      if (query.sort && query.sort.length > 0) {
        const sortConditions = FilterParser.parseSort(query.sort);
        const orderClauses = sortConditions.map((s) => this.buildSortClause(s));
        queryWithRank.orderBy(...orderClauses);
      } else {
        // Default: sort by relevance (rank) descending
        queryWithRank.orderBy(sql`rank DESC`);
      }

      // Count total
      const countQuery = this.db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(boardItems)
        .where(and(...conditions));

      const countResult = await countQuery;
      const totalHits = countResult[0]?.count || 0;

      // Add pagination
      const limit = query.limit || 20;
      const offset = query.offset || 0;
      const results = await queryWithRank.limit(limit).offset(offset);

      // Remove rank from results before returning
      const hits = results.map(({ rank, ...item }) => item);

      return {
        hits,
        query: searchQuery,
        processingTimeMs: Date.now() - startTime,
        limit,
        offset,
        estimatedTotalHits: totalHits,
      };
    } else {
      // No text search - just filter and sort
      let dbQuery = this.db
        .select()
        .from(boardItems)
        .where(and(...conditions));

      // Add sorting
      if (query.sort && query.sort.length > 0) {
        const sortConditions = FilterParser.parseSort(query.sort);
        const orderClauses = sortConditions.map((s) => this.buildSortClause(s));
        if (orderClauses.length > 0) {
          dbQuery = dbQuery.orderBy(...orderClauses);
        }
      } else {
        // Default sort: created_at desc
        dbQuery = dbQuery.orderBy(sql`${boardItems.created_at} DESC`);
      }

      // Count total
      const countQuery = this.db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(boardItems)
        .where(and(...conditions));

      const countResult = await countQuery;
      const totalHits = countResult[0]?.count || 0;

      // Add pagination
      const limit = query.limit || 20;
      const offset = query.offset || 0;
      dbQuery = dbQuery.limit(limit).offset(offset);

      const hits = await dbQuery;

      return {
        hits,
        query: query.q || "",
        processingTimeMs: Date.now() - startTime,
        limit,
        offset,
        estimatedTotalHits: totalHits,
      };
    }
  }

  async multiSearch(
    queries: MultiSearchQuery[]
  ): Promise<MultiSearchResult> {
    const results = await Promise.all(
      queries.map(async (q) => {
        const result = await this.search(q.indexUid, {
          q: q.q,
          filter: q.filter,
          limit: q.limit,
          offset: q.offset,
          sort: q.sort,
        });
        return {
          indexUid: q.indexUid,
          ...result,
        };
      })
    );

    return { results };
  }

  async fetch(boardId: string, options: FetchOptions): Promise<FetchResult> {
    const conditions: SQL[] = [eq(boardItems.board_id, boardId)];

    if (options.filter) {
      const filterConditions = this.parseFilter(options.filter);
      conditions.push(...filterConditions);
    }

    // Count total
    const countQuery = this.db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(boardItems)
      .where(and(...conditions));

    const countResult = await countQuery;
    const total = countResult[0]?.count || 0;

    // Fetch results
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    const results = await this.db
      .select()
      .from(boardItems)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset)
      .orderBy(sql`${boardItems.created_at} DESC`);

    return {
      results,
      offset,
      limit,
      total,
    };
  }

  /**
   * Parse Meilisearch filter syntax to PostgreSQL SQL conditions
   */
  private parseFilter(filter: string): SQL[] {
    const conditions: SQL[] = [];
    const tokens = FilterParser.tokenize(filter);

    const andGroups: SQL[][] = [[]];
    let currentGroup = 0;

    for (const token of tokens) {
      if (token.type === "operator") {
        if (token.value === "OR") {
          // Start new AND group
          currentGroup++;
          andGroups[currentGroup] = [];
        }
        // AND stays in current group
      } else if (token.type === "condition") {
        const condition = this.buildCondition(
          token.field,
          token.operator,
          token.value
        );
        if (condition) {
          andGroups[currentGroup].push(condition);
        }
      }
    }

    // Combine groups
    if (andGroups.length === 1) {
      // All AND
      return andGroups[0];
    } else {
      // Mix of AND/OR - wrap each group with AND, then OR them
      const orConditions = andGroups
        .filter((group) => group.length > 0)
        .map((group) => {
          if (group.length === 1) return group[0];
          return and(...group);
        })
        .filter((c): c is SQL => c !== undefined);

      if (orConditions.length === 0) return [];
      if (orConditions.length === 1) return [orConditions[0]];
      return [or(...orConditions) as SQL];
    }
  }

  /**
   * Build a single SQL condition
   */
  /**
   * Build an ORDER BY fragment for one sort key.
   *
   * A `fields.<id>` (or deeper `fields.<id>.sub`) token sorts by a value nested
   * in the JSONB `fields` column. Without this, the key isn't a real table
   * column, so the old code fell back to `created_at` and the requested sort was
   * silently ignored. We use `#>>` with a `text[]` path (same convention as
   * buildJsonbCondition) so dotted paths traverse; `->>` text extraction orders
   * ISO-8601 timestamps and other string values lexicographically, which is
   * chronological for the date fields stored here. NULLs are pushed last so rows
   * missing the field don't dominate a descending sort.
   */
  private buildSortClause(s: { field: string; direction: string }): SQL {
    if (s.field.startsWith("fields.")) {
      const fieldPath = s.field.replace("fields.", "");
      const pgPath = `{${fieldPath.split(".").join(",")}}`;
      const expr = sql`${boardItems.fields}#>>${pgPath}::text[]`;
      return s.direction === "desc"
        ? sql`${expr} DESC NULLS LAST`
        : sql`${expr} ASC NULLS LAST`;
    }
    const column = (boardItems as any)[s.field] || boardItems.created_at;
    return s.direction === "desc" ? sql`${column} DESC` : sql`${column} ASC`;
  }

  private buildCondition(
    field: string,
    operator: string,
    value: any
  ): SQL | null {
    // Handle JSONB fields
    if (field.startsWith("fields.")) {
      const fieldPath = field.replace("fields.", "");
      return this.buildJsonbCondition(
        boardItems.fields,
        fieldPath,
        operator,
        value
      );
    }

    if (field.startsWith("fields_timestamp.")) {
      // fields_timestamp.field_id — compare date/datetime values stored as ISO strings in fields JSONB
      // Frontend sends Unix timestamp in milliseconds; convert to timestamptz for comparison
      const fieldId = field.replace("fields_timestamp.", "");
      // Safe cast: only cast to timestamptz if the value looks like an ISO date string, else null
      const extractedTs = sql`(CASE WHEN (${boardItems.fields}->>${fieldId}) ~ '^\d{4}-\d{2}-\d{2}' THEN CAST(${boardItems.fields}->>${fieldId} AS TIMESTAMPTZ) ELSE NULL END)`;
      const tsValue = sql`to_timestamp(${value}::numeric / 1000.0)`;
      switch (operator) {
        case "=":  return sql`${extractedTs} = ${tsValue}`;
        case "!=": return sql`${extractedTs} != ${tsValue}`;
        case ">":  return sql`${extractedTs} > ${tsValue}`;
        case ">=": return sql`${extractedTs} >= ${tsValue}`;
        case "<":  return sql`${extractedTs} < ${tsValue}`;
        case "<=": return sql`${extractedTs} <= ${tsValue}`;
        default:   return null;
      }
    }

    // Handle top-level fields
    const column = (boardItems as any)[field];
    if (!column) return null;

    switch (operator) {
      case "=":
        return eq(column, value);
      case "!=":
        return ne(column, value);
      case ">":
        return gt(column, value);
      case ">=":
        return gte(column, value);
      case "<":
        return lt(column, value);
      case "<=":
        return lte(column, value);
      default:
        return null;
    }
  }

  /**
   * Build JSONB field condition
   */
  private buildJsonbCondition(
    jsonbColumn: any,
    fieldPath: string,
    operator: string,
    value: any
  ): SQL {
    // fieldPath may be a dotted path into nested JSONB — e.g.
    // "<fieldId>.calling_code_with_number" (Phone), "<fieldId>.country_code"
    // (Country), "<fieldId>.data.url" (Attachment), "<fieldId>.display_name"
    // (Assignee). Postgres `->>` with a single text key does NOT traverse dots;
    // it looks for a literal top-level key of that exact name, so every nested
    // sub-field filter silently matched nothing after the Mongo→Postgres
    // migration. Use `#>>` with a text[] path so dotted paths traverse, while a
    // single segment still behaves exactly like `->>`.
    const pgPath = `{${fieldPath.split(".").join(",")}}`;
    const extractedValue = sql`${jsonbColumn}#>>${pgPath}::text[]`;
    const numericExtract = sql`(CASE WHEN (${jsonbColumn}#>>${pgPath}::text[]) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN CAST(${jsonbColumn}#>>${pgPath}::text[] AS NUMERIC) ELSE NULL END)`;

    switch (operator) {
      case "=":
        return sql`${extractedValue} = ${value}`;
      case "!=":
        return sql`${extractedValue} != ${value}`;
      case ">":
        if (typeof value === "number") {
          return sql`${numericExtract} > ${value}`;
        }
        return sql`${extractedValue} > ${value}`;
      case ">=":
        if (typeof value === "number") {
          return sql`${numericExtract} >= ${value}`;
        }
        return sql`${extractedValue} >= ${value}`;
      case "<":
        if (typeof value === "number") {
          return sql`${numericExtract} < ${value}`;
        }
        return sql`${extractedValue} < ${value}`;
      case "<=":
        if (typeof value === "number") {
          return sql`${numericExtract} <= ${value}`;
        }
        return sql`${extractedValue} <= ${value}`;
      default:
        return sql`${extractedValue} = ${value}`;
    }
  }
}
