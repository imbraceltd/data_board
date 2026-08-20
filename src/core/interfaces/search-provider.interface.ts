/**
 * Search Provider Interface
 * Abstraction for database-native search implementations
 */

export interface SearchQuery {
  q?: string;
  filter?: string;
  limit?: number;
  offset?: number;
  sort?: string[];
}

export interface SearchResult {
  hits: any[];
  query: string;
  processingTimeMs: number;
  limit: number;
  offset: number;
  estimatedTotalHits: number;
}

export interface MultiSearchQuery {
  indexUid: string; // boardId
  q?: string;
  filter?: string;
  limit?: number;
  offset?: number;
  sort?: string[];
}

export interface MultiSearchResult {
  results: Array<
    SearchResult & {
      indexUid: string;
    }
  >;
}

export interface FetchOptions {
  limit?: number;
  offset?: number;
  filter?: string;
}

export interface FetchResult {
  results: any[];
  offset: number;
  limit: number;
  total: number;
}

/**
 * Search Provider Interface
 * Each database implementation (PostgreSQL, MongoDB, SQLite) must implement this
 */
export interface ISearchProvider {
  search(boardId: string, query: SearchQuery): Promise<SearchResult>;
  multiSearch(queries: MultiSearchQuery[]): Promise<MultiSearchResult>;
  fetch(boardId: string, options: FetchOptions): Promise<FetchResult>;
}

/**
 * Filter token types for parsing Meilisearch-style filters
 */
export interface FilterConditionToken {
  type: "condition";
  field: string;
  operator: string;
  value: any;
}

export interface FilterOperatorToken {
  type: "operator";
  value: "AND" | "OR";
}

export type FilterToken = FilterConditionToken | FilterOperatorToken;
