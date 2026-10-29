export interface FileClipboardCommand {
  executable: string;
  args: string[];
  input?: string;
}
export type RunClipboardCommand = (command: FileClipboardCommand, signal: AbortSignal) => Promise<void>;
export interface CaptureClipboardPlatform {
  readonly canCopyFiles: boolean;
  writeImage(filePath: string): void;
  writeFile(filePath: string, signal: AbortSignal): Promise<void>;
}
