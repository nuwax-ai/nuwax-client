/** Validate only URL syntax; private and single-label domains are valid. */
export function isValidServiceHostInput(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch { return false; }
}
