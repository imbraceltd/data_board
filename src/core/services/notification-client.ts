/**
 * In-app notification client → channel-service.
 *
 * The notifications table lives in channel-service. When a board item's
 * Assignee / MultipleAssignee field gains a user, we POST a CRM_ASSIGN (101)
 * notification to channel-service's internal create endpoint
 * (`POST /internal/notifications`, no user auth, over the internal network).
 *
 * Fire-and-forget: a notification failure must never break the board-item
 * mutation, so callers should not await / should swallow errors.
 */
import config from "../../config";
import logger from "../../infrastructure/logging/logger";

// Frontend contract — keep in sync with channel-service notification-types and
// the monolith NotificationsTypeEnum.
export const NotificationType = {
  CRM_ASSIGN: 101,
} as const;

export interface NotificationPayload {
  type: number;
  recipient: string;
  from?: string;
  title?: string;
  content?: string;
  action_to?: Record<string, unknown>;
}

export async function createNotifications(
  orgId: string,
  payload: NotificationPayload | NotificationPayload[],
): Promise<void> {
  try {
    await fetch(`${config.channelServiceUrl}/internal/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-organization-id": orgId },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logger.warn(`createNotifications failed: ${(err as Error).message}`);
  }
}
