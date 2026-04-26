import type { SessionStatus } from "./types.js";

export type NotificationPermissionState = "default" | "granted" | "denied";

export function getPermissionState(): NotificationPermissionState {
  if (!("Notification" in window)) return "denied";
  return Notification.permission as NotificationPermissionState;
}

export async function requestPermission(): Promise<NotificationPermissionState> {
  if (!("Notification" in window)) return "denied";
  if (Notification.permission !== "default") {
    return Notification.permission as NotificationPermissionState;
  }
  const result = await Notification.requestPermission();
  return result as NotificationPermissionState;
}

interface NotifyArgs {
  title: string;
  body: string;
  onClick?: () => void;
  tag?: string;
}

export function notify({ title, body, onClick, tag }: NotifyArgs): void {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const n = new Notification(title, {
    body,
    tag,
    silent: false,
  });
  if (onClick) {
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  }
}

export function shouldNotifyOnStatusChange(
  prev: SessionStatus | undefined,
  next: SessionStatus,
): boolean {
  if (prev === next) return false;
  if (next === "asking") return true;
  if (next === "idle" && prev === "working") return true;
  return false;
}
