/**
 * Field Validation Utilities
 * Validators for different board field types
 */

import { BoardFieldType } from "../../domain/shared/board.types";

/**
 * Time validation — accepts HH:mm or HH:mm:ss (24-hour). Examples:
 * "09:30", "23:59:59", "00:00". Rejects "9:30", "9:30am", "24:00".
 */
export function validateTime(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value.trim());
}

/**
 * Email validation
 */
export function validateEmail(email: string): boolean {
  if (!email || typeof email !== "string") return false;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Phone number validation (basic international format)
 */
export function validatePhoneNumber(phone: string): boolean {
  if (!phone || typeof phone !== "string") return false;

  // Allow digits, spaces, hyphens, parentheses, and plus sign
  const phoneRegex = /^[\d\s\-\(\)\+]{7,20}$/;
  return phoneRegex.test(phone.trim());
}

/**
 * URL validation
 */
export function validateURL(url: string): boolean {
  if (!url || typeof url !== "string") return false;

  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Date validation and parsing
 */
export function validateDate(value: any): Date | null {
  if (!value) return null;

  // If already a Date object
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }

  // Try parsing as string
  if (typeof value === "string") {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  // Try parsing as timestamp
  if (typeof value === "number") {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  return null;
}

/**
 * Number validation
 */
export function validateNumber(value: any): number | null {
  if (value === null || value === undefined || value === "") return null;

  const num = typeof value === "string" ? parseFloat(value) : Number(value);
  return isNaN(num) ? null : num;
}

/**
 * Validate field value based on field type
 */
export function validateFieldValue(
  fieldType: BoardFieldType,
  value: any,
): { valid: boolean; error?: string } {
  // Handle empty values
  if (value === null || value === undefined || value === "") {
    return { valid: true }; // Empty values are allowed (required check is separate)
  }

  switch (fieldType) {
    case BoardFieldType.EMAIL:
      if (!validateEmail(value)) {
        return { valid: false, error: "Invalid email format" };
      }
      break;

    case BoardFieldType.PHONE:
      if (!validatePhoneNumber(value)) {
        return { valid: false, error: "Invalid phone number format" };
      }
      break;

    case BoardFieldType.LINK:
      if (!validateURL(value)) {
        return { valid: false, error: "Invalid URL format" };
      }
      break;

    case BoardFieldType.DATE:
    case BoardFieldType.DATETIME:
      if (!validateDate(value)) {
        return { valid: false, error: "Invalid date format" };
      }
      break;

    case BoardFieldType.TIME:
      if (!validateTime(value)) {
        return { valid: false, error: "Invalid time format (expected HH:mm or HH:mm:ss)" };
      }
      break;

    case BoardFieldType.NUMBER:
    case BoardFieldType.CURRENCY:
    case BoardFieldType.RATING:
      if (validateNumber(value) === null) {
        return { valid: false, error: "Invalid number format" };
      }
      break;

    case BoardFieldType.CHECKBOX:
      if (typeof value !== "boolean" && value !== "true" && value !== "false") {
        return { valid: false, error: "Invalid boolean value" };
      }
      break;

    case BoardFieldType.SINGLE_SELECTION:
    case BoardFieldType.MULTI_SELECTION:
    case BoardFieldType.PRIORITY:
      // These require field.data for validation, handled separately by
      // validateSelectOption / validateMultiSelectOptions in the caller.
      break;

    default:
      // Other types (ShortText, LongText, Notes, Country, Origin, Assignee,
      // MultipleAssignee, Attachment, MapToBoard, TableInTable, Formula)
      // accept any value at this layer.
      break;
  }

  return { valid: true };
}

/**
 * Format phone number to international format
 */
export function formatPhoneNumber(phone: string, countryCode?: string): string {
  if (!phone) return "";

  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, "");

  // Add country code if provided and not already present
  if (countryCode && !digits.startsWith(countryCode)) {
    return `+${countryCode}${digits}`;
  }

  return digits.startsWith("+") ? digits : `+${digits}`;
}

/**
 * Sanitize text input (remove potentially harmful content)
 */
export function sanitizeText(text: string): string {
  if (!text || typeof text !== "string") return "";

  // Basic XSS prevention - remove script tags and event handlers
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, "")
    .trim();
}

/**
 * Validate required field
 */
export function validateRequired(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/**
 * Validate field against select options
 */
export function validateSelectOption(
  value: string,
  options: Array<{ id?: string; value: string }>,
): boolean {
  if (!value || !options || options.length === 0) return true;
  // Compare option labels whitespace-insensitively so a stray leading/trailing
  // space in either the stored option value or the incoming value does not
  // cause a false "invalid option" rejection. Ids are UUIDs — match exactly.
  const v = typeof value === "string" ? value.trim() : value;
  return options.some(
    (opt) => opt.id === value || (opt.value ?? "").trim() === v,
  );
}

/**
 * Validate multi-select options
 */
export function validateMultiSelectOptions(
  values: string[],
  options: Array<{ id?: string; value: string }>,
): boolean {
  if (!values || !Array.isArray(values)) return false;
  if (values.length === 0) return true;

  // Match labels whitespace-insensitively (see validateSelectOption); ids exact.
  const validIds = new Set(options.map((opt) => opt.id).filter(Boolean));
  const validValues = new Set(options.map((opt) => (opt.value ?? "").trim()));

  return values.every(
    (val) =>
      validIds.has(val) ||
      validValues.has(typeof val === "string" ? val.trim() : val),
  );
}
