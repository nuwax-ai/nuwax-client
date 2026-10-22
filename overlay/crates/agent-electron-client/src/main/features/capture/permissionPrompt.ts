/** Navigation only: the user requests system access from the guide's explicit button. */
export function createScreenPermissionPrompt(options: {
  log: { warn(...args: unknown[]): void };
  openGuide(): boolean;
}): () => Promise<void> {
  let showing: Promise<void> | null = null;
  return () => {
    showing ??= Promise.resolve()
      .then(() => {
        if (!options.openGuide())
          options.log.warn("[Capture] permission guide unavailable");
      })
      .finally(() => {
        showing = null;
      });
    return showing;
  };
}
