/** Permission instructions name the exact system subject, across all supported locales. */
export function permissionHelperName(development = false): string {
  return development ? "Nuwax Computer Use Dev" : "Nuwax Computer Use";
}

export function permissionIdentityText(text: string, development = false): string {
  return text.replaceAll("{computerUseHelper}", permissionHelperName(development))
    .replaceAll("{clientApplication}", development ? "Nuwax Dev.app" : "Nuwax.app");
}
