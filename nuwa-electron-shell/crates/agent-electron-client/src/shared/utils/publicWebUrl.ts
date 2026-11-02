/** Public navigation never exports the private gateway authority or credentials. */
export function publicWebUrl(
  value: string,
  context: { businessOrigin?: string | null; gatewayOrigin?: string | null },
): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (context.gatewayOrigin && url.origin === new URL(context.gatewayOrigin).origin) {
      if (!context.businessOrigin) return null;
      const business = new URL(/^https?:\/\//i.test(context.businessOrigin) ? context.businessOrigin : `https://${context.businessOrigin}`);
      if (!['http:', 'https:'].includes(business.protocol) || business.username || business.password) return null;
      // Concatenation preserves a pathname beginning with // as a path.
      const target = new URL(`${business.origin}${url.pathname}${url.search}${url.hash}`);
      target.searchParams.delete('_shell');
      return target.href;
    }
    return url.href;
  } catch {
    return null;
  }
}
