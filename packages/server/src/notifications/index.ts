/**
 * Notification dispatcher — sends alerts via command channel.
 *
 * The command channel runs an arbitrary shell command with template
 * variables substituted. This covers all notification backends:
 * - Mobile:  curl -s -d '{message}' https://ntfy.sh/myproject-a1b2c3
 * - Slack:   curl -X POST -d '{"text":"{message}"}' $SLACK_WEBHOOK
 */

import type { NotificationsConfig, NotificationChannel } from "../config/schema";

export type NotificationEvent = "build_start" | "task_start" | "escalation" | "task_complete" | "build_complete" | "budget_warning" | "intervention" | "stage_error";

export interface NotificationPayload {
  event: NotificationEvent;
  buildName: string;
  taskId?: string;
  message: string;
  details?: string;
}

export async function notify(
  config: NotificationsConfig,
  payload: NotificationPayload,
): Promise<void> {
  if (!config.channels?.length) return;

  const enabled =
    (payload.event === "build_start" && config.on_build_start) ||
    (payload.event === "task_start" && config.on_task_start) ||
    (payload.event === "escalation" && config.on_escalation) ||
    (payload.event === "task_complete" && config.on_task_complete) ||
    (payload.event === "build_complete" && config.on_build_complete) ||
    (payload.event === "intervention") ||
    (payload.event === "budget_warning") ||
    (payload.event === "stage_error");

  if (!enabled) return;

  await Promise.allSettled(
    config.channels.map((ch) => runCommand(ch.run, payload)),
  );
}

async function runCommand(command: string, payload: NotificationPayload): Promise<void> {
  // Substitute template variables
  const rendered = command
    .replaceAll("{message}", payload.message)
    .replaceAll("{event}", payload.event)
    .replaceAll("{build_name}", payload.buildName)
    .replaceAll("{task_id}", payload.taskId ?? "")
    .replaceAll("{details}", payload.details ?? "");

  const proc = Bun.spawn(["sh", "-c", rendered], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}
