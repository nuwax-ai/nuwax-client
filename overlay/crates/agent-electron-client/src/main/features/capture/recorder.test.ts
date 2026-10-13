import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as realDelay } from "node:timers/promises";
import { RECORDING_IPC } from "@shared/features/capture/recordingContract";
import { createScratchDir } from "../_kit/scratchDir";
import { createRecordEngine, createCaptureSourceStill } from "./recorder";
import type { CaptureSelection, RecordingAction } from "@shared/features/capture/windowContract";
import type { CaptureState } from "@shared/features/capture/contract";

const fake = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[], nextId: 1, autoReady: true, autoSnapshot: false, stallLoad: false }));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const { pathToFileURL } = await import("node:url");
  class FakeWindow extends EventEmitter {
    destroyed = false;
    constructor(readonly options: any) { super(); fake.windows.push(this); }
    webContents = Object.assign(new EventEmitter(), {
      id: fake.nextId++, mainFrame: { url: "" }, isDestroyed: () => this.destroyed,
      setWindowOpenHandler: vi.fn(), session: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() },
      send: vi.fn((channel, command) => {
        if (channel !== RECORDING_IPC.COMMAND) return;
        const handler = fake.handlers.get(RECORDING_IPC.EVENT)!;
        if (command === "start") void handler(this.event(), { type: "started" });
        if (command === "pause") void handler(this.event(), { type: "paused" });
        if (command === "resume") void handler(this.event(), { type: "resumed" });
        if (command === "stop") {
          void fake.handlers.get(RECORDING_IPC.CHUNK)!(this.event(),0,Uint8Array.from([1,2,3]).buffer)
            .then(() => handler(this.event(), { type: "stopped" }));
        }
      }),
    });
    event() { return { sender: this.webContents, senderFrame: this.webContents.mainFrame }; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    async loadFile(path: string) {
      this.webContents.mainFrame.url = pathToFileURL(path).href;
      if (fake.stallLoad) await new Promise(() => {});
      if (fake.autoReady) {
        const config = await fake.handlers.get(RECORDING_IPC.CONFIG)!(this.event());
        if (config.mode === "record") await fake.handlers.get(RECORDING_IPC.EVENT)!(this.event(), { type: "ready", width:100,height:80,mime:"video/webm;codecs=vp9" });
        else if (fake.autoSnapshot) {
          const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
          png.writeUInt32BE(100,16); png.writeUInt32BE(80,20);
          await fake.handlers.get(RECORDING_IPC.SNAPSHOT)!(this.event(),png,100,80);
        }
      }
    }
  }
  return { BrowserWindow: FakeWindow, ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => { if (fake.handlers.has(channel)) throw new Error("duplicate IPC"); fake.handlers.set(channel,fn); },
    removeHandler: (channel: string) => fake.handlers.delete(channel),
  } };
});

vi.mock("./transcode", async original => {
  const actual = await original<typeof import("./transcode")>();
  const { writeFile } = await import("node:fs/promises");
  return { ...actual, transcodeRecording: vi.fn(async (_resource, _platform, input, output) => {
    expect(await readFile(input)).toEqual(Buffer.from([1,2,3]));
    await writeFile(output, Buffer.from("encoded"));
    return { filePath:output,mime:"video/webm",width:100,height:80,qualityUsed:"high",exceedsMaxBytes:false,paddedForEvenSize:false };
  }) };
});

const selection: CaptureSelection = { sourceId:"screen:1:0", sourceKind:"screen", sourceSize:{width:100,height:80},
  crop:{x:0,y:0,width:100,height:80}, displayBounds:{x:0,y:0,width:100,height:80},displayId:"1",hdrToneMapped:false };

