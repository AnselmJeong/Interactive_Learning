import React, { useEffect, useState, type ReactNode } from "react";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { Theme } from "@astryxdesign/core/theme";
import { themes, defaultThemeSlug } from "../../astryx-themes";

type Mode = "light" | "dark";

function readMode(): Mode {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * Wraps the app in the Astryx theme. The app keeps owning light/dark through
 * `html[data-theme]`; this mirrors it into the Astryx Theme mode.
 */
export function AstryxRoot({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>(readMode);
  useEffect(() => {
    // Scope the theme tokens to the whole document so portals (side chat,
    // image previews) and Learnie's bridged CSS variables resolve them too.
    document.documentElement.dataset.astryxTheme = defaultThemeSlug;
    const observer = new MutationObserver(() => setMode(readMode()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return (
    <Theme theme={themes[defaultThemeSlug]} mode={mode}>
      {children}
    </Theme>
  );
}
