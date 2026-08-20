/**
 * Per-field-type metadata for `GET /boards/model-schema`.
 *
 * Ported from legacy backend `controllers/board.js#getFieldTypeInfo` so the
 * response shape stays identical for FE callers. Includes Formula + Rating
 * which the legacy enum didn't have; drops RichText + Time which data_board's
 * `BoardFieldType` doesn't expose.
 *
 *   text       — i18n key the FE uses to render the type label
 *   has_data   — does the field carry an options list (`data[]`)
 *   settings   — schema for the per-field-type `settings` object
 *   structure  — extra docs (only set for TableInTable)
 */

import { BoardFieldType } from "../../domain/shared/board.types";

export interface FieldTypeInfo {
  text: string;
  has_data: boolean;
  settings: Record<string, unknown>;
  structure?: Record<string, unknown>;
}

const FIELD_INFO: Record<BoardFieldType, FieldTypeInfo> = {
  [BoardFieldType.SHORT_TEXT]: {
    text: "field_short_text",
    has_data: false,
    settings: {},
  },
  [BoardFieldType.LONG_TEXT]: {
    text: "field_long_text",
    has_data: false,
    settings: {},
  },
  [BoardFieldType.SINGLE_SELECTION]: {
    text: "field_single_selection",
    has_data: true,
    settings: {},
  },
  [BoardFieldType.MULTI_SELECTION]: {
    text: "field_multiple_selection",
    has_data: true,
    settings: {},
  },
  [BoardFieldType.NUMBER]: {
    text: "field_number",
    has_data: false,
    settings: {},
  },
  [BoardFieldType.DATE]: {
    text: "field_date",
    has_data: false,
    settings: {
      time_zone: {
        type: "String",
        description: "Timezone for display (e.g. Asia/Hong_Kong)",
      },
      enable_timezone: {
        type: "Boolean",
        description: "Show timezone selector in UI",
      },
    },
  },
  [BoardFieldType.DATETIME]: {
    text: "field_datetime",
    has_data: false,
    settings: {
      time_zone: { type: "String", description: "Timezone for display" },
      enable_timezone: {
        type: "Boolean",
        description: "Show timezone selector in UI",
      },
    },
  },
  [BoardFieldType.EMAIL]: {
    text: "field_email",
    has_data: false,
    settings: {},
  },
  [BoardFieldType.PHONE]: {
    text: "field_phone",
    has_data: false,
    settings: {
      default_country_code: {
        type: "String",
        description: "Default country dial code (e.g. HK, US)",
      },
    },
  },
  [BoardFieldType.LINK]: {
    text: "field_link",
    has_data: false,
    settings: {},
  },
  [BoardFieldType.CHECKBOX]: {
    text: "field_checkbox",
    has_data: false,
    settings: {},
  },
  [BoardFieldType.COUNTRY]: {
    text: "field_country",
    has_data: false,
    settings: {},
  },
  [BoardFieldType.PRIORITY]: {
    text: "field_priority",
    has_data: true,
    settings: {},
  },
  [BoardFieldType.ASSIGNEE]: {
    text: "field_assignee",
    has_data: false,
    settings: {},
  },
  [BoardFieldType.MULTI_ASSIGNEE]: {
    text: "field_multiple_assignee",
    has_data: false,
    settings: {},
  },
  [BoardFieldType.ORIGIN]: {
    text: "field_origin",
    has_data: false,
    settings: {},
  },
  [BoardFieldType.ATTACHMENT]: {
    text: "field_attachment",
    has_data: false,
    settings: {},
  },
  [BoardFieldType.NOTES]: {
    text: "field_notes",
    has_data: false,
    settings: {},
  },
  [BoardFieldType.CURRENCY]: {
    text: "field_currency",
    has_data: false,
    settings: {
      default_currency_code: {
        type: "String",
        description: "Default currency code (e.g. HKD, USD)",
      },
    },
  },
  [BoardFieldType.MAP_TO_BOARD]: {
    text: "field_map_to_board",
    has_data: true,
    settings: {},
  },
  [BoardFieldType.TABLE_IN_TABLE]: {
    text: "field_table_in_table",
    has_data: true,
    settings: {},
    structure: {
      data: {
        description:
          "Reference to the child board. data[0]._id is the child board ID.",
        example: [{ _id: "brd_child_xxx", value: "brd_child_xxx" }],
      },
      child_board_fields: {
        description:
          "Fields of the child board — injected automatically when reading the parent board (GET /api/boards/:id). Each item has the same structure as a normal board_field.",
        example: [
          { _id: "fld_aaa", name: "Item Name", type: "ShortText" },
          { _id: "fld_bbb", name: "Quantity", type: "Number" },
        ],
      },
      item_value: {
        description:
          "Value stored in a board_item for this field — array of child board_item IDs.",
        example: ["bi_111", "bi_222"],
      },
      child_board: {
        description:
          "The child board is a separate Board document with is_child_table: true. It is auto-created and not shown in the main board list.",
      },
      create_field: {
        description:
          'When creating a TableInTable field, pass a "fields" array to define the child board columns.',
        example: {
          name: "My Table",
          type: "TableInTable",
          fields: [
            { name: "Item Name", type: "ShortText" },
            { name: "Quantity", type: "Number" },
          ],
        },
      },
    },
  },
  [BoardFieldType.FORMULA]: {
    text: "field_formula",
    has_data: false,
    settings: {
      expression: {
        type: "String",
        description: "Formula expression — references other fields by name",
      },
    },
  },
  [BoardFieldType.RATING]: {
    text: "field_rating",
    has_data: false,
    settings: {
      max: { type: "Number", description: "Upper bound of the rating scale (default 5)" },
    },
  },
};

export function getFieldTypeInfo(fieldType: BoardFieldType): FieldTypeInfo {
  return (
    FIELD_INFO[fieldType] ?? {
      text: "Unknown",
      has_data: false,
      settings: {},
    }
  );
}