describe("private desktop recorder", () => {
  let root: string;
  let engines: Array<{ dispose(): void }>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(),"capture-recorder-"));
    engines = [];
    fake.windows = []; fake.autoReady = true; fake.autoSnapshot = false; fake.stallLoad = false;
  });
  afterEach(async () => {
    for (const engine of engines) engine.dispose();
    vi.useRealTimers();
    await realDelay(5);
    await rm(root,{recursive:true,force:true}); expect(fake.handlers.size).toBe(0);
  });

  function deps() {
    let action!: (command: RecordingAction, error?: Error) => void;
    const controls = { update:vi.fn(), setContentProtection:vi.fn(), dispose:vi.fn() };
    const engine = createRecordEngine({ scratch:createScratchDir(root), log:{warn:vi.fn(),error:vi.fn()},
      platform:"darwin", ffmpeg:{path:"/trusted/ffmpeg",version:"test",configuration:"--disable-gpl",encoders:["libvpx-vp9"],filters:["crop","format","fps"],formats:{mp4:false,webm:true,gif:false}},
      windows:{ select:async () => selection, createRecordingControls:(_selection,callback) => { action = callback; return controls; } } });
    engines.push(engine);
    return { engine,controls,action:(command:RecordingAction,error?:Error) => action(command,error) };
  }

  async function settleIO() { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); }
  async function until(check: () => boolean) {
    for (let i=0; i<100 && !check(); i++) await realDelay(5);
    expect(check()).toBe(true);
  }

  it("starts after 3 seconds, pauses/resumes, and stops to a private on-disk result", async () => {
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval","performance"]});
    const {engine,controls,action} = deps();
    const states: CaptureState[] = [];
    const resultPromise = engine.record({output:"webm"},new AbortController().signal,state => states.push(state));
    await until(() => controls.update.mock.calls.some(([value]) => value.countdown === 3));
    await vi.advanceTimersByTimeAsync(3000);
    expect(states).toEqual(["recording"]);
    await vi.advanceTimersByTimeAsync(200);
    action("pause"); await settleIO();
    expect(states.at(-1)).toBe("paused");
    await vi.advanceTimersByTimeAsync(300);
    action("resume"); await settleIO();
    await vi.advanceTimersByTimeAsync(100);
    engine.stop();
    const result = await resultPromise;
    expect(states).toEqual(["recording","paused","recording","encoding"]);
    expect(result).toMatchObject({width:100,height:80,hdrToneMapped:false,durationMs:300});
    expect(result?.filePath).toBeDefined();
    expect(await readFile(result!.filePath!)).toEqual(Buffer.from("encoded"));
    result?.disposeFile?.();
    expect(controls.dispose).toHaveBeenCalledOnce();
    expect(fake.windows[0].options.webPreferences).toMatchObject({ sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false });
    expect(fake.windows[0].destroyed).toBe(true);
  });

  it("rejects iframe/foreign IPC and removes handlers on a session abort", async () => {
    fake.autoReady = false;
    const {engine,controls} = deps();
    const controller = new AbortController();
    const capture = engine.record({output:"webm"},controller.signal,() => {});
    await until(() => !!fake.windows[0]?.webContents.mainFrame.url);
    const window = fake.windows[0];
    expect(window).toBeDefined();
    const config = fake.handlers.get(RECORDING_IPC.CONFIG)!;
    expect(() => config({sender:window.webContents,senderFrame:{url:window.webContents.mainFrame.url}})).toThrow("untrusted");
    expect(() => config({sender:{id:9876,mainFrame:{}},senderFrame:{}})).toThrow("untrusted");
    controller.abort();
    expect(await capture).toBeNull();
    expect(window.destroyed).toBe(true);
    expect(controls.dispose).toHaveBeenCalledOnce();
    expect(window.webContents.session.setPermissionCheckHandler).toHaveBeenLastCalledWith(null);
    expect(window.webContents.session.setPermissionRequestHandler).toHaveBeenLastCalledWith(null);
  });

  it("takes a full-resolution window frame without depending on any video encoder", async () => {
    fake.autoSnapshot = true;
    const frame = await createCaptureSourceStill({scratch:createScratchDir(root)})("window:5:0",{width:20,height:16},new AbortController().signal);
    expect(frame).toMatchObject({width:100,height:80,hdrToneMapped:false});
    expect(fake.windows[0].destroyed).toBe(true);
  });

  it("cleans up a stalled full-frame snapshot immediately on abort", async () => {
    const controller = new AbortController();
    const promise = createCaptureSourceStill({scratch:createScratchDir(root)})("window:5:0",{width:20,height:16},controller.signal);
    await until(() => !!fake.windows[0]?.webContents.mainFrame.url);
    controller.abort();
    await expect(promise).rejects.toThrow("canceled");
    expect(fake.windows[0].destroyed).toBe(true);
  });

  it("interrupts a stalled document load and cleans its IPC on abort", async () => {
    fake.stallLoad = true;
    const controller = new AbortController();
    const promise = createCaptureSourceStill({scratch:createScratchDir(root)})("window:5:0",{width:20,height:16},controller.signal);
    await until(() => !!fake.windows[0]?.webContents.mainFrame.url);
    controller.abort();
    await expect(promise).rejects.toThrow("canceled");
    expect(fake.windows[0].destroyed).toBe(true);
  });

  it("reports a control-window crash as a failure while aborting capture resources", async () => {
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval","performance"]});
    const {engine,controls,action} = deps();
    const parent = new AbortController();
    const promise = engine.record({output:"webm"},parent.signal,() => {});
    await until(() => controls.update.mock.calls.some(([value]) => value.countdown === 3));
    await vi.advanceTimersByTimeAsync(3000);
    action("cancel",new Error("recording controls renderer crashed"));
    await expect(promise).rejects.toThrow("recording controls renderer crashed");
    expect(parent.signal.aborted).toBe(false);
    expect(fake.windows[0].destroyed).toBe(true);
    expect(controls.dispose).toHaveBeenCalledOnce();
  });
});
