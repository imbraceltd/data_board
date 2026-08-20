/**
 * Default CRM boards seeded for every new organization.
 *
 * Ported from legacy `backend/src/models/v2/model/board.js:311` (Board.generateDefault).
 * That MongoDB seed step used to run on org creation via the legacy backend's
 * Organization facade; it was dropped when prodv2 cut org-create over to
 * platform-service, leaving new orgs with zero boards. Re-introducing it here
 * so platform-service can call /api/v1/boards/_seed_default after creating
 * the org skeleton.
 *
 * Field shape uses camelCase to match BoardField interface + Mongoose model
 * (the POST /boards endpoint stores the same shape). Older boards migrated
 * from Mongo carry snake_case keys; readers downstream tolerate both.
 */

import { BoardType, BoardFieldType } from "../../domain/shared/board.types";

interface SeedFieldData {
  value: string;
}

interface SeedField {
  name: string;
  type: BoardFieldType;
  description?: string;
  isDefault?: boolean;
  isIdentifier?: boolean;
  isUniqueIdentifier?: boolean;
  defaultFieldName?: string;
  contactField?: string;
  data?: SeedFieldData[];
  settings?: Record<string, unknown>;
}

export interface DefaultBoardTemplate {
  name: string;
  description: string;
  type: BoardType;
  order: number;
  fields: SeedField[];
}

