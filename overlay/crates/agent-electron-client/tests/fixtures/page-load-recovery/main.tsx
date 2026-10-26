/** Visual fixture for the actual recovery component. This is not packaged-app acceptance. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PageLoadRecovery,
  type RecoveryMode,
  type RecoveryStage,
} from "../../../src/renderer/components/PageLoadRecovery";
import "./preview.css";
function Preview() {
  const query = new URLSearchParams(location.search);
  const [mode, setMode] = useState<RecoveryMode>(
    (query.get("mode") || "failed") as RecoveryMode,
  );
  const [stage, setStage] = useState<RecoveryStage>(
    (query.get("stage") || "load") as RecoveryStage,
  );
  const [dark, setDark] = useState(query.get("theme") === "dark");
  return (
    <div data-theme={dark ? "dark" : "light"}>
      <nav>
        <strong>真实组件预览 · 非客户端实机验收</strong>
        <select
          aria-label="状态"
          value={mode}
          onChange={(event) => setMode(event.target.value as RecoveryMode)}
        >
          {["loading", "waiting", "failed", "reloading"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label="阶段"
          value={stage}
          onChange={(event) => setStage(event.target.value as RecoveryStage)}
        >
          {["load", "crash", "resolve", "services"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={dark}
            onChange={(event) => setDark(event.target.checked)}
          />
          深色
        </label>
      </nav>
      <main>
        <PageLoadRecovery
          mode={mode}
          stage={stage}
          lang={query.get("lang") || "zh-CN"}
          code={mode === "failed" ? -105 : undefined}
          onReload={() => setMode("reloading")}
          onOpenSettings={() => alert("预览入口：客户端实际会打开现有设置面板")}
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
