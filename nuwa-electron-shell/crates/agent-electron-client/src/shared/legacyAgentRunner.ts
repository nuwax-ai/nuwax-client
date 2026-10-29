/** The custom-binary runner is not shipped or used by the commercial client.
 * Its old argv-only credential contract must not be revived by an older UI.
 * The built-in ACP engines use a separate service and are unaffected.
 */
export function legacyAgentRunnerUnavailable() {
  return {
    success: false,
    error: "Legacy Agent Runner is unavailable in Nuwax. Use the built-in agent engine.",
  };
}
