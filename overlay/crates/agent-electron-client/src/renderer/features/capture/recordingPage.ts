/** Script runs only in a private, sandboxed BrowserWindow, with no Node APIs. */
export const recordingScript = String.raw`
(() => {
  const bridge = window.captureRecording;
  let stream, recorder, sequence = 0, pending = Promise.resolve(), pendingBytes = 0;
  let closing = false, finished = false;
  const stopTracks = () => stream?.getTracks().forEach(track => track.stop());
  const fail = async error => {
    if (finished) return;
    finished = true;
    stopTracks();
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    await bridge.event({ type: 'error', message: String(error?.message || error).slice(0, 2048),
      permissionDenied: error?.name === 'NotAllowedError' || error?.name === 'SecurityError' }).catch(() => {});
  };
  bridge.onCommand(command => {
    if (finished) return;
    try {
      if (command === 'cancel') { closing = true; finished = true; stopTracks(); if (recorder?.state !== 'inactive') recorder?.stop(); return; }
      if (!recorder) return;
      if (command === 'start' && recorder.state === 'inactive') { recorder.start(500); void bridge.event({type:'started'}).catch(fail); }
      if (command === 'pause' && recorder.state === 'recording') { recorder.pause(); void bridge.event({type:'paused'}).catch(fail); }
      if (command === 'resume' && recorder.state === 'paused') { recorder.resume(); void bridge.event({type:'resumed'}).catch(fail); }
      if (command === 'stop' && recorder.state !== 'inactive' && !closing) { closing = true; recorder.stop(); }
    } catch (error) { void fail(error); }
  });
  window.addEventListener('beforeunload', stopTracks);
  (async () => {
    const config = await bridge.config();
    const mandatory = { chromeMediaSource:'desktop', chromeMediaSourceId:config.sourceId,
      minFrameRate:1, maxFrameRate:config.fps };
    // Window dimensions come from the real track. Thumbnail dimensions must never downscale it.
    if (config.sourceKind === 'screen') Object.assign(mandatory, {
      minWidth:config.sourceSize.width, maxWidth:config.sourceSize.width,
      minHeight:config.sourceSize.height, maxHeight:config.sourceSize.height });
    else Object.assign(mandatory, { minWidth:1, maxWidth:16384, minHeight:1, maxHeight:16384 });
    stream = await navigator.mediaDevices.getUserMedia({ audio:false, video:{ mandatory } });
    const video = document.createElement('video'); video.muted = true; video.srcObject = stream;
    document.body.append(video);
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
    await video.play();
    if (finished) { stopTracks(); return; }
    const width = video.videoWidth, height = video.videoHeight;
    if (!width || !height) throw new Error('Desktop capture returned an empty video track');
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
      if (!closing && !finished) void fail(new Error('Desktop capture source was removed'));
    }));
    if (config.mode === 'snapshot') {
      await new Promise(resolve => video.requestVideoFrameCallback ? video.requestVideoFrameCallback(resolve) : requestAnimationFrame(resolve));
      if (finished) { stopTracks(); return; }
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.getContext('2d', {colorSpace:'srgb'}).drawImage(video,0,0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
      if (!blob) throw new Error('Desktop snapshot encoding failed');
      await bridge.snapshot(await blob.arrayBuffer(),width,height);
      finished = true; stopTracks(); return;
    }
    const mime = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error('Chromium WebM recording encoder is unavailable');
    // High-quality intermediate; requested compression is applied once by ffmpeg after capture.
    const bitrate = Math.min(120000000, Math.max(4000000,width*height*config.fps*0.25));
    recorder = new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:Math.round(bitrate)});
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
      stopTracks();
      void pending.then(async () => { if (!finished) { finished = true; await bridge.event({type:'stopped'}); } }).catch(fail);
    };
    await bridge.event({type:'ready',width,height,mime});
  })().catch(fail);
})();`;
