export const ANDROID_IPC = {
  status: "android:status",
  discover: "android:discover",
  enable: "android:enable",
  stop: "android:stop",
} as const;

export interface AndroidDevice {
  serial: string;
  state: string;
  model: string;
}

export interface AndroidStatus {
  enabled: boolean;
  serial: string | null;
  adbPath: string;
  error?: string;
}

export interface AndroidBridge {
  status(): Promise<AndroidStatus>;
  discover(
    adbPath: string,
  ): Promise<{ devices: AndroidDevice[]; adbPath: string; error?: string }>;
  enable(input: { adbPath: string; serial: string }): Promise<AndroidStatus>;
  stop(): Promise<AndroidStatus>;
}
