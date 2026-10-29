import { describe, expect, it, vi } from 'vitest';
import { desktopSource, portalSource, type RecordingSourceContext } from './sources';
import type { CaptureSelection, CaptureWindowImage } from '@shared/features/capture/windowContract';

const size={width:200,height:100};
const selection: CaptureSelection={sourceId:'portal',sourceKind:'screen',coordinateSpace:'source',sourceSize:size,
  crop:{x:20,y:10,width:60,height:40},hdrToneMapped:false};
const image: CaptureWindowImage={dataUrl:'data:image/png;base64,eA==',...size,selection};
function context(): RecordingSourceContext {
  return {signal:new AbortController().signal,fps:30,framePipeline:'repeat-last-frame',
    windows:{select:vi.fn(async()=>selection),selectPrepared:vi.fn(async()=>selection)},
    open:vi.fn(async()=>({}) as any),ready:Promise.resolve(size),preview:Promise.resolve(image)};
}
describe('capture source acquisition ordering',()=>{
  it('selects a desktop source before opening its stream',async()=>{
    const c=context();const select=vi.mocked(c.windows.select),open=vi.mocked(c.open);
    const result=await desktopSource.acquireRecording(c);
    expect(select.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
    expect(open).toHaveBeenCalledOnce();expect(result).toEqual({selection,size});
  });
  it('reuses the authorized portal preview and never performs desktop selection',async()=>{
    const c=context();const result=await portalSource.acquireRecording(c);
    expect(c.windows.select).not.toHaveBeenCalled();expect(c.open).toHaveBeenCalledOnce();
    expect(c.open).toHaveBeenCalledWith(expect.objectContaining({acquisition:'portal',preview:true,framePipeline:'repeat-last-frame'}));
    expect(c.windows.selectPrepared).toHaveBeenCalledWith('record',image,c.signal);
    expect(result?.selection.coordinateSpace).toBe('source');expect(result?.selection).not.toHaveProperty('displayId');
  });
  it('does not open a stream when desktop selection is canceled',async()=>{
    const c=context();vi.mocked(c.windows.select).mockResolvedValue(null);
    expect(await desktopSource.acquireRecording(c)).toBeNull();expect(c.open).not.toHaveBeenCalled();
  });
  it('does not create a portal selector after cancellation during the authorized preview',async()=>{
    const c=context();const controller=new AbortController();c.signal=controller.signal;
    c.preview=Promise.resolve(image).then(value=>{controller.abort();return value;});
    expect(await portalSource.acquireRecording(c)).toBeNull();
  });
  it('keeps screenshot acquisition independent of a recorder and respects a late cancellation',async()=>{
    const controller=new AbortController();const select=vi.fn(),selectPrepared=vi.fn(async()=>image);
    const capturePortalFrame=vi.fn(async()=>{controller.abort();return image;});
    expect(await portalSource.acquireStill({signal:controller.signal,select,selectPrepared,capturePortalFrame})).toBeNull();
    expect(capturePortalFrame).toHaveBeenCalledOnce();expect(select).not.toHaveBeenCalled();expect(selectPrepared).not.toHaveBeenCalled();
  });
});
