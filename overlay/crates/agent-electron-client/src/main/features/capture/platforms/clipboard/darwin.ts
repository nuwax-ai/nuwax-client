import type { RunClipboardCommand } from './types';

// AppKit 标准文件 URL，无 Finder 自动化权限，也不把用户路径拼进脚本。
const SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  var url = $.NSURL.fileURLWithPath(argv[0]);
  var board = $.NSPasteboard.generalPasteboard;
  board.clearContents;
  if (!board.writeObjects($.NSArray.arrayWithObject(url))) throw new Error('file clipboard write failed');
}`;

export function createMacFileClipboard(run: RunClipboardCommand) {
  return (filePath: string, signal: AbortSignal) => run({
    executable: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', SCRIPT, '--', filePath],
  }, signal);
}
