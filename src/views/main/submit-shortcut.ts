import type { ChatSubmitShortcut } from "../../shared/settings-types";

type TextAreaSubmitEvent = {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  nativeEvent?: { isComposing?: boolean };
};

export function shouldSubmitTextArea(event: TextAreaSubmitEvent, submitShortcut: ChatSubmitShortcut) {
  if (event.key !== "Enter" || event.nativeEvent?.isComposing) return false;
  if (submitShortcut === "enter") return !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
}
