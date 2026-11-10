import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDesktopRunner } from "./agentDesktopProcess";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
describe("Agent Desktop native process boundary", () => {
  it("passes text through stdin, accepts error envelopes and isolates inherited engine flags", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-runner-")); directories.push(home);
    const file = path.join(home, "echo.cjs");
    fs.writeFileSync(file, `let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({ok:false,error:{code:'INVALID_ARGS'},data:{text,headed:process.env.AGENT_DESKTOP_HEADED,session:process.env.AGENT_DESKTOP_SESSION,home:process.env.AGENT_DESKTOP_HOME}}));process.exitCode=1;});`);
    const run = createDesktopRunner(process.execPath, () => ({ ...process.env, AGENT_DESKTOP_HEADED: "1", AGENT_DESKTOP_SESSION: "foreign" }) as Record<string, string>);
    const reply = await run([file], { home, input: "literal $`text" });
    expect(reply).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" }, data: { text: "literal $`text", home } });
    expect(reply.data.headed).toBeUndefined(); expect(reply.data.session).toBeUndefined();
  });
  it.skipIf(process.platform === "win32")("cancels its owned process group before any delayed child write", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-abort-")); directories.push(home);
    const ready = path.join(home, "ready"), late = path.join(home, "late"), script = path.join(home, "parent.cjs");
    fs.writeFileSync(script, `const {spawn}=require('node:child_process');const fs=require('node:fs');spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'unsafe'),400);setTimeout(()=>{},2000);`)}],{stdio:'inherit'});setTimeout(()=>{},2000);`);
    const controller = new AbortController();
    const pending = createDesktopRunner(process.execPath, () => process.env as Record<string, string>)([script], { home, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("operationCancelled");
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(fs.existsSync(ready)).toBe(true); controller.abort(); await rejected;
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(fs.existsSync(late)).toBe(false);
  });
  it("does not accept a success envelope from a failed native process", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-exit-")); directories.push(home);
    await expect(createDesktopRunner(process.execPath, () => process.env as Record<string, string>)(
      ["-e", "process.stdout.write(JSON.stringify({ok:true,data:{}}));process.exitCode=1"], { home })).rejects.toThrow("helperProtocolInvalid");
  });
});
