/** 壳层 IM 未读快照，账号代次优先于同一代次内的修订号。 */
export interface IMUnreadSnapshot {
  sessionGeneration: number;
  revision: number;
  total: number;
  dndTotal: number;
}

export interface IMReceiverBridge {
  setNotificationEnabled(enabled: boolean): Promise<void>;
}

export const IM_IPC_CHANNELS = {
  NOTIFICATION_ENABLED: "nuwax:im:notify:enabled",
} as const;