export const DEFAULT_BOARD_TEMPLATES: DefaultBoardTemplate[] = [
  {
    name: "Contacts",
    description: "All engaged customers and potential leads",
    type: BoardType.CONTACTS,
    order: 1,
    fields: [
      {
        name: "Name",
        type: BoardFieldType.SHORT_TEXT,
        contactField: "display_name",
        isDefault: true,
        isIdentifier: true,
        defaultFieldName: "name",
        description: "Name of the customer",
      },
      {
        name: "Email",
        type: BoardFieldType.EMAIL,
        contactField: "email",
        isUniqueIdentifier: true,
        isDefault: true,
        defaultFieldName: "email",
        description:
          "Email collected through conversation or entered by user/automations",
      },
      {
        name: "Phone",
        type: BoardFieldType.PHONE,
        contactField: "phone_number",
        isUniqueIdentifier: true,
        isDefault: true,
        defaultFieldName: "phone",
        settings: { default_country_code: "HK" },
        description:
          "Phone number collected through conversation or entered by user/automations",
      },
      {
        name: "Company",
        type: BoardFieldType.SHORT_TEXT,
        contactField: "company_name",
        isDefault: true,
        defaultFieldName: "company",
        description: "Where the customer works at",
      },
      {
        name: "Position",
        type: BoardFieldType.SHORT_TEXT,
        contactField: "position",
        isDefault: true,
        defaultFieldName: "position",
        description: "What the customer do in their company",
      },
      {
        name: "Location",
        type: BoardFieldType.SHORT_TEXT,
        contactField: "location",
        isDefault: true,
        defaultFieldName: "location",
        description: "Geological location",
      },
      {
        name: "Birthday",
        type: BoardFieldType.DATE,
        contactField: "birthday",
        isDefault: true,
        defaultFieldName: "birthday",
        description: "Date of the birth",
      },
      {
        name: "Gender",
        type: BoardFieldType.SINGLE_SELECTION,
        contactField: "gender",
        isDefault: true,
        data: [{ value: "Male" }, { value: "Female" }, { value: "Neutral" }],
        defaultFieldName: "gender",
        description: "Self-identified gender by the customer",
      },
      {
        name: "Title",
        type: BoardFieldType.SINGLE_SELECTION,
        contactField: "title",
        isDefault: true,
        data: [
          { value: "Mr." },
          { value: "Ms." },
          { value: "Mrs." },
          { value: "Miss." },
          { value: "Mx." },
        ],
        defaultFieldName: "title",
        description: "Preferred prefix",
      },
      {
        name: "WhatsApp ID",
        type: BoardFieldType.SHORT_TEXT,
        contactField: "whatsapp_id",
        isUniqueIdentifier: true,
        isDefault: true,
        defaultFieldName: "whatsapp_id",
        description:
          "Number for WhatsApp collected through conversation or entered by user/automations",
      },
      {
        name: "WeChat ID",
        type: BoardFieldType.SHORT_TEXT,
        contactField: "wechat_id",
        isUniqueIdentifier: true,
        isDefault: true,
        defaultFieldName: "wechat_id",
        description:
          "WeChat ID collected through conversation or entered by user/automations",
      },
      {
        name: "LINE ID",
        type: BoardFieldType.SHORT_TEXT,
        contactField: "line_id",
        isUniqueIdentifier: true,
        isDefault: true,
        defaultFieldName: "line_id",
        description:
          "LINE ID collected through conversation or entered by user/automations",
      },
      {
        name: "Facebook ID",
        type: BoardFieldType.SHORT_TEXT,
        contactField: "facebook_id",
        isUniqueIdentifier: true,
        isDefault: true,
        defaultFieldName: "facebook_id",
        description:
          "Facebook user name collected through conversation or entered by user/automations",
      },
      {
        name: "Joined Since",
        type: BoardFieldType.DATE,
        contactField: "created_at",
        isDefault: true,
        defaultFieldName: "created_at",
        description:
          "The first date when the customer interact with the business",
      },
      {
        name: "Last Active",
        type: BoardFieldType.DATE,
        contactField: "last_seen",
        isDefault: true,
        defaultFieldName: "last_seen",
        description:
          "The latest time when the customer interact with the business",
      },
      {
        name: "Stage",
        type: BoardFieldType.SINGLE_SELECTION,
        isDefault: true,
        defaultFieldName: "stage",
        data: [
          { value: "Unidentified Lead" },
          { value: "Identified Lead" },
          { value: "Contact" },
          { value: "Prospect" },
          { value: "Customer" },
          { value: "Advocator" },
          { value: "Disqualified" },
          { value: "Retention" },
        ],
        description: "What status is the customer in the life cycle",
      },
      {
        name: "Remarks",
        type: BoardFieldType.LONG_TEXT,
        isDefault: true,
        defaultFieldName: "remarks",
        description: "Notes",
      },
      {
        name: "Tags",
        type: BoardFieldType.MULTI_SELECTION,
        isDefault: true,
        defaultFieldName: "tags",
        data: [
          { value: "VIP" },
          { value: "New" },
          { value: "Follow-up Needed" },
          { value: "Referred" },
        ],
        description: "Categories of the customer",
      },
      {
        name: "Opt-Out Status",
        type: BoardFieldType.SINGLE_SELECTION,
        isDefault: true,
        data: [{ value: "Opt-In" }, { value: "Opt-Out" }],
        defaultFieldName: "opt_out_status",
        description:
          "The opt-in/opt-out status of business activities (ex. outbounds, newsletters, re-engagements). If the field is empty, the customer will be considered a passive opt-in and still receive updates.",
      },
      {
        name: "Origin",
        type: BoardFieldType.ORIGIN,
        isDefault: true,
        defaultFieldName: "origin",
        description: "Where this contact comes from",
      },
      {
        name: "Assignee",
        description: "Internally who is responsible for this contact",
        type: BoardFieldType.ASSIGNEE,
        isDefault: true,
        defaultFieldName: "assignee",
      },
      {
        name: "MultipleAssignees",
        description: "Internally who is responsible for this contact",
        type: BoardFieldType.MULTI_ASSIGNEE,
        isDefault: true,
        defaultFieldName: "multiple_assignee",
      },
    ],
  },
  {
    name: "Companies",
    description: "All companies that encountered individuals worked at",
    type: BoardType.COMPANIES,
    order: 2,
    fields: [
      {
        name: "Name",
        description: "Name of the company",
        type: BoardFieldType.SHORT_TEXT,
        isDefault: true,
        isIdentifier: true,
        defaultFieldName: "name",
      },
      {
        name: "Industry",
        description: "The headquarter of the company",
        type: BoardFieldType.SHORT_TEXT,
        isDefault: true,
        defaultFieldName: "industry",
      },
      {
        name: "Size",
        description: "Which industry is the company in",
        type: BoardFieldType.SINGLE_SELECTION,
        isDefault: true,
        data: [
          { value: "1-20 employees" },
          { value: "21-50 employees" },
          { value: "51-100 employees" },
          { value: "101-500 employees" },
          { value: "501-1000 employees" },
          { value: "Over 1000 employees" },
        ],
        defaultFieldName: "size",
      },
      {
        name: "Location",
        description: "Company size",
        type: BoardFieldType.SHORT_TEXT,
        isDefault: true,
        defaultFieldName: "location",
      },
      {
        name: "Address",
        description: "Company office address",
        type: BoardFieldType.LONG_TEXT,
        isDefault: true,
        defaultFieldName: "address",
      },
      {
        name: "Website",
        description: "Company office website link",
        type: BoardFieldType.LINK,
        isDefault: true,
        defaultFieldName: "website",
      },
      {
        name: "Linkedin",
        description: "Company office Linkedin profile link",
        type: BoardFieldType.LINK,
        isDefault: true,
        defaultFieldName: "linkedin",
      },
      {
        name: "Remarks",
        description: "Notes",
        type: BoardFieldType.LONG_TEXT,
        isDefault: true,
        defaultFieldName: "remarks",
      },
      {
        name: "Initial Contact",
        description: "The first date interacting with the business",
        type: BoardFieldType.DATE,
        isDefault: true,
        defaultFieldName: "initial_contact",
      },
      {
        name: "Tags",
        description: "Categories of the company",
        type: BoardFieldType.MULTI_SELECTION,
        isDefault: true,
        defaultFieldName: "tags",
        data: [
          { value: "Micros" },
          { value: "SMEs" },
          { value: "Enterprises" },
          { value: "NPOs" },
        ],
      },
      {
        name: "Notes",
        description: "Internal team posted notes with timestamps",
        type: BoardFieldType.NOTES,
        isDefault: true,
        defaultFieldName: "notes",
      },
    ],
  },
  {
    name: "Opportunities",
    description: "Deals progress tracking and updates",
    type: BoardType.OPPORTUNITIES,
    order: 3,
    fields: [
      {
        name: "Name",
        description: "Name of the opportunities and deals",
        type: BoardFieldType.SHORT_TEXT,
        isDefault: true,
        isIdentifier: true,
        defaultFieldName: "name",
      },
      {
        name: "Stage",
        description: "What status is this deal in the pipeline",
        type: BoardFieldType.SINGLE_SELECTION,
        isDefault: true,
        defaultFieldName: "stage",
        data: [
          { value: "Prospecting" },
          { value: "Qualified" },
          { value: "Initial Meeting" },
          { value: "Proposal" },
          { value: "Negotiation" },
          { value: "Closing" },
          { value: "Retention" },
          { value: "Disqualified" },
        ],
      },
      {
        name: "Assignee",
        description: "Internally who is responsible for this task",
        type: BoardFieldType.MULTI_ASSIGNEE,
        isDefault: true,
        defaultFieldName: "multiple_assignee",
      },
      {
        name: "Type",
        description: "What types of task this is",
        type: BoardFieldType.MULTI_SELECTION,
        isDefault: true,
        defaultFieldName: "type",
        data: [{ value: "Insurance" }, { value: "Follow-Up" }],
      },
      {
        name: "Owner",
        description: "Internally who is responsible for this opportunity",
        type: BoardFieldType.ASSIGNEE,
        isDefault: true,
        defaultFieldName: "owner",
      },
      {
        name: "Priority",
        description: "How important is this opportunity",
        type: BoardFieldType.PRIORITY,
        isDefault: true,
        defaultFieldName: "priority",
        data: [
          { value: "Low" },
          { value: "Medium" },
          { value: "High" },
          { value: "Very High" },
        ],
      },
      {
        name: "Est. Value",
        description: "The estimated value this opportunity can bring",
        type: BoardFieldType.CURRENCY,
        isDefault: true,
        defaultFieldName: "estimated_value",
        settings: { default_currency_code: "HKD" },
      },
      {
        name: "Last Contact",
        description: "The latest time interacting with the business",
        type: BoardFieldType.DATE,
        isDefault: true,
        defaultFieldName: "last_contact",
      },
      {
        name: "Remarks",
        description: "Notes",
        type: BoardFieldType.LONG_TEXT,
        isDefault: true,
        defaultFieldName: "remarks",
      },
      {
        name: "Contact Record",
        description: "Link to the associated Contact record",
        type: BoardFieldType.LINK,
        isDefault: true,
        defaultFieldName: "contact_record",
      },
    ],
  },
  {
    name: "Opt-out",
    description: "List of users decided to not receive any email/notification",
    type: BoardType.OPT_OUT,
    order: 4,
    fields: [
      {
        name: "Opt-out Service ID",
        description: "Service ID of the unsubscription",
        type: BoardFieldType.SHORT_TEXT,
        isDefault: true,
        isIdentifier: true,
        defaultFieldName: "service_id",
      },
      {
        name: "Opt-out Services",
        description: "Service/Platform of the unsubscription",
        type: BoardFieldType.SHORT_TEXT,
        isDefault: true,
        defaultFieldName: "service",
      },
      {
        name: "Name",
        description: "Name of the user",
        type: BoardFieldType.SHORT_TEXT,
        isDefault: true,
        defaultFieldName: "name",
      },
    ],
  },
  {
    name: "Tasks",
    description: "Dedicated to internal collaboration and task management",
    type: BoardType.TASKS,
    order: 5,
    fields: [
      {
        name: "Name",
        description: "Title of the tasks",
        type: BoardFieldType.SHORT_TEXT,
        isDefault: true,
        isIdentifier: true,
        defaultFieldName: "name",
      },
      {
        name: "Description",
        description: "Details and requirements of the tasks",
        type: BoardFieldType.LONG_TEXT,
        isDefault: true,
        defaultFieldName: "description",
      },
      {
        name: "Status",
        description: "What is the progress and status of the tasks",
        type: BoardFieldType.SINGLE_SELECTION,
        isDefault: true,
        defaultFieldName: "status",
        data: [
          { value: "Backlogs" },
          { value: "To-Dos" },
          { value: "In-Progress" },
          { value: "In-Review" },
          { value: "Done" },
        ],
      },
      {
        name: "Assignee",
        description: "Internally who is responsible for this task",
        type: BoardFieldType.MULTI_ASSIGNEE,
        isDefault: true,
        defaultFieldName: "multiple_assignee",
      },
      {
        name: "Priority",
        description: "How important is this task",
        type: BoardFieldType.PRIORITY,
        isDefault: true,
        defaultFieldName: "priority",
        data: [
          { value: "Low" },
          { value: "Medium" },
          { value: "High" },
          { value: "Very High" },
        ],
      },
      {
        name: "Due Date",
        description: "When this task is expected to be delivered",
        type: BoardFieldType.DATE,
        isDefault: true,
        defaultFieldName: "due_date",
      },
      {
        name: "Opportunity Record",
        description: "Link to the associated Opportunity record",
        type: BoardFieldType.LINK,
        isDefault: true,
        defaultFieldName: "opportunity_record",
      },
      {
        name: "Contact Record",
        description: "Link to the associated Contact record",
        type: BoardFieldType.LINK,
        isDefault: true,
        defaultFieldName: "contact_record",
      },
      {
        name: "Type",
        description: "What types of task this is",
        type: BoardFieldType.MULTI_SELECTION,
        isDefault: true,
        defaultFieldName: "type",
        data: [
          { value: "Follow-ups" },
          { value: "Outreach" },
          { value: "Support" },
        ],
      },
      {
        name: "Notes",
        description: "Internal team posted notes with timestamps",
        type: BoardFieldType.NOTES,
        isDefault: true,
        defaultFieldName: "notes",
      },
    ],
  },
  {
    // Migrated MongoDB boards use the string "Products" (e.g. Taknet's Product
    // board), but data-board's BoardType enum doesn't list it. Cast to keep
    // the legacy type string for shape parity with pre-cutover orgs.
    name: "Product",
    description: "Up-to-date product list and catalogue",
    type: "Products" as BoardType,
    order: 6,
    fields: [
      {
        name: "Name",
        description: "Name of the products",
        type: BoardFieldType.SHORT_TEXT,
        isDefault: true,
        isIdentifier: true,
        defaultFieldName: "name",
      },
      {
        name: "Description",
        description: "Details of the product",
        type: BoardFieldType.LONG_TEXT,
        isDefault: true,
        defaultFieldName: "description",
      },
      {
        name: "Unit Price",
        description: "The unit price of the product",
        type: BoardFieldType.CURRENCY,
        isDefault: true,
        defaultFieldName: "unit_price",
        settings: { default_currency_code: "HKD" },
      },
      {
        name: "Currency",
        description: "The currency that the product price in",
        type: BoardFieldType.SHORT_TEXT,
        isDefault: true,
        defaultFieldName: "currency",
      },
      {
        name: "Tags",
        description: "The product categories",
        type: BoardFieldType.MULTI_SELECTION,
        isDefault: true,
        defaultFieldName: "tags",
        data: [
          { value: "Featured" },
          { value: "New" },
          { value: "Sales" },
          { value: "Upcoming" },
        ],
      },
      {
        name: "In Stock",
        description: "How many units of the product we have in stock",
        type: BoardFieldType.NUMBER,
        isDefault: true,
        defaultFieldName: "in_stock",
      },
      {
        name: "Sold",
        type: BoardFieldType.NUMBER,
        isDefault: true,
        defaultFieldName: "sold",
      },
      {
        name: "Notes",
        description: "Internal team posted notes with timestamps",
        type: BoardFieldType.NOTES,
        isDefault: true,
        defaultFieldName: "notes",
      },
    ],
  },
];
