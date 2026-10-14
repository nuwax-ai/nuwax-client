import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

type McpServer = { name: string; command?: string; args?: string[]; env?: Array<{ name: string; value: string }> };
type Grant = { secret: string; file: string; owner: string; active: boolean; turn: number };
type Entry = { command: string; args: string[]; env: Record<string, string> };

/** Host-issued credentials bind an ACP session to its own transport, even in a shared engine. */
export class CuaSessionAuthority {
  private grants = new Map<string, Grant>();
  private root?: string;
  private entry?: (file: string) => Entry;
  private release?: (owner: string, cancelled: boolean) => void;
  configure(root: string, entry: (file: string) => Entry, release: (owner: string, cancelled: boolean) => void) {
    if (this.root !== root) pruneStaleGrantDirectories(path.dirname(root));
    this.root = root; this.entry = entry; this.release = release;
  }
  issue(servers: McpServer[]): Grant | undefined {
    const index = servers.findIndex((server) => server.name === "cua");
    if (index < 0) return;
    // Never pass a stale direct-helper configuration when the host gateway is unavailable.
    if (!this.root || !this.entry) { servers.splice(index, 1); return; }
    if (this.grants.size >= 256) throw new Error("Computer Use session capacity reached");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Untrusted Computer Use session directory");
    if (process.platform !== "win32") fs.chmodSync(this.root, 0o700);
    const secret = randomBytes(32).toString("hex");
    const file = path.join(this.root, `${randomUUID()}.cap`);
    const entry = this.entry(file);
    fs.writeFileSync(file, secret, { mode: 0o600, flag: "wx" });
    const grant: Grant = { secret, file, owner: randomUUID(), active: false, turn: 0 };
    this.grants.set(secret, grant);
    servers[index] = { name: "cua", command: entry.command, args: entry.args,
      env: Object.entries(entry.env).map(([name, value]) => ({ name, value })) };
    return grant;
  }
  authorize(secret: unknown): string | null {
    const grant = typeof secret === "string" ? this.grants.get(secret) : undefined;
    return grant?.active ? grant.owner : null;
  }
  start(grant?: Grant): number {
    if (!grant || !this.grants.has(grant.secret)) return 0;
    if (grant.active) this.finish(grant, grant.turn, true);
    grant.owner = randomUUID(); grant.active = true;
    return ++grant.turn;
  }
  finish(grant: Grant | undefined, turn: number, cancelled: boolean) {
    if (!grant?.active || grant.turn !== turn) return;
    grant.active = false; // Revoke before callbacks can wait for the OS or ACP.
    try { this.release?.(grant.owner, cancelled); } catch { /* Revocation must survive shutdown observers. */ }
  }
  remove(grant?: Grant) {
    if (!grant) return;
    this.finish(grant, grant.turn, true);
    this.grants.delete(grant.secret);
    try { fs.rmSync(grant.file, { force: true }); } catch { /* Already revoked in memory; retry on next boot. */ }
  }
  get size() { return this.grants.size; }
}

export const cuaSessionAuthority = new CuaSessionAuthority();

/** Owned by one AcpEngine; session IDs from another engine cannot collide. */
export class CuaEngineSessions {
  private sessions = new Map<string, Grant>();
  private pending = new Set<Grant>();
  constructor(private authority = cuaSessionAuthority) {}
  async setup<T>(servers: McpServer[], work: () => Promise<T>, sessionId: (result: T) => string): Promise<T> {
    const prepared = this.prepare(servers);
    try { const result = await work(); prepared.bind(sessionId(result)); return result; }
    catch (error) { prepared.cancel(); throw error; }
  }
  prepare(servers: McpServer[]) {
    const grant = this.authority.issue(servers);
    if (grant) this.pending.add(grant);
    return {
      bind: (sessionId: string) => {
        if (!grant || !this.pending.delete(grant)) return;
        this.remove(sessionId); this.sessions.set(sessionId, grant);
      },
      cancel: () => { if (grant) this.pending.delete(grant); this.authority.remove(grant); },
    };
  }
  start(sessionId: string) { return this.authority.start(this.sessions.get(sessionId)); }
  finish(sessionId: string, turn: number, cancelled = false) { this.authority.finish(this.sessions.get(sessionId), turn, cancelled); }
  cancel(sessionId: string) { const grant = this.sessions.get(sessionId); this.authority.finish(grant, grant?.turn ?? 0, true); }
  remove(sessionId: string) { this.authority.remove(this.sessions.get(sessionId)); this.sessions.delete(sessionId); }
  destroy() {
    for (const grant of this.pending) this.authority.remove(grant);
    for (const grant of this.sessions.values()) this.authority.remove(grant);
    this.pending.clear(); this.sessions.clear();
  }
}

/** Remove only our capability files from dead process directories; never traverse symlinks. */
export function pruneStaleGrantDirectories(parent: string) {
  if (!fs.existsSync(parent)) return;
  for (const item of fs.readdirSync(parent, { withFileTypes: true })) {
    const match = /^session-grants-([1-9][0-9]*)$/.exec(item.name);
    if (!match || !item.isDirectory() || item.isSymbolicLink()) continue;
    try { process.kill(Number(match[1]), 0); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    const dir = path.join(parent, item.name);
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) continue;
      for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        if (file.isFile() && /^[0-9a-f-]{36}\.cap$/.test(file.name)) fs.unlinkSync(path.join(dir, file.name));
      }
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch { /* Read-only files can be retried without widening deletion scope. */ }
  }
}
