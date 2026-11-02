/** Only validator diagnostics with a package-relative location may reach the UI. */
export function relativeThemeDetail(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 1000 ||
    /[\r\n]|(?:^|[\s"'])(?:\/|[A-Za-z]:\\)|\.\.[\\/]|\/(?:Users|home|private|tmp)\//.test(
      value
    )
  )
    return "";
  return /^(?:theme\.json(?:\.[\w.-]+)*|files|[\w.-]+(?:\/[\w.-]+)*\.(?:css|json|png|jpe?g|svg|woff2?)):\s/.test(
    value
  )
    ? value
    : "";
}
