type State = "recovering" | "ready" | "degraded" | "waitingPermission";
const BLOCKED = new Set(["permissionsRequired", "policyNotActive", "helperProtocolInvalid", "endpointManifestUntrusted",
  "endpointDirectoryUntrusted", "endpointSocketUntrusted", "helperIdentityUnverified", "helperUpgradeRequired", "helperStillRunning"]);

/** One cancellable repair per host. User revocation always wins over late recovery. */
export class CuaRuntimeRecovery {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: AbortController;
  private requested = false;
  private failures = 0;
  private roundStarted = 0;
  constructor(private options: {
    allowed: () => boolean;
    repair: (signal: AbortSignal) => Promise<void>;
    state: (state: State, error?: string) => void;
  }) {}
  request() {
    this.requested = true;
    if (this.timer || this.active || !this.options.allowed()) return;
    this.schedule(0);
  }
  cancel() {
    this.requested = false; this.failures = 0;
    this.roundStarted = 0;
    clearTimeout(this.timer); this.timer = undefined;
    this.active?.abort();
  }
  private schedule(ms: number) {
    this.timer = setTimeout(() => { this.timer = undefined; void this.attempt(); }, ms);
    this.timer.unref();
  }
  private async attempt() {
    if (!this.requested || !this.options.allowed()) return;
    const ctrl = new AbortController(); this.active = ctrl;
    if (!this.roundStarted) this.roundStarted = Date.now();
    this.options.state("recovering");
    let retry = false;
    try {
      await this.options.repair(ctrl.signal);
      if (!ctrl.signal.aborted && this.options.allowed()) {
        this.failures = 0; this.roundStarted = 0; this.requested = false; this.options.state("ready");
      }
    } catch (error) {
      if (ctrl.signal.aborted) return;
      const reason = error instanceof Error ? error.message : "gatewayFailed";
      this.options.state(reason === "permissionsRequired" ? "waitingPermission" : "degraded", reason);
      retry = !BLOCKED.has(reason);
      if (!retry) this.requested = false;
    } finally {
      this.active = undefined;
      if (this.requested && this.options.allowed()) {
        if (ctrl.signal.aborted) this.schedule(0);
        else if (retry) {
          const delay = Date.now() - this.roundStarted < 30_000 ? [1000, 2000, 5000][this.failures++] : undefined;
          const base = delay ?? 60_000;
          if (delay === undefined) { this.roundStarted = 0; this.failures = 0; }
          this.schedule(base + Math.floor(Math.random() * Math.min(250, base / 10)));
        }
      }
    }
  }
}
