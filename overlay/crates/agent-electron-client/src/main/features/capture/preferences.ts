import { EventEmitter } from 'node:events';

const changes = new EventEmitter();
export function notifyCapturePreferencesChanged(): void { changes.emit('changed'); }
export function onCapturePreferencesChanged(listener: () => void): () => void {
  changes.on('changed', listener);
  return () => { changes.removeListener('changed', listener); };
}
