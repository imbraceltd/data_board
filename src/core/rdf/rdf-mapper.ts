/**
 * Pure mappers from board domain rows to RDF quads.
 *
 * No I/O, no oxigraph Store interaction — these functions are easy to unit
 * test with synthetic data and reused by the graph builder which streams the
 * resulting quads into a Store.
 */

import { quad, blankNode, literal } from "oxigraph";
import type { Quad } from "oxigraph";
import {
  IMB,
  RDF_TYPE,
  XSD,
  iriForBoard,
  iriForItem,
  iriForField,
  toLiteral,
} from "./vocab";

const SELECTION_FIELD_TYPES = new Set<string>([
  "SingleSelection",
  "MultipleSelection",
]);
import { BoardFieldType, type Board } from "../../domain/shared/board.types";
import type {
  BoardItem,
  TableInColumn,
} from "../../domain/shared/board-item.types";

export function boardToQuads(board: Board): Quad[] {
  const out: Quad[] = [];
  const boardId = (board.id ?? board._id) as string;
  const boardIri = iriForBoard(boardId);

  out.push(quad(boardIri, RDF_TYPE, IMB.Board));
  out.push(quad(boardIri, IMB.name, literal(board.name)));
  out.push(quad(boardIri, IMB.type, literal(String(board.type))));
  out.push(
    quad(boardIri, IMB.organizationId, literal(board.organization_id)),
  );
  if (board.description) {
    out.push(quad(boardIri, IMB.description, literal(board.description)));
  }

  for (const f of board.fields ?? []) {
    if (!f?.id) continue;
    const fieldIri = iriForField(boardId, f.id);
    out.push(quad(boardIri, IMB.hasField, fieldIri));
    out.push(quad(fieldIri, RDF_TYPE, IMB.Field));
    out.push(quad(fieldIri, IMB.fieldName, literal(f.name ?? "")));
    out.push(quad(fieldIri, IMB.fieldType, literal(String(f.type))));

    // Identifier flags — only emit when true to keep the graph sparse.
    if (f.isDefault) {
      out.push(quad(fieldIri, IMB.isDefault, literal("true", XSD.boolean)));
    }
    if (f.isUniqueIdentifier) {
      out.push(
        quad(fieldIri, IMB.isUniqueIdentifier, literal("true", XSD.boolean)),
      );
    }
    if (f.isIdentifier) {
      out.push(quad(fieldIri, IMB.isIdentifier, literal("true", XSD.boolean)));
    }

    if (
      f.type === BoardFieldType.TABLE_IN_TABLE &&
      f.settings?.childBoardId
    ) {
      out.push(
        quad(fieldIri, IMB.childBoard, iriForBoard(f.settings.childBoardId)),
      );
    }

    // SingleSelection / MultipleSelection options — one blank node per option.
    if (
      SELECTION_FIELD_TYPES.has(String(f.type)) &&
      Array.isArray(f.data) &&
      f.data.length > 0
    ) {
      for (const opt of f.data) {
        if (!opt?.id) continue;
        const optNode = blankNode();
        out.push(quad(fieldIri, IMB.hasOption, optNode));
        out.push(quad(optNode, IMB.optionId, literal(String(opt.id))));
        out.push(quad(optNode, IMB.optionLabel, literal(String(opt.value ?? ""))));
        if (typeof opt.order === "number") {
          out.push(
            quad(optNode, IMB.optionOrder, literal(String(opt.order), XSD.integer)),
          );
        }
      }
    }
  }
  return out;
}

export function boardItemToQuads(item: BoardItem): Quad[] {
  const out: Quad[] = [];
  const id = (item.id ?? item._id) as string;
  const itemIri = iriForItem(id);

  out.push(quad(itemIri, RDF_TYPE, IMB.BoardItem));
  out.push(quad(itemIri, IMB.belongsToBoard, iriForBoard(item.board_id)));
  if (item.created_at) {
    out.push(
      quad(
        itemIri,
        IMB.createdAt,
        literal(new Date(item.created_at).toISOString(), XSD.dateTime),
      ),
    );
  }
  if (item.updated_at) {
    out.push(
      quad(
        itemIri,
        IMB.updatedAt,
        literal(new Date(item.updated_at).toISOString(), XSD.dateTime),
      ),
    );
  }

  for (const [fieldId, raw] of Object.entries(item.fields ?? {})) {
    const lit = toLiteral(raw);
    if (lit === null) continue;
    const fv = blankNode();
    out.push(quad(itemIri, IMB.fieldValue, fv));
    out.push(quad(fv, IMB.field, iriForField(item.board_id, fieldId)));
    out.push(quad(fv, IMB.value, lit));
  }
  return out;
}

export function tableInColumnToQuads(link: TableInColumn): Quad[] {
  const parentItem = iriForItem(link.parent_board_item_id);
  const childItem = iriForItem(link.child_board_item_id);
  const fieldIri = iriForField(
    link.parent_board_id,
    link.parent_board_field_id,
  );
  return [
    quad(parentItem, IMB.hasChild, childItem),
    quad(childItem, IMB.viaField, fieldIri),
  ];
}
