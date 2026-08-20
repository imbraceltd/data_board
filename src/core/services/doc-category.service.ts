/**
 * Document AI Category Service.
 *
 * Categories form a tree (adjacency list). Public APIs return either a flat
 * list or the materialised tree. Uniqueness scope (per-parent) is enforced
 * here — global vs per-parent is one of the open questions; current behavior
 * is per-parent to allow "Invoices" under both "Sales" and "Finance".
 */

import type { DatabaseClient } from "../../infrastructure/database/types";
import { DocCategoryRepository } from "../../infrastructure/database/repositories/doc-category.repository";
import { DocSchemaRepository } from "../../infrastructure/database/repositories/doc-schema.repository";
import type {
  DocCategory,
  DocCategoryTree,
  DocCategoryType,
  CreateDocCategoryDTO,
  UpdateDocCategoryDTO,
  DocCategoryFilters,
} from "../../domain/shared/doc-category.types";
import {
  NotFoundError,
  ValidationError,
} from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";

export interface DocCategoryServiceConfig {
  db: DatabaseClient;
}

export class DocCategoryService {
  private repo: DocCategoryRepository;
  private schemaRepo: DocSchemaRepository;

  constructor(config: DocCategoryServiceConfig) {
    this.repo = new DocCategoryRepository(config.db);
    this.schemaRepo = new DocSchemaRepository(config.db);
  }

  async getById(id: string): Promise<DocCategory> {
    const c = await this.repo.findById(id);
    if (!c) throw new NotFoundError(`Category ${id} not found`);
    return c;
  }

  /**
   * List categories as a tree. `search` matches any node's name (case-insensitive);
   * matching nodes are returned as roots without ancestors, with their full subtree.
   * `limit`/`skip` apply to top-level results AFTER tree assembly.
   */
  async listAsTree(
    orgId: string,
    filters?: DocCategoryFilters,
  ): Promise<{ data: DocCategoryTree[]; count: number }> {
    // Restrict the flat set to the requested namespace BEFORE assembling the
    // tree — search/limit/skip are still applied in-memory below so the tree
    // shape is preserved. (Passing those to the repo would truncate nodes
    // pre-assembly and orphan their children.)
    const all = await this.repo.findByOrganization(orgId, {
      type: filters?.type,
    });
    const total = await this.repo.count(orgId, filters);

    const tree = buildTree(all);

    let roots: DocCategoryTree[];
    if (filters?.search) {
      const needle = filters.search.toLowerCase();
      roots = collectSearchRoots(tree, needle);
    } else {
      roots = tree;
    }

    const skip = filters?.skip ?? 0;
    const limit = filters?.limit;
    const sliced =
      limit !== undefined ? roots.slice(skip, skip + limit) : roots.slice(skip);

    return { data: sliced, count: total };
  }

  async getTreeFromRoot(id: string): Promise<DocCategoryTree> {
    const root = await this.getById(id);
    const descendants = await this.repo.findByOrganization(root.organization_id);
    const tree = buildTree(descendants, root._id);
    return tree[0] ?? { id: root._id, name: root.name, subCategories: [] };
  }

