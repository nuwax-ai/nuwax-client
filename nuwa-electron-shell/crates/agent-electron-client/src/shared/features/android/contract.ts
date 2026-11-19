export const ANDROID_IPC = {
  status: "android:status",
  discover: "android:discover",
  install: "android:install-adb",
  enable: "android:enable",
  stop: "android:stop",
} as const;

export const ANDROID_I18N_KEYS = {
  TITLE: "Claw.Android.title",
  ADB_PATH: "Claw.Android.adbPath",
  SETUP: "Claw.Android.setup",
  PATH_PLACEHOLDER: "Claw.Android.pathPlaceholder",
  REFRESH: "Claw.Android.refresh",
  DEVICE: "Claw.Android.device",
  DEVICE_HINT: "Claw.Android.deviceHint",
  SELECT_DEVICE: "Claw.Android.selectDevice",
  CONTROLLING: "Claw.Android.controlling",
  SCOPE: "Claw.Android.scope",
  STOP: "Claw.Android.stop",
  ENABLE: "Claw.Android.enable",
  CANCEL: "Claw.Android.cancel",
  CONFIRM_TITLE: "Claw.Android.confirmTitle",
  CONSENT: "Claw.Android.consent",
  INSTALL_TITLE: "Claw.Android.installTitle",
  INSTALL_ACCEPT: "Claw.Android.installAccept",
  INSTALL_DESC: "Claw.Android.installDesc",
  INSTALL_TERMS: "Claw.Android.installTerms",
  INSTALLING: "Claw.Android.installing",
  errors: {
    adbInstallFailed: "Claw.Android.errors.adbInstallFailed",
    adbInstallIntegrity: "Claw.Android.errors.adbInstallIntegrity",
    adbInstallUnsupported: "Claw.Android.errors.adbInstallUnsupported",
    adbMissing: "Claw.Android.errors.adbMissing",
    adbFailed: "Claw.Android.errors.adbFailed",
    deviceOffline: "Claw.Android.errors.deviceOffline",
    invalidPath: "Claw.Android.errors.invalidPath",
    loginRequired: "Claw.Android.errors.loginRequired",
    nodeMissing: "Claw.Android.errors.nodeMissing",
    gatewayFailed: "Claw.Android.errors.gatewayFailed",
    cancelled: "Claw.Android.errors.cancelled",
    noDevices: "Claw.Android.errors.noDevices",
    invalidScreenshot: "Claw.Android.errors.invalidScreenshot",
    operationFailed: "Claw.Android.errors.operationFailed",
  },
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

export interface AndroidAdbInstallOffer {
  version: string;
  bytes: number;
  sourceUrl?: string;
}

export interface AndroidBridge {
  status(): Promise<AndroidStatus>;
  discover(
    adbPath: string,
  ): Promise<{
    devices: AndroidDevice[];
    adbPath: string;
    error?: string;
    install?: AndroidAdbInstallOffer;
  }>;
  install(input: { version: string; confirmed: true }): Promise<{ error?: string }>;
  enable(input: { adbPath: string; serial: string }): Promise<AndroidStatus>;
  stop(): Promise<AndroidStatus>;
}
