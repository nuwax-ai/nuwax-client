import { createAnnotationHistory, createAnnotationPainter } from './annotations';
import { mountCaptureWindow } from './windowRuntime';
import { placeCaptureToolbar } from '../../../shared/features/capture/windowPlacement';
import { createCaptureIcon } from './windowIcons';

export function buildCaptureWindowHtml(nonce: string): string {
  const script = `(${mountCaptureWindow.toString()})(${createAnnotationPainter.toString()},${createAnnotationHistory.toString()},${placeCaptureToolbar.toString()},${createCaptureIcon.toString()}).catch(error=>{document.body.textContent=String(error);});`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none'"><style>
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;width:100%;height:100%;overflow:hidden;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#edf1f7;background:transparent;user-select:none;-webkit-font-smoothing:antialiased}
body{background:#12161b}
button,input{font:inherit}
button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:7px 10px;border:1px solid transparent;border-radius:7px;background:transparent;color:#c8d1dd;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s,color .12s}
button:hover:not(:disabled){background:#ffffff12;color:#fff}
button:active:not(:disabled){background:#ffffff1c}
button:disabled{opacity:.3;cursor:default}
button.selected,button[aria-pressed=true]{border-color:#38d5ae45;background:#2cd7ac20;color:#70edca}
button.selected:hover:not(:disabled),button[aria-pressed=true]:hover:not(:disabled){background:#2cd7ac30;color:#a0f6df}
button.iconOnly{width:34px;padding:7px;flex-shrink:0}
button svg{flex-shrink:0;pointer-events:none}
button:focus-visible,input:focus-visible{outline:2px solid #70edca;outline-offset:2px}
button.primary{padding-right:13px;padding-left:11px;border-color:#48d4b1;background:#32bd98;color:#092c25;font-weight:600}
button.primary:hover:not(:disabled){border-color:#7deace;background:#57d7b6;color:#07271f}
button.primary:active:not(:disabled){background:#27ab89}
button.primary:disabled{border-color:#376658;background:#285a4c;color:#a8c9bd;opacity:.65}
.selectionDock{position:fixed;z-index:7;display:flex;flex-direction:column;width:max-content;max-width:calc(100vw - 16px);padding:6px;border:1px solid #ffffff24;border-radius:13px;background:#1b222cfb;box-shadow:0 12px 36px #0005,0 2px 8px #0004}
.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;width:100%;max-width:100%}
.toolbar.tools,.toolbar.top{justify-content:space-between}
.toolbar.properties{gap:12px;padding:9px 4px;border-top:1px solid #ffffff12}
.toolbar.tools{padding-bottom:5px}
.toolbar.top{padding-top:6px;border-top:1px solid #ffffff12}
.toolbar.tools[hidden]~.toolbar.top{padding-top:0;border-top:0}
.toolGroup,.historyGroup,.modeGroup,.actionGroup{display:flex;align-items:center;flex-wrap:wrap;gap:2px;max-width:100%}
.historyGroup{padding-left:7px;border-left:1px solid #ffffff1a}
.historyGroup button[data-action=deleteAnnotation]:hover:not(:disabled){background:#ff607322;color:#ff9ca7}
.modeGroup button{padding:6px 9px;color:#aebcca}
.modeGroup button.selected{color:#83e6cc;border-color:transparent;background:#ffffff0d}
.actionGroup{gap:4px;margin-left:auto}
.styleCaption{display:flex;align-items:center;gap:5px;color:#8f9ead;font-size:11px;white-space:nowrap}
.styleCaption svg{width:14px;height:14px;flex-shrink:0}
.dockHint{max-width:100%;padding:7px 5px 2px;color:#8f9ead;font-size:11px;line-height:1.5}
.recordingNotice{position:fixed;top:54px;left:50%;transform:translateX(-50%);z-index:8;width:max-content;max-width:calc(100% - 48px);padding:8px 12px;border-radius:8px;background:#18222ff2;color:#c4d0dc;font-size:12px;line-height:1.5;pointer-events:none}
.palette{display:flex;align-items:center;gap:7px}
button.swatch{width:18px;height:18px;min-height:18px;padding:0;flex-shrink:0;border:1px solid #ffffff38;border-radius:50%;box-shadow:0 0 0 2px #1b222c}
button.swatch:hover:not(:disabled){outline:1px solid #ffffff82;outline-offset:2px}
button.swatch.selected,button.swatch[aria-pressed=true]{outline:2px solid #c8f5e7;outline-offset:2px;border-color:#ffffff70;color:inherit}
.toolbar input[type=color]{appearance:none;-webkit-appearance:none;width:23px;height:23px;padding:3px;border:1px solid #738394;border-radius:6px;background:#101820;cursor:pointer}
.toolbar input[type=color]::-webkit-color-swatch-wrapper{padding:0}
.toolbar input[type=color]::-webkit-color-swatch{border:0;border-radius:2px}
.widthControl,.fontSizeControl{display:flex;align-items:center;gap:7px;max-width:100%;color:#a9b6c5}
.widthControl{margin-left:auto}
.toolbar input[type=range]{width:65px;margin:0;accent-color:#53d5b3;cursor:pointer}
.widthValue{min-width:18px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;color:#cbd7e4}
.fontSizeControl{gap:4px;margin-left:auto}
.fontSizeControl>span{padding-right:2px;font-size:12px;color:#93a3b5}
.fontSizeControl input{width:51px;height:27px;padding:3px 5px;border:1px solid #ffffff24;border-radius:5px;background:#111820;color:#edf1f7;font-size:12px}
.fontSizeControl input:hover{border-color:#ffffff45}
button.fontPreset{min-height:27px;padding:3px 6px;border-radius:5px;font-size:11px;font-variant-numeric:tabular-nums;color:#9eafbf}
button.fontPreset.selected,button.fontPreset[aria-pressed=true]{color:#92ecd5}
.viewport{position:absolute;overflow:hidden}
.frame,.mask{position:absolute;inset:0;width:100%;height:100%}
.mask{cursor:crosshair}
.hint{position:fixed;z-index:3;left:50%;transform:translateX(-50%);max-width:calc(100vw - 24px);padding:9px 13px;border:1px solid #ffffff1c;border-radius:8px;background:#151e29ee;color:#d7e1ec;line-height:1.5;text-align:center;box-shadow:0 4px 16px #0003;pointer-events:none}
.dimensions{white-space:nowrap;position:fixed;z-index:4;padding:4px 8px;border:1px solid #ffffff24;border-radius:5px;background:#151e29ed;color:#e6edf5;font-size:11px;font-variant-numeric:tabular-nums;box-shadow:0 2px 8px #0003;pointer-events:none}
.magnifier{position:fixed;z-index:4;width:160px;height:160px;border:2px solid #d6eee7;border-radius:8px;box-shadow:0 8px 28px #0007;pointer-events:none}
.tooltip{position:fixed;z-index:20;max-width:calc(100vw - 16px);padding:6px 9px;border:1px solid #ffffff25;border-radius:6px;background:#101720fa;color:#e8eff7;font-size:11px;line-height:1.5;box-shadow:0 4px 14px #0004;pointer-events:none;white-space:normal}
.sourceGrid{position:fixed;z-index:6;inset:76px clamp(12px,4vw,50px) 85px;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(190px,100%),1fr));gap:12px;align-content:start;overflow:auto;padding:clamp(12px,2vw,20px);border:1px solid #ffffff25;border-radius:14px;background:#18212af7;box-shadow:0 16px 48px #0005;scrollbar-width:thin;scrollbar-color:#4b5b6b transparent}
button.source{min-width:0;min-height:160px;display:flex;flex-direction:column;align-items:stretch;gap:10px;padding:10px;border:1px solid #ffffff12;border-radius:9px;background:#ffffff05;white-space:normal;overflow:hidden;text-align:left}
button.source:hover:not(:disabled){border-color:#5cddbb88;background:#2cd7ac0c}
.source img{width:100%;height:120px;border-radius:5px;background:#0d141b;object-fit:contain}
.source span{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d7e1ec;font-size:12px}
.textInput{position:fixed;z-index:10;display:none;min-width:140px;padding:5px;border:2px solid #53d5b3;border-radius:4px;background:#18222ff5;color:#edf1f7;box-shadow:0 2px 12px #0004;text-shadow:0 0 1px #ffffffb3}
.textInput::placeholder{color:#8ea0b3;text-shadow:none}
.textInput:focus-visible{outline:none}
.border{background:transparent;border:3px solid #ed4c60;border-radius:0;outline:0;box-shadow:none;pointer-events:none}
.border[data-state=paused]{border-color:#f6bb4f;border-style:dashed}
.controlBody{background:transparent;padding:4px}
.controlBar{height:52px;display:flex;align-items:center;gap:6px;padding:0 9px;border:1px solid #ffffff24;border-radius:11px;background:#1b222cfb;-webkit-app-region:drag}
.controlBar::before{content:'';width:7px;height:7px;border-radius:50%;background:#fb6477;box-shadow:0 0 0 3px #fb64771c;flex-shrink:0}
.controlBar[data-state=paused]::before{background:#f6bb4f;box-shadow:0 0 0 3px #f6bb4f1c}
.controlBar[data-state=countdown]::before{background:#53d5b3;box-shadow:0 0 0 3px #53d5b31c}
.controlBar[data-state=encoding]::before{background:#9cabb9;box-shadow:0 0 0 3px #9cabb91c}
.controlBar .status{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#a8b7c8}
.controlBar .timer{min-width:50px;margin-right:4px;font:500 16px ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;color:#f0f5fb}
.controlBar .timing{display:flex;flex-direction:column;align-items:center;flex-shrink:0;line-height:18px;white-space:nowrap}
.controlBar .remainingTime{font-size:10px;color:#a8b7c8}
.controlBar button{padding:7px 8px;flex-shrink:0;-webkit-app-region:no-drag}
.controlBar button.iconOnly{padding:7px}
button.danger{border-color:#f6647530;background:#f6647520;color:#ff9ca7}
button.danger:hover:not(:disabled){border-color:#fa83924d;background:#f6647533;color:#ffd1d7}
@media(max-width:480px){.toolbar.properties{gap:10px}.styleCaption{width:100%}.sourceGrid{inset:68px 10px 76px;gap:10px}.selectionDock{padding:5px}.toolGroup,.historyGroup{gap:1px}.modeGroup button{padding-right:6px;padding-left:6px}}
</style></head><body><script nonce="${nonce}">${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
