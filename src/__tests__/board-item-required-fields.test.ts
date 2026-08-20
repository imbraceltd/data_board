import { describe, it, expect } from "vitest";
import { BoardItemService } from "../core/services/board-item.service";
import { BoardFieldType } from "../domain/shared/board.types";
import { ValidationError } from "../core/validation";

// validateAndProcessFields is pure logic and touches no repository/db, so a
// stub db is enough to exercise it directly.
const service = new BoardItemService({ db: {} as any });
const validate = (board: any, fields: any, op: "create" | "update") =>
  (service as any).validateAndProcessFields(board, fields, op);

// Mirrors the real CRM board: "Name" is the identifier, every column is a
// default template column, several are unique-identifier match keys.
const NAME = "44478dbd-name";
const EMAIL = "f812c482-email";
const PHONE = "b0e0204e-phone";

const camelBoard = {
  id: "board-1",
  fields: [
    {
      id: NAME,
      name: "Name",
      type: BoardFieldType.SHORT_TEXT,
      isDefault: true,
      isIdentifier: true,
      isUniqueIdentifier: false,
    },
    {
      id: EMAIL,
      name: "Email",
      type: BoardFieldType.EMAIL,
      isDefault: true,
      isIdentifier: false,
      isUniqueIdentifier: true,
    },
    {
      id: PHONE,
      name: "Phone",
      type: BoardFieldType.PHONE,
      isDefault: true,
      isIdentifier: false,
      isUniqueIdentifier: true,
    },
  ],
};

// Legacy Mongo-migrated shape: snake_case + `_id`.
const snakeBoard = {
  _id: "board-2",
  fields: [
    {
      _id: NAME,
      name: "Name",
      type: BoardFieldType.SHORT_TEXT,
      is_default: true,
      is_identifier: true,
    },
    {
      _id: EMAIL,
      name: "Email",
      type: BoardFieldType.EMAIL,
      is_default: true,
      is_identifier: false,
    },
  ],
};

describe("validateAndProcessFields — required fields (regression)", () => {
  it("create succeeds with only the identifier (Name) set", async () => {
    const out = await validate(camelBoard, { [NAME]: "Contacts 101" }, "create");
    expect(out[NAME]).toBe("Contacts 101");
  });

  it("create does NOT require default fields other than the identifier (the bug)", async () => {
    // Email/Phone are isDefault + isUniqueIdentifier but must not be required.
    await expect(
      validate(camelBoard, { [NAME]: "Contacts 101" }, "create"),
    ).resolves.toBeDefined();
  });

  it("create fails when the identifier (Name) is missing", async () => {
    await expect(
      validate(camelBoard, { [EMAIL]: "a@b.com" }, "create"),
    ).rejects.toThrow(ValidationError);
    await expect(
      validate(camelBoard, { [EMAIL]: "a@b.com" }, "create"),
    ).rejects.toThrow("Field 'Name' is required");
  });

  it("create fails when the identifier is an empty/whitespace string", async () => {
    await expect(
      validate(camelBoard, { [NAME]: "   " }, "create"),
    ).rejects.toThrow("Field 'Name' is required");
  });

  it("enforces required on legacy snake_case boards via is_identifier", async () => {
    await expect(
      validate(snakeBoard, { [EMAIL]: "a@b.com" }, "create"),
    ).rejects.toThrow("Field 'Name' is required");
    const out = await validate(snakeBoard, { [NAME]: "Legacy" }, "create");
    expect(out[NAME]).toBe("Legacy");
  });

  it("update never enforces required (only create does)", async () => {
    await expect(
      validate(camelBoard, { [EMAIL]: "a@b.com" }, "update"),
    ).resolves.toBeDefined();
  });
});
