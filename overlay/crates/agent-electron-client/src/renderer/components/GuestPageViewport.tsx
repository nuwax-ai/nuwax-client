/** 为需要避开宿主顶行的整页 webview 提供可复用的视口容器。 */
import React from "react";
import { resolveGuestPageTopInset } from "./guestPageInsetPolicy";

interface GuestPageViewportProps {
  pageUrl: string;
  children: React.ReactNode;
}

export const GuestPageViewport: React.FC<GuestPageViewportProps> = ({
  pageUrl,
  children,
}) => {
  const topInset = resolveGuestPageTopInset(pageUrl, navigator.platform);

  return (
    <div
      style={{
        position: "absolute",
        top: topInset,
        left: 0,
        width: "100%",
        height: `calc(100% - ${topInset}px)`,
      }}
    >
      {children}
    </div>
  );
};
