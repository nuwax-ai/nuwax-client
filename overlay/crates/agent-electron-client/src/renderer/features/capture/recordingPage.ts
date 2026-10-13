/** Script runs only in a private, sandboxed BrowserWindow, with no Node APIs. */
export const recordingScript = String.raw`
(() => {
  const bridge = window.captureRecording;
  const configuration = bridge.config();
  let stream, recorder, sequence = 0, pending = Promise.resolve(), pendingBytes = 0;
  let closing = false, finished = false, recordingReady = false, recorderFactory;
  let pacedCanvas, pacedContext, pacedStream, pacingTimer, fps, recordingWidth, recordingHeight;
  let cancelFrameWait;
  let frameProbe, guardSource = false, repeatLastFrame = false, arming = false, starting = false;
  const stoppedTracks=new Set();
  const stopTracks = () => {
    clearInterval(pacingTimer); cancelFrameWait?.();
    for (const track of [...(pacedStream?.getTracks()||[]),...(stream?.getTracks()||[])]) {
      if (!stoppedTracks.has(track)) { stoppedTracks.add(track); track.stop(); }
    }
    return frameProbe?.close() || Promise.resolve();
  };
  const createFrameProbe = () => {
    if (typeof MediaStreamTrackProcessor !== 'function') throw new Error('Decoded capture frame processing is unavailable');
    const track = stream.getVideoTracks()[0].clone();
    let reader;
    try { reader = new MediaStreamTrackProcessor({track,maxBufferSize:1}).readable.getReader(); }
    catch (error) { track.stop(); throw error; }
    let closed = false, timestamp = -Infinity, hasFrame=false, wait, timer, closePromise;
    let readyResolve, readyReject;
    const ready = new Promise((resolve,reject) => { readyResolve=resolve; readyReject=reject; });
    const timeoutError = () => new Error('Desktop capture did not refresh after hiding recording controls');
    const close = () => {
      if (closePromise) return closePromise;
      closed=true; clearTimeout(timer); readyReject(new Error('Capture was canceled')); wait?.reject(new Error('Capture was canceled')); wait=undefined;
      track.stop();
      closePromise=reader.cancel().catch(() => {}).then(() => reader.releaseLock());
      return closePromise;
    };
    timer=setTimeout(() => { readyReject(timeoutError()); void close(); },5000);
    // Arm while controls still change the desktop and drain stale frames.
    // The granted track has a minimum refresh rate so static sources can
    // cross the three-frame barrier after their controls are hidden.
    void (async () => {
      while (!closed) {
        const result=await reader.read();
        if (closed) { result.value?.close(); return; }
        if (result.done) throw new Error('Desktop capture source was removed');
        try {
          const current=result.value.timestamp;
          if (!Number.isFinite(current) || current<=timestamp) continue;
          if (result.value.displayWidth!==recordingWidth || result.value.displayHeight!==recordingHeight) {
            throw new Error('Desktop capture dimensions changed during recording');
          }
          pacedContext?.drawImage(result.value,0,0);
          timestamp=current; if (!hasFrame) { hasFrame=true; clearTimeout(timer); readyResolve(); }
          if (wait && current>wait.after) {
            wait.after=current;
            if (--wait.remaining===0) { const resolve=wait.resolve; wait=undefined; clearTimeout(timer); resolve(); }
          }
        } finally { result.value.close(); }
      }
    })().catch(error => { readyReject(error); wait?.reject(error); void close(); if (!finished) void fail(error); });
    return {ready,close,waitForFreshFrames() {
      if (closed) return Promise.reject(new Error('Capture was canceled'));
      clearTimeout(timer);
      return new Promise((resolve,reject) => { wait={after:timestamp,remaining:3,resolve,reject}; timer=setTimeout(() => { reject(timeoutError()); void close(); },5000); });
    }};
  };
  const arm = async () => {
    if (arming || frameProbe || finished || !recordingReady || (recorder && recorder.state !== 'inactive')) return;
    arming=true;
    try {
      if (guardSource) { frameProbe=createFrameProbe(); await frameProbe.ready; }
      if (!finished) await bridge.event({type:'armed'});
    } catch (error) { await fail(error); }
    finally { arming=false; }
  };
  const start = async () => {
    if (starting || finished || !recordingReady || (recorder && recorder.state !== 'inactive')) return;
    starting = true;
    try {
      if (guardSource) {
        if (!frameProbe) throw new Error('Recording frame preparation was not completed');
        await frameProbe.waitForFreshFrames();
      }
      if (finished || closing) return;
      recorderFactory(); recorder.start(500);
      if (pacedStream) {
        const track=pacedStream.getVideoTracks()[0];
        pacingTimer=setInterval(() => {
          // PipeWire can be damage-driven. Repaint the last decoded pixels to
          // provide recording timestamps while the actual source is static.
          pacedContext.drawImage(pacedCanvas,0,0); track.requestFrame();
        },Math.max(1,Math.round(1000/fps)));
      }
      await bridge.event({type:'started'});
    } catch (error) { await fail(error); }
    finally { starting = false; }
  };
  const fail = async error => {
    if (finished) return;
    finished = true;
    await stopTracks();
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    await bridge.event({ type: 'error', message: String(error?.message || error).slice(0, 2048),
      permissionDenied: error?.name === 'NotAllowedError' || error?.name === 'SecurityError', canceled: error?.name === 'AbortError' }).catch(() => {});
  };
  bridge.onCommand(command => {
    if (finished) return;
    try {
      if (command === 'cancel') { closing = true; finished = true; stopTracks(); if (recorder?.state !== 'inactive') recorder?.stop(); return; }
      if (command === 'arm') { void arm(); }
      if (command === 'start' && (!recorder || recorder.state === 'inactive')) { void start(); }
      if (!recorder) return;
      if (command === 'pause' && recorder.state === 'recording') { recorder.pause(); void bridge.event({type:'paused'}).catch(fail); }
      if (command === 'resume' && recorder.state === 'paused') { recorder.resume(); void bridge.event({type:'resumed'}).catch(fail); }
      if (command === 'stop' && recorder.state !== 'inactive' && !closing) { closing = true; recorder.stop(); }
    } catch (error) { void fail(error); }
  });
  window.addEventListener('beforeunload', () => { closing = true; finished = true; stopTracks(); });
  let acquiring = false;
  const acquire = async () => {
    if (acquiring || finished) return;
    acquiring = true;
    const config = await configuration;
    repeatLastFrame = config.framePipeline === 'repeat-last-frame';
    guardSource = repeatLastFrame || config.framePipeline === 'guarded-source'; fps=config.fps;
    const mandatory = { chromeMediaSource:'desktop', chromeMediaSourceId:config.sourceId,
      minFrameRate:1, maxFrameRate:config.fps };
    // Window dimensions come from the real track. Thumbnail dimensions must never downscale it.
    if (config.sourceKind === 'screen') Object.assign(mandatory, {
      minWidth:config.sourceSize.width, maxWidth:config.sourceSize.width,
      minHeight:config.sourceSize.height, maxHeight:config.sourceSize.height });
    else Object.assign(mandatory, { minWidth:1, maxWidth:16384, minHeight:1, maxHeight:16384 });
    stream = config.acquisition === 'portal'
      ? await navigator.mediaDevices.getDisplayMedia({ audio:false, video:{ frameRate:config.fps,
          resizeMode:'none', width:{ideal:16384,max:16384}, height:{ideal:16384,max:16384} } })
      : await navigator.mediaDevices.getUserMedia({ audio:false, video:{ mandatory } });
    if (finished) { stopTracks(); return; }
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
      if (!closing && !finished) void fail(new Error('Desktop capture source was removed'));
    }));
    const video = document.createElement('video'); video.muted = true;
    // Observe metadata before attaching the granted stream. Constraints can
    // renegotiate frames asynchronously and need an active stream consumer.
    const metadata=new Promise((resolve,reject) => { video.onloadedmetadata=resolve; video.onerror=reject; });
    void metadata.catch(() => {});
    video.srcObject=stream; document.body.append(video);
    if (config.sourceFrameRateFloor) {
      // getDisplayMedia disallows min constraints in its initial request. Once
      // granted, a supported minimum rate keeps static sources refreshable.
      const track=stream.getVideoTracks()[0];
      await track.applyConstraints({...track.getConstraints(),frameRate:{min:config.sourceFrameRateFloor,ideal:fps,max:fps}});
      if (finished) { stopTracks(); return; }
    }
    await metadata;
    await video.play();
    if (finished) { stopTracks(); return; }
    let width = video.videoWidth, height = video.videoHeight;
    if (!width || !height) throw new Error('Desktop capture returned an empty video track');
    if (config.mode === 'snapshot' || config.preview) {
      await new Promise((resolve, reject) => {
        let settled = false, frameCallback;
        const finish = error => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback);
          cancelFrameWait = undefined;
          if (error) reject(error); else resolve();
        };
        // Hidden Wayland windows may never receive presentation callbacks.
        // play() has begun decoding; a current frame is sufficient for the PNG
        // and avoids showing our engine on the very source being captured.
        const timer = setTimeout(() => {
          if (finished || video.readyState >= 2) finish();
          else finish(new Error('Desktop capture returned no decoded frame'));
        }, 250);
        cancelFrameWait = () => finish();
        if (video.requestVideoFrameCallback) frameCallback = video.requestVideoFrameCallback(() => finish());
        else requestAnimationFrame(() => finish());
      });
      if (finished) { stopTracks(); return; }
      width = video.videoWidth; height = video.videoHeight;
      if (video.readyState < 2 || !width || !height) throw new Error('Desktop capture returned no decoded frame');
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.getContext('2d', {colorSpace:'srgb'}).drawImage(video,0,0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
      if (!blob) throw new Error('Desktop snapshot encoding failed');
      await bridge.snapshot(await blob.arrayBuffer(),width,height);
      if (config.mode === 'snapshot') { finished = true; stopTracks(); return; }
    }
    const mime = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error('Chromium WebM recording encoder is unavailable');
    // High-quality intermediate; requested compression is applied once by ffmpeg after capture.
    const bitrate = Math.min(120000000, Math.max(4000000,width*height*config.fps*0.25));
    recordingWidth=width; recordingHeight=height;
    if (repeatLastFrame) {
      pacedCanvas=document.createElement('canvas'); pacedCanvas.width=width; pacedCanvas.height=height;
      pacedContext=pacedCanvas.getContext('2d',{colorSpace:'srgb'});
    }
    recorderFactory=() => {
      const recordingStream=pacedCanvas ? (pacedStream=pacedCanvas.captureStream(0)) : stream;
      recorder = new MediaRecorder(recordingStream,{mimeType:mime,videoBitsPerSecond:Math.round(bitrate)});
      recorder.onerror = event => void fail(event.error || new Error('MediaRecorder failed'));
      recorder.ondataavailable = event => {
        if (!event.data.size || finished) return;
        pendingBytes += event.data.size;
        if (pendingBytes > 128*1024*1024) { void fail(new Error('Recording disk writer cannot keep up')); return; }
        const blob = event.data;
        pending = pending.then(async () => {
          // Split exceptionally large timeslices before IPC; disk acknowledgement supplies backpressure.
          for (let offset=0; offset<blob.size; offset+=8*1024*1024) {
            if (finished) return;
            await bridge.chunk(sequence++,await blob.slice(offset,offset+8*1024*1024).arrayBuffer());
          }
          pendingBytes -= blob.size;
        }).catch(fail);
      };
      recorder.onstop = () => {
        void stopTracks().then(() => pending).then(async () => { if (!finished) { finished = true; await bridge.event({type:'stopped'}); } }).catch(fail);
      };
    };
    recordingReady=true;
    await bridge.event({type:'ready',width,height,mime});
  };
  window.startNuwaxCapture = () => acquire().catch(fail);
  // Portal requests need the activation supplied by the main process for the
  // user's screenshot/record command. Direct desktop sources preserve the existing path.
  configuration.then(config => {
    if (config.acquisition !== 'portal') void window.startNuwaxCapture().catch(fail);
  }).catch(fail);
})();`;
