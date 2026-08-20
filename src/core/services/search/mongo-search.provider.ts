/**
 * MongoDB Search Provider
 * Database-native search using MongoDB's text search capabilities
 */

import type { MongoClient } from "mongodb";
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

export class MongoSearchProvider implements ISearchProvider {
  constructor(
    private client: MongoClient,
    private dbName: string
  ) {}

  private getCollection() {
    return this.client.db(this.dbName).collection("board_items");
  }

  async search(boardId: string, query: SearchQuery): Promise<SearchResult> {
    const startTime = Date.now();

    // Build filter
    const filter: any = { board_id: boardId };

    // Add text search
    if (query.q && query.q.trim() !== "") {
      // MongoDB text search - note: requires text index
      // For now, use regex search on fields (fallback)
      // To use $text, need to create text index: db.board_items.createIndex({ "fields.$**": "text" })
      filter.$or = [
        { "fields.$**": { $regex: query.q, $options: "i" } },
      ];
    }

    // Parse and add custom filters
    if (query.filter) {
      const parsedFilter = this.parseFilter(query.filter);
      Object.assign(filter, parsedFilter);
    }

    // Build aggregation pipeline
    const pipeline: any[] = [{ $match: filter }];

    // Add sorting
    if (query.sort && query.sort.length > 0) {
      const sortObj = this.parseSorting(query.sort);
      pipeline.push({ $sort: sortObj });
    } else {
      pipeline.push({ $sort: { created_at: -1 } });
    }

    // Count total
    const countPipeline = [...pipeline];
    countPipeline.push({ $count: "total" });

    const collection = this.getCollection();
    const countResult = await collection.aggregate(countPipeline).toArray();
    const totalHits = countResult[0]?.total || 0;

    // Add pagination
    const limit = query.limit || 20;
    const offset = query.offset || 0;
    pipeline.push({ $skip: offset });
    pipeline.push({ $limit: limit });

    const hits = await collection.aggregate(pipeline).toArray();

    return {
      hits,
      query: query.q || "",
      processingTimeMs: Date.now() - startTime,
      limit,
      offset,
      estimatedTotalHits: totalHits,
    };
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
    const filter: any = { board_id: boardId };

    if (options.filter) {
      const parsedFilter = this.parseFilter(options.filter);
      Object.assign(filter, parsedFilter);
    }

    const collection = this.getCollection();

    // Count total
    const total = await collection.countDocuments(filter);

    // Fetch results
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    const results = await collection
      .find(filter)
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    return {
      results,
      offset,
      limit,
      total,
    };
  }

  /**
   * Parse Meilisearch filter syntax to MongoDB query
   */
  private parseFilter(filter: string): any {
    const mongoFilter: any = {};
    const tokens = FilterParser.tokenize(filter);

    const andConditions: any[] = [];
    const orConditions: any[] = [];
    let currentOperator: "AND" | "OR" = "AND";

    for (const token of tokens) {
      if (token.type === "operator") {
        currentOperator = token.value;
      } else if (token.type === "condition") {
        const { field, operator, value } = token;
        const condition = this.buildMongoCondition(field, operator, value);

        if (currentOperator === "AND") {
          andConditions.push(condition);
        } else {
          orConditions.push(condition);
        }
      }
    }

    if (andConditions.length > 0) {
      if (andConditions.length === 1) {
        Object.assign(mongoFilter, andConditions[0]);
      } else {
        mongoFilter.$and = andConditions;
      }
    }
    if (orConditions.length > 0) {
      mongoFilter.$or = orConditions;
    }

    return mongoFilter;
  }

  /**
   * Build MongoDB condition from field, operator, value
   */
  private buildMongoCondition(field: string, operator: string, value: any): any {
    const mongoOps: Record<string, string> = {
      "=": "$eq",
      "!=": "$ne",
      ">": "$gt",
      ">=": "$gte",
      "<": "$lt",
      "<=": "$lte",
    };

    const mongoOp = mongoOps[operator];

    // Handle numeric values
    const numValue = Number(value);
    const actualValue = !isNaN(numValue) && typeof value === "number" ? numValue : value;

    if (operator === "=") {
      return { [field]: actualValue };
    }

    return { [field]: { [mongoOp]: actualValue } };
  }

  /**
   * Parse sorting array to MongoDB sort object
   */
  private parseSorting(sort: string[]): Record<string, 1 | -1> {
    const sortParsed = FilterParser.parseSort(sort);
    const sortObj: Record<string, 1 | -1> = {};

    for (const s of sortParsed) {
      sortObj[s.field] = s.direction === "asc" ? 1 : -1;
    }

    return sortObj;
  }
}
