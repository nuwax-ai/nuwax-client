import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AdbDevice, createAdbCommands } from "./adb";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));

function frame(list: string) {
  return Buffer.byteLength(list).toString(16).padStart(4, "0") + list;
}

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    kill: vi.fn(),
  });
  spawn.mockReturnValueOnce(child);
  const abort = new AbortController();
  const device = new AdbDevice("adb", "phone", "42", vi.fn());
  const onLost = vi.fn();
  const env = { PATH: "/home/example/.local/bin" };
  const commands = createAdbCommands(() => env);
  return { abort, child, device, commands, env, onLost };
}

describe("ADB transport watcher", () => {
  it("waits for the matching transport and revokes when the same serial reconnects", async () => {
    const { abort, child, device, commands, env, onLost } = fixture();
    const ready = commands.watch(device, abort.signal, onLost);
    const first = frame("phone device model:Pixel transport_id:42\n");

    child.stdout.write(first.slice(0, 2));
    child.stdout.write(first.slice(2, 12));
    expect(onLost).not.toHaveBeenCalled();
    child.stdout.write(first.slice(12));
    await ready;

    expect(spawn).toHaveBeenLastCalledWith(
      "adb",
      ["track-devices", "-l"],
      expect.objectContaining({ env, signal: abort.signal }),
    );
    child.stdout.write(
      first + frame("phone device model:Pixel transport_id:43\n"),
    );
    expect(onLost).toHaveBeenCalledOnce();
    expect(onLost).toHaveBeenCalledWith("deviceOffline");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("rejects enablement if the chosen transport disappears before the first snapshot", async () => {
    const { abort, child, device, commands, onLost } = fixture();
    const ready = commands.watch(device, abort.signal, onLost);
    child.stdout.write(frame(""));
    await expect(ready).rejects.toThrow("deviceOffline");
    expect(onLost).not.toHaveBeenCalled();
  });

  it("revokes on monitor exit and does not treat a user stop as a failure", async () => {
    for (const stoppedByUser of [false, true]) {
      const { abort, child, device, commands, onLost } = fixture();
      const ready = commands.watch(device, abort.signal, onLost);
      child.stdout.write(frame("phone device transport_id:42\n"));
      await ready;
      if (stoppedByUser) abort.abort();
      child.emit("close");
      if (stoppedByUser) expect(onLost).not.toHaveBeenCalled();
      else expect(onLost).toHaveBeenCalledWith("adbFailed");
    }
  });
});
