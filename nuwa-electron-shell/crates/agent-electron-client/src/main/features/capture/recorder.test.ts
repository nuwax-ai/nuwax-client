import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as realDelay } from "node:timers/promises";
import { RECORDING_IPC } from "@shared/features/capture/recordingContract";
import { createScratchDir } from "../_kit/scratchDir";
import { createRecordEngine, createCaptureSourceStill, createCapturePortalFrame } from "./recorder";
import { resolveCapturePlatform } from './platforms';
import type { CaptureSelection, RecordingAction } from "@shared/features/capture/windowContract";
import type { CaptureState } from "@shared/features/capture/contract";

const fake = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[], nextId: 1, autoReady: true, autoSnapshot: false, stallLoad: false, autoStop: true }));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const { pathToFileURL } = await import("node:url");
  class FakeWindow extends EventEmitter {
    destroyed = false;
    constructor(readonly options: any) { super(); fake.windows.push(this); }
    webContents = Object.assign(new EventEmitter(), {
      id: fake.nextId++, mainFrame: { url: "" }, isDestroyed: () => this.destroyed,
      setWindowOpenHandler: vi.fn(), executeJavaScript: vi.fn(async () => {}), session: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn() },
      send: vi.fn((channel, command) => {
        if (channel !== RECORDING_IPC.COMMAND) return;
        const handler = fake.handlers.get(RECORDING_IPC.EVENT)!;
        if (command === "arm") void handler(this.event(), { type: "armed" });
        if (command === "start") void handler(this.event(), { type: "started" });
        if (command === "pause") void handler(this.event(), { type: "paused" });
        if (command === "resume") void handler(this.event(), { type: "resumed" });
        if (command === "stop" && fake.autoStop) {
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
        if (config.mode === "record") {
          if (config.preview) {
            const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
            png.writeUInt32BE(100,16); png.writeUInt32BE(80,20);
            await fake.handlers.get(RECORDING_IPC.SNAPSHOT)!(this.event(),png,100,80);
          }
          await fake.handlers.get(RECORDING_IPC.EVENT)!(this.event(), { type: "ready", width:100,height:80,mime:"video/webm;codecs=vp9" });
        }
        else if (fake.autoSnapshot) {
          const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
          png.writeUInt32BE(100,16); png.writeUInt32BE(80,20);
          await fake.handlers.get(RECORDING_IPC.SNAPSHOT)!(this.event(),png,100,80);
        }
      }
    }
  }
  return { BrowserWindow: FakeWindow, powerSaveBlocker:{start:vi.fn(() => 1),stop:vi.fn()}, ipcMain: {
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
    fake.windows = []; fake.autoReady = true; fake.autoSnapshot = false; fake.stallLoad = false; fake.autoStop = true;
  });
  afterEach(async () => {
    for (const engine of engines) engine.dispose();
    vi.useRealTimers();
    await realDelay(5);
    await rm(root,{recursive:true,force:true}); expect(fake.handlers.size).toBe(0);
  });

  it.each([
    ['gif', undefined, undefined, 15],
    ['gif', 60, 'lossless', 20],
    ['gif', 30, 'medium', 12],
    ['gif', 30, 'low', 10],
    ['gif', 5, 'high', 5],
    ['mp4', 60, 'high', 60],
    ['webm', 30, 'low', 30],
  ] as const)('%s capture at %s fps / %s avoids frames the output would discard', async (output, fps, quality, expectedFps) => {
    const platform = resolveCapturePlatform('win32');
    const acquire = vi.fn(async () => null);
    const adapter = { ...platform, source: { ...platform.source, acquireRecording: acquire } };
    const engine = createRecordEngine({ scratch: createScratchDir(root), platform: 'win32', adapter,
      log: { warn: vi.fn(), error: vi.fn() },
      ffmpeg: { path: '/trusted/ffmpeg', version: 'test', configuration: '--disable-gpl',
        encoders: ['h264_mf', 'libvpx-vp9', 'gif'], filters: ['crop', 'pad', 'format', 'fps', 'split', 'palettegen', 'paletteuse'],
        formats: { mp4: true, webm: true, gif: true } },
      windows: { select: async () => selection, createRecordingControls: vi.fn() } });
    engines.push(engine);
    expect(await engine.record({ output, fps, compression: quality ? { quality } : undefined }, new AbortController().signal, () => {})).toBeNull();
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ fps: expectedFps }));
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

  it('keeps a confirmed recording alive beyond both setup deadlines', async () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','performance']});
    const {engine,controls}=deps(); const states: CaptureState[]=[];
    const pending=engine.record({output:'webm',maxDurationMs:45000},new AbortController().signal,state=>states.push(state));
    await until(() => controls.update.mock.calls.some(([value]) => value.countdown===3));
    await vi.advanceTimersByTimeAsync(3000); await vi.advanceTimersByTimeAsync(25000);
    expect(fake.windows[0].destroyed).toBe(false); expect(states).toEqual(['recording']);
    engine.stop(); const result=await pending; expect(result?.durationMs).toBe(25000); result?.disposeFile?.();
  });

  it('automatically stops at the configured duration, closes the stream and produces a file', async () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','performance']});
    const {engine,controls} = deps(); const states: CaptureState[] = [];
    const pending = engine.record({output:'webm',maxDurationMs:1000},new AbortController().signal,state => states.push(state));
    await until(() => controls.update.mock.calls.some(([value]) => value.countdown === 3));
    await vi.advanceTimersByTimeAsync(3000);
    expect(controls.update).toHaveBeenCalledWith({state:'recording',elapsedMs:0,maxDurationMs:1000});
    await vi.advanceTimersByTimeAsync(900);
    expect(states).toEqual(['recording']);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result).toMatchObject({durationMs:1000});
    expect(await readFile(result!.filePath!)).toEqual(Buffer.from('encoded'));
    expect(states).toEqual(['recording','encoding']);
    expect(controls.dispose).toHaveBeenCalledOnce(); result?.disposeFile?.();
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
    expect(controls.dispose).not.toHaveBeenCalled();
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
  it('closes a stalled snapshot document on acquisition timeout and preserves the failure', async () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']}); fake.stallLoad = true;
    const promise = createCaptureSourceStill({scratch:createScratchDir(root)})('window:5:0',{width:20,height:16},new AbortController().signal);
    const outcome = expect(promise).rejects.toThrow('Desktop snapshot timed out');
    await until(() => !!fake.windows[0]?.webContents.mainFrame.url);
    await vi.advanceTimersByTimeAsync(20000); await outcome;
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
  it('uses one portal window for the first frame, region preview and recording, then removes its handler', async () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','performance']});
    const controls = { update: vi.fn(), hideForRecording: vi.fn(), setContentProtection: vi.fn(), dispose: vi.fn() };
    const selectPrepared = vi.fn(async (_mode, image) => {
      expect(image.selection).toMatchObject({ coordinateSpace: 'source', sourceSize: {width:100,height:80} });
      expect(image.selection).not.toHaveProperty('displayId'); expect(image.selection).not.toHaveProperty('displayBounds');
      return { ...image.selection, crop: {x:10,y:12,width:50,height:40} };
    });
    const select = vi.fn();
    const engine = createRecordEngine({ scratch:createScratchDir(root), log:{warn:vi.fn(),error:vi.fn()}, platform:'linux', portal:true,
      ffmpeg:{path:'/trusted/ffmpeg',version:'test',configuration:'--disable-gpl',encoders:['libvpx-vp9'],filters:['crop','format','fps'],formats:{mp4:false,webm:true,gif:false}},
      windows:{select,selectPrepared,createRecordingControls:() => controls} });
    engines.push(engine); const states: CaptureState[] = [];
    const pending = engine.record({output:'webm'},new AbortController().signal,state => states.push(state));
    await until(() => controls.update.mock.calls.some(([value]) => value.countdown === 3));
    expect(select).not.toHaveBeenCalled(); expect(selectPrepared).toHaveBeenCalledOnce(); expect(fake.windows).toHaveLength(1);
    expect(fake.windows[0].webContents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('startNuwaxCapture'),true);
    await vi.advanceTimersByTimeAsync(3000); expect(controls.hideForRecording).toHaveBeenCalledOnce();
    engine.pauseOrResume(); await settleIO(); expect(states.at(-1)).toBe('paused');
    engine.pauseOrResume(); await settleIO(); expect(states.at(-1)).toBe('recording');
    engine.stop(); const result = await pending;
    const { transcodeRecording } = await import('./transcode');
    expect(transcodeRecording).toHaveBeenLastCalledWith(expect.anything(),'linux',expect.any(String),expect.any(String),{width:100,height:80},
      {x:10,y:12,width:50,height:40},expect.anything(),expect.anything());
    expect(fake.windows).toHaveLength(1); expect(fake.windows[0].webContents.session.setDisplayMediaRequestHandler).toHaveBeenLastCalledWith(null);
    result?.disposeFile?.();
  });
  it('takes portal snapshots without display coordinates or an encoding resource', async () => {
    fake.autoSnapshot = true;
    const image = await createCapturePortalFrame({scratch:createScratchDir(root)})(new AbortController().signal);
    expect(image).toMatchObject({width:100,height:80,selection:{coordinateSpace:'source'}});
    expect(image.selection).not.toHaveProperty('displayId'); expect(fake.windows[0].destroyed).toBe(true);
    expect(fake.windows[0].webContents.session.setDisplayMediaRequestHandler).toHaveBeenLastCalledWith(null);
  });
  it.each(['linux','darwin','win32'] as const)('keeps %s controls hidden until the final chunk and stream are closed', async platform => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','performance']}); fake.autoStop = false;
    const controls = { update:vi.fn(),hideForRecording:vi.fn(),setContentProtection:vi.fn(),dispose:vi.fn() };
    const visibleWhileCapturing: boolean[] = [];
    controls.update.mockImplementation(value => {
      if (value.state === 'encoding') visibleWhileCapturing.push(!fake.windows[0].destroyed);
    });
    const engine = createRecordEngine({ scratch:createScratchDir(root),log:{warn:vi.fn(),error:vi.fn()},platform,portal:false,
      ffmpeg:{path:'/trusted/ffmpeg',version:'test',configuration:'--disable-gpl',encoders:['libvpx-vp9'],filters:['crop','format','fps'],formats:{mp4:false,webm:true,gif:false}},
      windows:{select:async () => selection,createRecordingControls:() => controls} });
    engines.push(engine); const states: CaptureState[] = [];
    const pending = engine.record({output:'webm'},new AbortController().signal,state => states.push(state));
    await until(() => controls.update.mock.calls.some(([value]) => value.countdown === 3));
    await vi.advanceTimersByTimeAsync(3000);
    expect(states).toEqual(['recording']); engine.stop(); await settleIO();
    expect(controls.update.mock.calls.some(([value]) => value.state === 'encoding')).toBe(false);
    expect(fake.windows[0].destroyed).toBe(false);
    await fake.handlers.get(RECORDING_IPC.CHUNK)!(fake.windows[0].event(),0,Uint8Array.from([1,2,3]).buffer);
    await fake.handlers.get(RECORDING_IPC.EVENT)!(fake.windows[0].event(),{type:'stopped'});
    const result = await pending;
    expect(visibleWhileCapturing).toEqual([false]); expect(states).toEqual(['recording','encoding']);
    result?.disposeFile?.();
  });
  it.each([{width:2,height:32,accepted:false},{width:32,height:2,accepted:false},{width:16,height:16,accepted:true},{width:15,height:17,accepted:true}])
    ('validates the real aligned OpenH264 frame size before countdown: $width × $height', async ({width,height,accepted}) => {
      vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','performance']});
      const controls = {update:vi.fn(),setContentProtection:vi.fn(),dispose:vi.fn()};
      const engine = createRecordEngine({scratch:createScratchDir(root),log:{warn:vi.fn(),error:vi.fn()},platform:'linux',portal:false,
        ffmpeg:{path:'/trusted/ffmpeg',version:'test',configuration:'--disable-gpl',encoders:['libopenh264'],filters:['crop','pad','format','fps'],formats:{mp4:true,webm:false,gif:false}},
        windows:{select:async () => ({...selection,crop:{x:0,y:0,width,height}}),createRecordingControls:() => controls}});
      engines.push(engine);
      const pending = engine.record({output:'mp4'},new AbortController().signal,() => {});
      if (!accepted) {
        await expect(pending).rejects.toThrow('selected area is too small');
        expect(controls.update).not.toHaveBeenCalled(); expect(fake.windows[0].destroyed).toBe(true);
      } else {
        await until(() => controls.update.mock.calls.some(([value]) => value.countdown === 3));
        await vi.advanceTimersByTimeAsync(3000); engine.stop();
        const result = await pending; expect(result).not.toBeNull(); result?.disposeFile?.();
      }
    });
  it.each(['success','cancel','renderer-crash'])('owns the Linux idle-blanking inhibitor from confirmed source through %s cleanup', async reason => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','performance']});
    const power = {start:vi.fn(() => 42),stop:vi.fn()};
    const controls = {update:vi.fn(),setContentProtection:vi.fn(),dispose:vi.fn()};
    let confirm!: (selection: CaptureSelection | null) => void;
    const selected = new Promise<CaptureSelection | null>(resolve => { confirm = resolve; });
    const engine = createRecordEngine({scratch:createScratchDir(root),log:{warn:vi.fn(),error:vi.fn()},platform:'linux',portal:false,powerSaveBlocker:power,
      ffmpeg:{path:'/trusted/ffmpeg',version:'test',configuration:'--disable-gpl',encoders:['libvpx-vp9'],filters:['crop','format','fps'],formats:{mp4:false,webm:true,gif:false}},
      windows:{select:async () => selected,createRecordingControls:() => controls}});
    engines.push(engine); const controller = new AbortController();
    const pending = engine.record({output:'webm'},controller.signal,() => {});
    await settleIO(); expect(power.start).not.toHaveBeenCalled();
    confirm(selection); await until(() => controls.update.mock.calls.some(([value]) => value.countdown === 3));
    expect(power.start).toHaveBeenCalledOnce(); expect(power.start).toHaveBeenCalledWith('prevent-display-sleep');
    if (reason === 'cancel') { controller.abort(); expect(await pending).toBeNull(); }
    else if (reason === 'renderer-crash') {
      const outcome = expect(pending).rejects.toThrow('Capture renderer exited: crashed');
      fake.windows[0].webContents.emit('render-process-gone',{}, {reason:'crashed'}); await outcome;
    } else {
      await vi.advanceTimersByTimeAsync(3000); engine.stop(); const result = await pending;
      expect(result).not.toBeNull(); result?.disposeFile?.();
    }
    expect(power.stop).toHaveBeenCalledOnce(); expect(power.stop).toHaveBeenCalledWith(42);
  });
  it('does not acquire the Linux sleep inhibitor when source selection is canceled', async () => {
    const power = {start:vi.fn(() => 42),stop:vi.fn()};
    const engine = createRecordEngine({scratch:createScratchDir(root),log:{warn:vi.fn(),error:vi.fn()},platform:'linux',portal:false,powerSaveBlocker:power,
      ffmpeg:{path:'/trusted/ffmpeg',version:'test',configuration:'--disable-gpl',encoders:['libvpx-vp9'],filters:['crop','format','fps'],formats:{mp4:false,webm:true,gif:false}},
      windows:{select:async () => null,createRecordingControls:vi.fn()}});
    engines.push(engine); expect(await engine.record({output:'webm'},new AbortController().signal,() => {})).toBeNull();
    expect(power.start).not.toHaveBeenCalled(); expect(power.stop).not.toHaveBeenCalled();
  });
});
