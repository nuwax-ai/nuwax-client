/** 壳层 IM 未读快照，账号代次优先于同一代次内的修订号。 */
export interface IMUnreadSnapshot {
  sessionGeneration: number;
  revision: number;
  total: number;
  dndTotal: number;
}

export interface IMReceiverBridge {
  setNotificationEnabled(enabled: boolean): Promise<void>;
  getUnreadSnapshot(): Promise<IMUnreadSnapshot | null>;
  onUnreadChanged(listener: (snapshot: IMUnreadSnapshot | null) => void): () => void;
}

export const IM_IPC_CHANNELS = {
  NOTIFICATION_ENABLED: "nuwax:im:notify:enabled",
  UNREAD_SNAPSHOT: "nuwax:im:unread:snapshot",
  UNREAD_CHANGED: "nuwax:im:unread:changed",
} as const;
