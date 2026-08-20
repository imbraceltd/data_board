# Default Document Models (DocIQ cold-start)

These JSON files are the **curated default Document Models** seeded into every
new organization so DocIQ isn't empty on day one (the cold-start problem).

**One file = one Document Model.** They are grouped into one folder per business
pillar:

```
default-doc-schemas/
  g-a/                 finance-accounting/   procurement/
  human-resources/     sales-customers/      general-operations/
  it-security/                               legal-compliance/   marketing/
```

## Add / edit / remove a model — no code change

Adding, editing, or removing a default model is a **pure data change**: add or
delete a `.json` file here. There is **no TypeScript list to update** — the
loader ([`index.ts`](./index.ts)) reads every `*.json` under this folder
recursively at boot, validates it, and the seeder
([`../default-doc-schemas.seeder.service.ts`](../default-doc-schemas.seeder.service.ts))
creates it on org creation.

- **Add a model:** drop a new `<pillar>/<model>.json` (create the pillar folder
  if it's new). The `pillar` value becomes the model's category for the org.
- **Remove a model:** delete its `.json` file.
- **Edit a model:** edit its `.json`.

> Build note: `swc` does not emit `.json` to `dist`, so the
> [Dockerfile](../../../../Dockerfile) COPYies this whole folder into
> `dist/src/core/services/default-doc-schemas/`. That COPY is generic — new
> files are picked up automatically, nothing to edit there either.

## File format

Mirrors the FE **"Build a model"** screen vocabulary:

```jsonc
{
  "pillar": "G&A",                       // → DocCategory (type: "schema") for the org
  "name": "Mutual Non-Disclosure Agreement (MNDA)",  // → schema name
  "objective": "Extract two-way confidentiality terms ...", // → schema description
  "attributes": [
    {
      "name": "Effective Date",          // Attribute Name
      "aiLogic": "Date",                 // AI Logic  → DocAttribute.type (BoardFieldType)
      "extractionPrompt": "Extract ...", // Extraction Prompt → DocAttribute.extractionPrompt
      "roleAccess": "Officer (Level 1)"  // Role access → DocAttribute.role
    },
    {
      "name": "Line Items",
      "aiLogic": "TableInTable",         // nested table
      "extractionPrompt": "Extract each line ...",
      "roleAccess": "Officer (Level 1)",
      "columns": [                       // → settings.columns (child columns)
        { "name": "Description", "aiLogic": "ShortText" },
        { "name": "Amount", "aiLogic": "Currency" }
      ]
    }
  ]
}
```

### Allowed values

- **`aiLogic`** — any `BoardFieldType`
  (`ShortText`, `LongText`, `Number`, `Email`, `Phone`, `Date`, `Datetime`,
  `Time`, `SingleSelection`, `MultipleSelection`, `Currency`, `Link`,
  `Attachment`, `Notes`, `Country`, `Origin`, `Checkbox`, `Rating`,
  `TableInTable`, `Assignee`, `MultipleAssignee`, …). `RichText` is accepted as
  an alias for `LongText`. (`Priority` is excluded for Document Models on the FE.)
- **`roleAccess`** — one of:
  `Officer (Level 1)`, `Asst. Manager (Level 2)`, `Manager (Level 3)`,
  `Director (Level 4)`, `VP (Level 5)`, `Executive (Level 6)`.
- **`columns`** — only meaningful when `aiLogic` is `TableInTable`.

A malformed file is skipped (and logged) at seed time rather than failing org
creation, so one bad addition can't block the whole cold-start seed.
