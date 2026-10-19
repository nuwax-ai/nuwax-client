import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CuaEngineSessions, CuaSessionAuthority, pruneStaleGrantDirectories } from "./sessionAuthority";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cua-grants-")); dirs.push(root);
  const authority = new CuaSessionAuthority(), release = vi.fn();
  authority.configure(root, (file) => ({ command: "trusted-node", args: ["relay"], env: { CAP: file } }), release);
  const engine = new CuaEngineSessions(authority);
  function prepare(id: string, target = engine) {
    const servers = [{ name: "cua", command: "untrusted-stale-helper", env: [] as Array<{ name: string; value: string }> }];
    const pending = target.prepare(servers);
    const file = servers[0].env[0].value, secret = fs.readFileSync(file, "utf8");
    pending.bind(id);
    return { file, secret, servers };
  }
  return { root, authority, release, engine, prepare };
}
describe("CUA host session capabilities", () => {
  it("binds different same-engine sessions and identical IDs in different engines independently", () => {
    const f = fixture(), other = new CuaEngineSessions(f.authority);
    const a = f.prepare("a"), b = f.prepare("b"), c = f.prepare("a", other);
    expect(a.servers[0].command).toBe("trusted-node");
    expect(f.authority.authorize(a.secret)).toBeNull();
    f.engine.start("a"); other.start("a");
    expect(f.authority.authorize(a.secret)).toBeTruthy();
    expect(f.authority.authorize(c.secret)).not.toBe(f.authority.authorize(a.secret));
    expect(f.authority.authorize(b.secret)).toBeNull();
    f.engine.cancel("a");
    expect(f.authority.authorize(a.secret)).toBeNull();
    expect(f.authority.authorize(c.secret)).toBeTruthy();
    other.destroy(); f.engine.destroy();
    expect(f.authority.size).toBe(0);
    expect(fs.readdirSync(f.root)).toEqual([]);
  });
  it("revokes synchronously before callbacks and ignores a stale prompt completion", () => {
    const f = fixture(), a = f.prepare("a");
    f.release.mockImplementation(() => expect(f.authority.authorize(a.secret)).toBeNull());
    const old = f.engine.start("a"), latest = f.engine.start("a");
    f.engine.finish("a", old);
    expect(f.authority.authorize(a.secret)).toBeTruthy();
    f.engine.finish("a", latest);
    expect(f.authority.authorize(a.secret)).toBeNull();
    expect(f.release).toHaveBeenCalledTimes(2);
  });
  it("cleans failed setup and a session created after engine destruction", async () => {
    const f = fixture();
    await expect(f.engine.setup([{ name: "cua" }], async () => { throw new Error("RPC failed"); }, String)).rejects.toThrow("RPC failed");
    const pending = f.engine.prepare([{ name: "cua" }]);
    f.engine.destroy(); pending.bind("late");
    expect(f.engine.start("late")).toBe(0);
    expect(f.authority.size).toBe(0);
    expect(fs.readdirSync(f.root)).toEqual([]);
  });
  it("bounds loaded sessions and reclaims files over 1000 lifecycle cycles", () => {
    const f = fixture();
    for (let i = 0; i < 1000; i++) { f.prepare("session"); const turn = f.engine.start("session"); f.engine.finish("session", turn); f.engine.remove("session"); }
    expect(f.authority.size).toBe(0); expect(fs.readdirSync(f.root)).toEqual([]);
    for (let i = 0; i < 256; i++) f.prepare(String(i));
    expect(() => f.prepare("overflow")).toThrow("capacity");
    f.engine.destroy(); expect(fs.readdirSync(f.root)).toEqual([]);
  });
  it("fails closed without a configured host gateway", () => {
    const servers = [{ name: "cua", command: "old-helper" }, { name: "other" }];
    new CuaSessionAuthority().issue(servers);
    expect(servers).toEqual([{ name: "other" }]);
  });
  it("prunes only known capability files of dead processes, preserving live and unrelated data", () => {
    const f = fixture(), dead = path.join(f.root, "session-grants-2147483647");
    const live = path.join(f.root, `session-grants-${process.pid}`);
    fs.mkdirSync(dead); fs.mkdirSync(live);
    const cap = "00000000-0000-0000-0000-000000000000.cap";
    fs.writeFileSync(path.join(dead, cap), "secret"); fs.writeFileSync(path.join(dead, "user.txt"), "keep");
    fs.writeFileSync(path.join(live, cap), "live");
    pruneStaleGrantDirectories(f.root);
    expect(fs.readdirSync(dead)).toEqual(["user.txt"]);
    expect(fs.existsSync(path.join(live, cap))).toBe(true);
  });
});
