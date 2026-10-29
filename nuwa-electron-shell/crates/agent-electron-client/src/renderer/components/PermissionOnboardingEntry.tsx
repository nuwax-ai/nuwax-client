import { useEffect, useRef } from "react";
import {
  isPermissionGuideTarget,
  supportsPermissionGuide,
  type PermissionGuideTarget,
} from "@shared/types/permissionOnboarding";

/** Mount once with the host. The guide itself is mounted only while its tab is visible. */
export default function PermissionOnboardingEntry({
  ready,
  onOpen,
}: {
  ready: boolean;
  onOpen(target: PermissionGuideTarget): void;
}) {
  const opened = useRef(false);
  const available = supportsPermissionGuide(navigator.platform);
  useEffect(() => {
    if (!available) return;
    const open = (target: unknown) => {
      if (!isPermissionGuideTarget(target)) return;
      opened.current = true;
      onOpen(target);
      void window.electronAPI?.permissionOnboarding
        ?.markSeen()
        .catch((error) =>
          console.error("[Permissions] could not save onboarding state", error),
        );
    };
    window.electronAPI?.on("permissions:guide", open);
    return () => window.electronAPI?.off("permissions:guide", open);
  }, [available, onOpen]);
  useEffect(() => {
    if (!available || !ready) return;
    let alive = true;
    const api = window.electronAPI?.permissionOnboarding;
    void api
      ?.snapshot()
      .then(async (snapshot) => {
        if (
          !alive ||
          !snapshot ||
          !supportsPermissionGuide(snapshot.platform) ||
          snapshot.seen ||
          opened.current
        )
          return;
        // Seen means the overview was displayed, never that system access was granted.
        opened.current = true;
        onOpen("overview");
        await api.markSeen();
      })
      .catch((error) =>
        console.error("[Permissions] initial overview unavailable", error),
      );
    return () => {
      alive = false;
    };
  }, [available, ready, onOpen]);
  return null;
}