  /**
   * Idempotent lookup-or-create scoped to a single (org, type, root) triple.
   * Used by the schema/agent linking flow to ensure a default "bucket" category
   * exists for schemas that arrive uncategorised, without forcing callers to
   * pre-flight a separate list+create round trip.
   *
   * Matches root-level only (parent_id IS NULL) — nested same-name categories
   * are intentionally ignored so a "Doc Agent" under a parent doesn't get
   * reused as the default bucket.
   */
  async findOrCreateRoot(
    orgId: string,
    name: string,
    type: DocCategoryType,
  ): Promise<DocCategory> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new ValidationError("Category name is required");
    }
    const candidates = await this.repo.findByOrganization(orgId, { type });
    const existing = candidates.find(
      (c) =>
        c.name === trimmed &&
        (c.parent_id === null || c.parent_id === undefined),
    );
    if (existing) return existing;
    return this.create({
      organization_id: orgId,
      name: trimmed,
      type,
      parentId: null,
    });
  }

  async create(data: CreateDocCategoryDTO): Promise<DocCategory> {
    if (!data.name?.trim()) {
      throw new ValidationError("Category name is required");
    }
    if (data.parentId) {
      const parent = await this.repo.findById(data.parentId);
      if (!parent) {
        throw new NotFoundError(`Parent category ${data.parentId} not found`);
      }
      if (parent.organization_id !== data.organization_id) {
        throw new ValidationError(
          "Parent category belongs to a different organization",
        );
      }
      if (parent.type !== data.type) {
        throw new ValidationError(
          `Parent category is of type "${parent.type}", cannot nest a "${data.type}" category under it`,
        );
      }
    }
    const conflict = await this.repo.findByName(
      data.organization_id,
      data.name.trim(),
      data.parentId ?? null,
      data.type,
    );
    if (conflict) {
      throw new ValidationError(
        `A category named "${data.name}" already exists under this parent`,
      );
    }
    return this.repo.create({ ...data, name: data.name.trim() });
  }

  async update(id: string, data: UpdateDocCategoryDTO): Promise<DocCategory> {
    const existing = await this.getById(id);

    if (data.parentId !== undefined && data.parentId !== existing.parent_id) {
      if (data.parentId) {
        if (data.parentId === id) {
          throw new ValidationError("Category cannot be its own parent");
        }
        const parent = await this.repo.findById(data.parentId);
        if (!parent) {
          throw new NotFoundError(`Parent category ${data.parentId} not found`);
        }
        if (parent.organization_id !== existing.organization_id) {
          throw new ValidationError(
            "Parent category belongs to a different organization",
          );
        }
        if (parent.type !== existing.type) {
          throw new ValidationError(
            `Parent category is of type "${parent.type}", cannot nest a "${existing.type}" category under it`,
          );
        }
        if (await isDescendantOf(this.repo, parent, id)) {
          throw new ValidationError(
            "Cannot move a category under its own descendant (would create a cycle)",
          );
        }
      }
    }

    if (data.name !== undefined && data.name.trim() !== existing.name) {
      const parentId = data.parentId ?? existing.parent_id;
      const conflict = await this.repo.findByName(
        existing.organization_id,
        data.name.trim(),
        parentId,
        existing.type,
      );
      if (conflict && conflict._id !== existing._id) {
        throw new ValidationError(
          `A category named "${data.name}" already exists under this parent`,
        );
      }
    }

    return this.repo.update(id, {
      ...data,
      name: data.name?.trim(),
    });
  }

  /**
   * Delete only the target category. Direct children are preserved and
   * promoted up one level (their parent_id becomes the deleted node's
   * parent_id — null if the deleted node was a root). Schemas attached to
   * the deleted category have their category_id cleared so they fall back
   * to the 'All' tab; schemas under the surviving children are untouched.
   */
  async delete(
    id: string,
  ): Promise<{
    deletedCategoryIds: string[];
    promotedChildIds: string[];
    reassignedSchemaCount: number;
  }> {
    const existing = await this.getById(id);

    const children = await this.repo.findChildren(
      existing.organization_id,
      id,
    );
    for (const child of children) {
      await this.repo.update(child._id, { parentId: existing.parent_id });
    }

    const reassignedSchemaCount = await this.schemaRepo.clearCategoryAssignment(
      existing.organization_id,
      [id],
    );

    await this.repo.delete(id);

    logger.debug(
      `Deleted doc category ${id}; promoted ${children.length} children to parent ${existing.parent_id ?? "<root>"}; reassigned ${reassignedSchemaCount} schemas to 'All'`,
    );
    return {
      deletedCategoryIds: [id],
      promotedChildIds: children.map((c) => c._id),
      reassignedSchemaCount,
    };
  }

  /**
   * Resolve a category id to its descendant set (including itself). Used by the
   * Schema service to filter "all schemas inside this category subtree".
   */
  async getDescendantIds(orgId: string, categoryId: string): Promise<string[]> {
    const all = await this.repo.findByOrganization(orgId);
    return collectDescendantIds(all, categoryId);
  }
}

// ---------------- helpers ----------------

function buildTree(
  flat: DocCategory[],
  rootId?: string,
): DocCategoryTree[] {
  const byParent = new Map<string | null, DocCategory[]>();
  for (const c of flat) {
    const key = c.parent_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }

  const build = (id: string, name: string): DocCategoryTree => ({
    id,
    name,
    subCategories: (byParent.get(id) ?? []).map((child) =>
      build(child._id, child.name),
    ),
  });

  if (rootId) {
    const root = flat.find((c) => c._id === rootId);
    return root ? [build(root._id, root.name)] : [];
  }
  return (byParent.get(null) ?? []).map((c) => build(c._id, c.name));
}

function collectSearchRoots(
  tree: DocCategoryTree[],
  needle: string,
): DocCategoryTree[] {
  const out: DocCategoryTree[] = [];
  const walk = (node: DocCategoryTree) => {
    if (node.name.toLowerCase().includes(needle)) {
      out.push(node);
      return;
    }
    node.subCategories.forEach(walk);
  };
  tree.forEach(walk);
  return out;
}

function collectDescendantIds(
  flat: DocCategory[],
  rootId: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const c of flat) {
    const p = c.parent_id ?? "__root__";
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(c._id);
  }
  const result: string[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    result.push(id);
    const kids = children.get(id) ?? [];
    stack.push(...kids);
  }
  return result;
}

async function isDescendantOf(
  repo: DocCategoryRepository,
  candidate: DocCategory,
  ancestorId: string,
): Promise<boolean> {
  let cur: DocCategory | null = candidate;
  const seen = new Set<string>();
  while (cur && cur.parent_id) {
    if (seen.has(cur._id)) return false; // defensive cycle guard
    seen.add(cur._id);
    if (cur.parent_id === ancestorId) return true;
    cur = await repo.findById(cur.parent_id);
  }
  return false;
}
