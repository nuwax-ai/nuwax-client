import { describe, expect, it, vi } from 'vitest';
import { resolveCapturePlatform } from './index';

vi.mock('electron',()=>({powerSaveBlocker:{start:vi.fn(),stop:vi.fn()}}));
describe('capture platform composition',()=>{
  it.each(['darwin','win32'] as const)('%s keeps native recording and does not acquire a Linux sleep blocker',platform=>{
    const power={start:vi.fn(),stop:vi.fn()};const adapter=resolveCapturePlatform(platform,{portal:false,powerSaveBlocker:power});
    expect(adapter.framePipeline).toBe('source');expect(adapter.source.providesPreview).toBe(false);
    adapter.beginRecording()();expect(power.start).not.toHaveBeenCalled();
  });
  it.each([false,true])('Linux source strategy %s shares a bounded recording lifetime and idempotent blocker cleanup',portal=>{
    const power={start:vi.fn(()=>7),stop:vi.fn()};const adapter=resolveCapturePlatform('linux',{portal,powerSaveBlocker:power});
    expect(adapter.framePipeline).toBe(portal?'repeat-last-frame':'guarded-source');expect(adapter.source.providesPreview).toBe(portal);
    expect(adapter.windows.controls.hideDuringRecording).toBe(true);
    const release=adapter.beginRecording();expect(power.start).toHaveBeenCalledWith('prevent-display-sleep');
    release();release();expect(power.stop).toHaveBeenCalledOnce();expect(power.stop).toHaveBeenCalledWith(7);
  });
});
