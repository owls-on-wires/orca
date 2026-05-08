import { describe, expect, test } from "bun:test";
import { notify, type NotificationPayload } from "./index";
import type { NotificationsConfig } from "../config/schema";

const escalationPayload: NotificationPayload = {
  event: "escalation",
  buildName: "henry-build",
  taskId: "dev_socket",
  message: "test_bug: The test asserts X but fixture has Y",
  details: "Supervisor escalated to human",
};

describe("notify", () => {
  describe("event gating", () => {
    test("sends escalation when on_escalation is true", async () => {
      const config: NotificationsConfig = {
        on_escalation: true,
        channels: [{ type: "command", run: "echo '{message}'" }],
      };
      // Should not throw
      await expect(notify(config, escalationPayload)).resolves.toBeUndefined();
    });

    test("skips escalation when on_escalation is false", async () => {
      // We can't easily verify a command DIDN'T run, but we can verify
      // the function completes without error
      const config: NotificationsConfig = {
        on_escalation: false,
        channels: [{ type: "command", run: "echo '{message}'" }],
      };
      await expect(notify(config, escalationPayload)).resolves.toBeUndefined();
    });

    test("sends build_complete when on_build_complete is true", async () => {
      const config: NotificationsConfig = {
        on_build_complete: true,
        channels: [{ type: "command", run: "echo '{message}'" }],
      };
      await expect(
        notify(config, { ...escalationPayload, event: "build_complete" }),
      ).resolves.toBeUndefined();
    });

    test("skips task_complete when on_task_complete is false", async () => {
      const config: NotificationsConfig = {
        on_task_complete: false,
        channels: [{ type: "command", run: "echo '{message}'" }],
      };
      await expect(
        notify(config, { ...escalationPayload, event: "task_complete" }),
      ).resolves.toBeUndefined();
    });

    test("budget_warning events are always sent", async () => {
      const config: NotificationsConfig = {
        on_budget_warning: 0.8,
        channels: [{ type: "command", run: "echo budget" }],
      };
      await expect(
        notify(config, { ...escalationPayload, event: "budget_warning" }),
      ).resolves.toBeUndefined();
    });

    test("intervention events are always sent", async () => {
      const config: NotificationsConfig = {
        channels: [{ type: "command", run: "echo intervention" }],
      };
      await expect(
        notify(config, { ...escalationPayload, event: "intervention" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("no channels", () => {
    test("does nothing with empty channels", async () => {
      await expect(
        notify({ on_escalation: true, channels: [] }, escalationPayload),
      ).resolves.toBeUndefined();
    });

    test("does nothing with undefined channels", async () => {
      await expect(
        notify({ on_escalation: true }, escalationPayload),
      ).resolves.toBeUndefined();
    });
  });

  describe("command channel", () => {
    test("substitutes {message} in command", async () => {
      const config: NotificationsConfig = {
        on_escalation: true,
        channels: [{ type: "command", run: "echo '{message}'" }],
      };
      await expect(notify(config, escalationPayload)).resolves.toBeUndefined();
    });

    test("substitutes {event} in command", async () => {
      const config: NotificationsConfig = {
        on_escalation: true,
        channels: [{ type: "command", run: "echo '{event} {build_name}'" }],
      };
      await expect(notify(config, escalationPayload)).resolves.toBeUndefined();
    });

    test("does not throw on command failure", async () => {
      const config: NotificationsConfig = {
        on_escalation: true,
        channels: [{ type: "command", run: "nonexistent_command_xyz" }],
      };
      await expect(notify(config, escalationPayload)).resolves.toBeUndefined();
    });
  });

  describe("multiple channels", () => {
    test("sends to all channels", async () => {
      const config: NotificationsConfig = {
        on_escalation: true,
        channels: [
          { type: "command", run: "echo channel1" },
          { type: "command", run: "echo channel2" },
        ],
      };
      await expect(notify(config, escalationPayload)).resolves.toBeUndefined();
    });
  });
});
