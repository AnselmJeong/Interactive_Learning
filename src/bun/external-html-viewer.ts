import { BrowserWindow, Screen } from "electrobun/bun";
import { getMaterialAnnotation } from "./annotation-store";
import { validateExternalHtmlAttachment } from "./external-html-import-service";
import { ExternalHtmlRuntimeServer } from "./external-html-runtime-server";

export class ExternalHtmlViewer {
  private readonly runtime = new ExternalHtmlRuntimeServer();
  private active: { id: string; window: BrowserWindow } | null = null;

  async open(annotationId: string, attachmentId: string) {
    const annotation = getMaterialAnnotation(annotationId);
    if (!annotation) throw new Error("Annotation not found");
    const attachment = (annotation.attachments || []).find((item) => item.kind === "external_html" && item.id === attachmentId);
    if (!attachment || attachment.kind !== "external_html") throw new Error("External HTML attachment not found");
    const validated = await validateExternalHtmlAttachment(annotation, attachment);
    this.close();
    const viewerId = crypto.randomUUID();
    const grant = this.runtime.issue(viewerId, validated.runnable);
    const display = Screen.getPrimaryDisplay().workArea;
    const width = Math.max(720, Math.min(1180, Math.max(720, display.width - 96)));
    const height = Math.max(520, Math.min(820, Math.max(520, display.height - 96)));
    const x = display.x + Math.max(24, Math.round((display.width - width) / 2));
    const y = display.y + Math.max(24, Math.round((display.height - height) / 2));
    const navigationRules = ["^*", grant.url];
    const window = new BrowserWindow({
      title: attachment.title,
      url: grant.url,
      frame: { width, height, x, y },
      titleBarStyle: "default",
      sandbox: true,
      navigationRules: JSON.stringify(navigationRules),
    });
    // Constructor rules protect the initial navigation. Reapply them through the
    // public API so every later navigation attempt uses the same exact allowlist.
    window.webview.setNavigationRules(navigationRules);
    this.active = { id: viewerId, window };
    window.on("close", () => {
      if (this.active?.id !== viewerId) return;
      this.runtime.revokeViewer(viewerId);
      this.active = null;
    });
    try {
      await this.runtime.waitUntilServed(grant.token);
    } catch (error) {
      this.close();
      throw error;
    }
    return { opened: true as const };
  }

  close() {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.runtime.revokeViewer(active.id);
    active.window.close();
  }

  shutdown() {
    this.close();
    this.runtime.close();
  }
}
