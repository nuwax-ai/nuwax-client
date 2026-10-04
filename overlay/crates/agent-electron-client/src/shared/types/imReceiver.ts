export type {
  HostImUnreadSnapshot as IMUnreadSnapshot,
  HostImBridge as IMReceiverBridge,
} from './hostBridge';

export const IM_IPC_CHANNELS = {
  NOTIFICATION_ENABLED: "nuwax:im:notify:enabled",
  UNREAD_SNAPSHOT: "nuwax:im:unread:snapshot",
  UNREAD_CHANGED: "nuwax:im:unread:changed",
} as const;
