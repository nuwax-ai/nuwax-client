import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { recordingScript } from './recordingPage';

function fixture(mode: 'record' | 'snapshot' = 'record', metadataReady = true, presentationReady = true, refreshBeforeStart = false, guardedSource = false) {
  const probe = { stop: vi.fn() };
  const track = { stop: vi.fn(), addEventListener: vi.fn(), applyConstraints:vi.fn(async()=>{}), getConstraints:() => ({resizeMode:'none',width:{ideal:120,max:16384},height:{ideal:90,max:16384}}), clone: vi.fn(() => probe) };
  let nextRead: ((value: any) => void) | undefined;
  const frameClose = vi.fn(), recorderStart = vi.fn();
  const reader = { read: vi.fn(() => new Promise(resolve => { nextRead = resolve; })),
    cancel: vi.fn(async () => { nextRead?.({done:true}); nextRead = undefined; }), releaseLock: vi.fn() };
  class Processor {
    constructor(options: any) { expect(options).toEqual({track:probe,maxBufferSize:1}); }
    readable = {getReader: () => reader};
  }
  const pacedTrack = {stop:vi.fn(),requestFrame:vi.fn()};
  const pacedStream = {getTracks:() => [pacedTrack],getVideoTracks:() => [pacedTrack]};
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getDisplayMedia = vi.fn(async (_constraints?: unknown) => stream), getUserMedia = vi.fn(async () => stream);
  let command!: (value: string) => void;
  const event = vi.fn(async () => {}), snapshot = vi.fn(async () => {});
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    onstop?: () => void;
    constructor(readonly source: unknown) { expect(source).toBe(refreshBeforeStart && !guardedSource ? pacedStream : stream); }
    start() { recorderStart(); this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  const video = { hasStream:false, videoWidth: 120, videoHeight: 90, readyState:4, onloadedmetadata: null as null | (() => void),
    play: async () => {}, requestVideoFrameCallback: vi.fn((callback: () => void) => { if (presentationReady) callback(); return 11; }),
    cancelVideoFrameCallback: vi.fn(),
    set srcObject(_value: unknown) { this.hasStream=!!_value; if (metadataReady) queueMicrotask(() => this.onloadedmetadata?.()); } };
  const context = { drawImage: vi.fn() };
  const canvas = { captureStream:vi.fn(() => pacedStream), getContext: () => context, toBlob: (callback: (value: Blob) => void) => callback(new Blob(['png'])) };
  const window: any = { captureRecording: {
    config: async () => ({ mode, acquisition: 'portal', preview: mode === 'record', sourceId: 'portal', sourceKind: 'screen', sourceSize: {width:1,height:1}, fps:30, framePipeline:guardedSource?'guarded-source':refreshBeforeStart?'repeat-last-frame':'source', sourceFrameRateFloor:refreshBeforeStart&&!guardedSource?1:undefined }),
    event, snapshot, chunk: async () => {}, onCommand: (callback: typeof command) => { command = callback; },
  }, addEventListener: vi.fn() };
  runInNewContext(recordingScript, { window, navigator: {mediaDevices:{getDisplayMedia,getUserMedia}},
    document:{createElement:(tag: string) => tag === 'video' ? video : canvas,body:{append:vi.fn()}},
    MediaRecorder: Recorder, MediaStreamTrackProcessor: Processor, Blob, queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: (callback: () => void) => callback() });
  return { window, video, track, probe, canvas, context, pacedTrack, reader, frameClose, recorderStart, pushFrame(timestamp: number, width=120, height=90) { const resolve=nextRead; nextRead=undefined; resolve?.({done:false,value:{timestamp,displayWidth:width,displayHeight:height,close:frameClose}}); }, event, snapshot, getDisplayMedia, getUserMedia, command: (value: string) => command(value) };
}

afterEach(() => vi.useRealTimers());

describe('portal recording renderer stream lifetime', () => {
  const arm = async (f: ReturnType<typeof fixture>) => {
    f.command('arm'); await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalledTimes(1));
    f.pushFrame(100); await vi.waitFor(() => expect(f.event).toHaveBeenCalledWith({type:'armed'}));
  };
  it('arms and drains decoded frames before hiding UI, then verifies fresh source frames', async () => {
    const f = fixture('record',true,true,true); await f.window.startNuwaxCapture(); await arm(f);
    await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalledTimes(2));
    f.command('start'); f.pushFrame(100); await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalledTimes(3));
    expect(f.recorderStart).not.toHaveBeenCalled();
    f.pushFrame(200); await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalledTimes(4));
    expect(f.recorderStart).not.toHaveBeenCalled(); f.pushFrame(300); await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalled()); await Promise.resolve();
    expect(f.recorderStart).not.toHaveBeenCalled(); f.pushFrame(400); await vi.waitFor(() => expect(f.recorderStart).toHaveBeenCalledOnce());
    expect(f.frameClose).toHaveBeenCalledTimes(5); expect(f.reader.cancel).not.toHaveBeenCalled();
    expect(f.probe.stop).not.toHaveBeenCalled();
    expect(f.track.stop).not.toHaveBeenCalled(); expect(f.getDisplayMedia).toHaveBeenCalledOnce();
    f.command('stop'); await vi.waitFor(() => expect(f.reader.releaseLock).toHaveBeenCalledOnce());
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.probe.stop).toHaveBeenCalledOnce(); expect(f.pacedTrack.stop).toHaveBeenCalledOnce();
  });
  it('ignores previously drained frames and verifies new progress at start even on a static source', async () => {
    const f = fixture('record',true,true,true); await f.window.startNuwaxCapture(); await arm(f);
    await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalledTimes(2));
    f.pushFrame(200); await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalledTimes(3));
    f.command('start'); expect(f.recorderStart).not.toHaveBeenCalled();
    f.pushFrame(300); await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalledTimes(4));
    expect(f.recorderStart).not.toHaveBeenCalled(); f.pushFrame(400); await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalledTimes(5));
    expect(f.recorderStart).not.toHaveBeenCalled(); f.pushFrame(500); await vi.waitFor(() => expect(f.recorderStart).toHaveBeenCalledOnce());
    expect(f.frameClose).toHaveBeenCalledTimes(5); f.command('stop');
  });
  it('paces clean decoded pixels at native size when the authorized desktop stops producing damage', async () => {
    vi.useFakeTimers(); const f=fixture('record',true,true,true); await f.window.startNuwaxCapture(); await arm(f);
    f.command('start'); f.pushFrame(200); await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalledTimes(3)); f.pushFrame(300); await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalled()); await Promise.resolve();
    expect(f.recorderStart).not.toHaveBeenCalled(); f.pushFrame(400); await vi.waitFor(() => expect(f.recorderStart).toHaveBeenCalledOnce());
    expect(f.canvas).toMatchObject({width:120,height:90});
    expect(f.track.applyConstraints).toHaveBeenCalledWith({resizeMode:'none',width:{ideal:120,max:16384},height:{ideal:90,max:16384},frameRate:{min:1,ideal:30,max:30}}); expect(f.canvas.captureStream).toHaveBeenCalledWith(0);
    f.pacedTrack.requestFrame.mockClear(); await vi.advanceTimersByTimeAsync(990); expect(f.pacedTrack.requestFrame).toHaveBeenCalledTimes(30);
    expect(f.getDisplayMedia).toHaveBeenCalledOnce(); expect(f.track.stop).not.toHaveBeenCalled();
    f.command('stop'); await vi.waitFor(() => expect(f.reader.releaseLock).toHaveBeenCalledOnce());
    expect(f.pacedTrack.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('attaches the granted source and observes metadata before awaiting source constraint renegotiation', async () => {
    const f=fixture('record',true,true,true); let applied!:()=>void;
    f.track.applyConstraints.mockImplementation(()=>new Promise<void>(resolve=>{applied=resolve;}));
    const acquiring=f.window.startNuwaxCapture(); await vi.waitFor(() => expect(f.track.applyConstraints).toHaveBeenCalled());
    expect(f.video.hasStream).toBe(true); expect(f.video.onloadedmetadata).toBeTypeOf('function');
    expect(f.event).not.toHaveBeenCalledWith(expect.objectContaining({type:'ready'}));
    applied(); await acquiring; expect(f.event).toHaveBeenCalledWith(expect.objectContaining({type:'ready',width:120,height:90}));
    f.command('cancel');
  });
  it('fails on a source display size change and closes the mismatched frame instead of stretching it', async () => {
    const f=fixture('record',true,true,true); await f.window.startNuwaxCapture(); await arm(f);
    await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalledTimes(2)); f.pushFrame(200,121,90);
    await vi.waitFor(() => expect(f.event).toHaveBeenCalledWith(expect.objectContaining({type:'error',message:'Desktop capture dimensions changed during recording'})));
    expect(f.frameClose).toHaveBeenCalledTimes(2); expect(f.recorderStart).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.reader.releaseLock).toHaveBeenCalledOnce();
  });
  it('guards a native source while preserving its original recorder input and pixels', async () => {
    const f=fixture('record',true,true,true,true); await f.window.startNuwaxCapture(); await arm(f);
    f.command('start'); f.pushFrame(200); await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalledTimes(3));
    f.pushFrame(300); await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalledTimes(4));
    expect(f.recorderStart).not.toHaveBeenCalled(); f.pushFrame(400);
    await vi.waitFor(() => expect(f.recorderStart).toHaveBeenCalledOnce());
    expect(f.canvas.captureStream).not.toHaveBeenCalled(); expect(f.pacedTrack.requestFrame).not.toHaveBeenCalled();
    expect(f.track.applyConstraints).not.toHaveBeenCalled(); f.command('stop');
    await vi.waitFor(() => expect(f.reader.releaseLock).toHaveBeenCalledOnce());
  });
  it('holds the stopped event until asynchronous reader cleanup completes', async () => {
    const f=fixture('record',true,true,true); await f.window.startNuwaxCapture(); await arm(f);
    f.command('start'); f.pushFrame(200); await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalledTimes(3));
    f.pushFrame(300); await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalled()); await Promise.resolve();
    expect(f.recorderStart).not.toHaveBeenCalled(); f.pushFrame(400); await vi.waitFor(() => expect(f.recorderStart).toHaveBeenCalledOnce());
    const cancel=f.reader.cancel.getMockImplementation()!; let finishCancel!:()=>void;
    f.reader.cancel.mockImplementation(() => new Promise<void>(resolve=>{finishCancel=resolve;}).then(cancel));
    f.command('stop'); await vi.waitFor(() => expect(f.reader.cancel).toHaveBeenCalledOnce());
    expect(f.event).not.toHaveBeenCalledWith({type:'stopped'}); expect(f.reader.releaseLock).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.pacedTrack.stop).toHaveBeenCalledOnce();
    finishCancel(); await vi.waitFor(() => expect(f.event).toHaveBeenCalledWith({type:'stopped'}));
    expect(f.reader.releaseLock).toHaveBeenCalledOnce();
  });
  it('bounds the decoded-frame wait and cleans its probe before reporting a stalled stream', async () => {
    vi.useFakeTimers(); const f = fixture('record',true,true,true);
    await f.window.startNuwaxCapture(); await arm(f); f.command('start');
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.event).toHaveBeenCalledWith(expect.objectContaining({type:'error',message:'Desktop capture did not refresh after hiding recording controls'}));
    expect(f.recorderStart).not.toHaveBeenCalled(); expect(f.probe.stop).toHaveBeenCalledOnce();
    expect(f.reader.cancel).toHaveBeenCalledOnce(); expect(f.reader.releaseLock).toHaveBeenCalledOnce();
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['cancel','ended'])('releases a pending start-frame read immediately on %s', async action => {
    vi.useFakeTimers(); const f = fixture('record',true,true,true);
    await f.window.startNuwaxCapture(); await arm(f); f.command('start');
    if (action==='cancel') f.command('cancel');
    else f.track.addEventListener.mock.calls.find(([name]) => name==='ended')![1]();
    await vi.waitFor(() => expect(f.reader.releaseLock).toHaveBeenCalledOnce());
    expect(f.recorderStart).not.toHaveBeenCalled(); expect(f.probe.stop).toHaveBeenCalledOnce();
    expect(f.reader.cancel).toHaveBeenCalledOnce(); expect(f.track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases an armed probe canceled before the first decoded frame arrives', async () => {
    vi.useFakeTimers(); const f = fixture('record',true,true,true); await f.window.startNuwaxCapture(); f.command('arm');
    await vi.waitFor(() => expect(f.reader.read).toHaveBeenCalled()); f.command('cancel');
    await vi.waitFor(() => expect(f.reader.releaseLock).toHaveBeenCalledOnce());
    expect(f.event).not.toHaveBeenCalledWith({type:'armed'}); expect(f.recorderStart).not.toHaveBeenCalled();
    expect(f.probe.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('starts only on the main-process gesture, snapshots and records the same single stream', async () => {
    const f = fixture(); await Promise.resolve();
    expect(f.getDisplayMedia).not.toHaveBeenCalled();
    await f.window.startNuwaxCapture();
    const constraints = f.getDisplayMedia.mock.calls[0][0] as any;
    expect(constraints).toMatchObject({audio:false,video:{resizeMode:'none',width:{ideal:16384,max:16384},height:{ideal:16384,max:16384}}});
    expect(constraints.video.width).not.toHaveProperty('min'); expect(constraints.video.width).not.toHaveProperty('exact');
    expect(f.snapshot).toHaveBeenCalledWith(expect.any(ArrayBuffer),120,90);
    expect(f.event).toHaveBeenCalledWith({type:'ready',width:120,height:90,mime:'video/webm;codecs=vp9'});
    expect(f.track.stop).not.toHaveBeenCalled();
    await f.window.startNuwaxCapture(); f.command('start'); f.command('pause'); f.command('resume'); f.command('stop');
    await vi.waitFor(() => expect(f.event).toHaveBeenCalledWith({type:'stopped'}));
    expect(f.getDisplayMedia).toHaveBeenCalledOnce(); expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalled();
  });
  it('a canceled acquisition closes a late-granted stream without emitting a preview', async () => {
    const f = fixture(); let grant!: (value: any) => void;
    f.getDisplayMedia.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    const acquisition = f.window.startNuwaxCapture(); await vi.waitFor(() => expect(f.getDisplayMedia).toHaveBeenCalled());
    f.command('cancel'); grant({getTracks:() => [f.track],getVideoTracks:() => [f.track]}); await acquisition;
    expect(f.track.stop).toHaveBeenCalled(); expect(f.snapshot).not.toHaveBeenCalled();
  });
  it('snapshot-only mode releases the grant after the first frame', async () => {
    const f = fixture('snapshot'); await f.window.startNuwaxCapture();
    expect(f.snapshot).toHaveBeenCalledOnce(); expect(f.track.stop).toHaveBeenCalled();
    expect(f.event).not.toHaveBeenCalledWith(expect.objectContaining({type:'ready'}));
  });
  it('reports a source ending before metadata instead of leaving acquisition pending until its timeout', async () => {
    const f = fixture('record',false); void f.window.startNuwaxCapture();
    await vi.waitFor(() => expect(f.track.addEventListener).toHaveBeenCalledWith('ended',expect.any(Function)));
    const ended = f.track.addEventListener.mock.calls.find(([name]) => name === 'ended')![1]; ended();
    await vi.waitFor(() => expect(f.event).toHaveBeenCalledWith(expect.objectContaining({type:'error',message:'Desktop capture source was removed'})));
    expect(f.track.stop).toHaveBeenCalled(); expect(f.snapshot).not.toHaveBeenCalled();
  });
  it('snapshots decoded native pixels when a hidden window never receives a presentation callback', async () => {
    vi.useFakeTimers(); const f = fixture('snapshot',true,false);
    const acquisition = f.window.startNuwaxCapture();
    await vi.waitFor(() => expect(f.video.requestVideoFrameCallback).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(250); await acquisition;
    expect(f.snapshot).toHaveBeenCalledWith(expect.any(ArrayBuffer),120,90);
    expect(f.video.cancelVideoFrameCallback).toHaveBeenCalledWith(11); expect(vi.getTimerCount()).toBe(0);
  });
  it('fails rather than fabricating a PNG if the fallback deadline has no decoded frame', async () => {
    vi.useFakeTimers(); const f = fixture('snapshot',true,false); f.video.readyState = 1;
    const acquisition = f.window.startNuwaxCapture();
    await vi.waitFor(() => expect(f.video.requestVideoFrameCallback).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(250); await acquisition;
    expect(f.snapshot).not.toHaveBeenCalled(); expect(f.track.stop).toHaveBeenCalled();
    expect(f.event).toHaveBeenCalledWith(expect.objectContaining({type:'error',message:'Desktop capture returned no decoded frame'}));
    expect(f.video.cancelVideoFrameCallback).toHaveBeenCalledWith(11); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a pending hidden-window frame wait and releases its timer, callback and track immediately', async () => {
    vi.useFakeTimers(); const f = fixture('snapshot',true,false);
    const acquisition = f.window.startNuwaxCapture();
    await vi.waitFor(() => expect(f.video.requestVideoFrameCallback).toHaveBeenCalled());
    f.command('cancel'); await acquisition;
    expect(f.snapshot).not.toHaveBeenCalled(); expect(f.track.stop).toHaveBeenCalled();
    expect(f.video.cancelVideoFrameCallback).toHaveBeenCalledWith(11); expect(vi.getTimerCount()).toBe(0);
  });
});
