import { createThemeApplicator } from "@shared/features/themes/core/dom";
import { tokenToCssVariables } from "@shared/features/themes/core";
import type { ThemeTokens } from "@shared/features/themes/core/types";
import type { HostThemeSnapshot } from "@shared/types/hostBridge";

/** The legacy body[data-theme] rules redeclare variables instead of inheriting the root. */
export function createShellThemeApplicator(doc: Document) {
  const applicator = createThemeApplicator(doc.documentElement, "shell");
  const originalMode = doc.body.getAttribute("data-theme");
  const originals = new Map<string, [string, string]>();
  const own = (name: string, value: string) => {
    if (!originals.has(name))
      originals.set(name, [
        doc.body.style.getPropertyValue(name),
        doc.body.style.getPropertyPriority(name),
      ]);
    doc.body.style.setProperty(name, value);
  };
  return {
    apply(snapshot: HostThemeSnapshot) {
      if (!applicator.apply(snapshot)) return false;
      for (const key of Object.keys(
        tokenToCssVariables(snapshot.tokens as ThemeTokens)
      ))
        own(key, "inherit");
      // Native-only legacy aliases are expressed in generated semantic variables.
      for (const [key, token] of Object.entries({
        "bg-header": "elevated-bg",
        "bg-section-header": "elevated-bg",
        icon: "text-secondary",
        "text-quaternary": "text-disabled",
        success: "success",
        error: "error",
        warning: "warning",
        info: "info",
      }))
        own(`--color-${key}`, `var(--nuwax-${token})`);
      doc.body.setAttribute("data-theme", snapshot.mode);
      return true;
    },
    dispose() {
      applicator.dispose();
      for (const [key, [value, priority]] of originals) {
        if (value) doc.body.style.setProperty(key, value, priority);
        else doc.body.style.removeProperty(key);
      }
      if (originalMode === null) doc.body.removeAttribute("data-theme");
      else doc.body.setAttribute("data-theme", originalMode);
    },
  };
}
