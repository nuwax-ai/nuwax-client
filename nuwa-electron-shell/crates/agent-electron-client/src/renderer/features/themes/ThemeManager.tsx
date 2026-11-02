import { relativeThemeDetail } from "./errors";
import { getThemesBridge } from "./state";
import React, { useState } from "react";
import { Alert, Button, Modal, Select, Space } from "antd";
import type {
  HostThemeResult,
  HostThemesState,
} from "@shared/types/hostBridge";
import {
  encodeThemeText,
  officialThemePackage,
  validateThemePackage,
} from "@shared/features/themes/core";
import {
  readThemeZip,
  writeThemeZip,
} from "@shared/features/themes/core/archive";

async function download(files: Record<string, string>, id: string) {
  const blob = await writeThemeZip(files);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${id}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ThemeManager({
  state,
  t: translate,
}: {
  state: HostThemesState;
  t: (key: string) => string;
}) {
  const text = (key: string) => translate(`Claw.Themes.${key}`);
  function confirm(key: string): Promise<boolean> {
    return new Promise((resolve) =>
      Modal.confirm({
        title: text(key),
        okText: text("confirm"),
        cancelText: text("cancel"),
        onOk: () => {
          resolve(true);
        },
        onCancel: () => resolve(false),
      })
    );
  }

  const bridge = getThemesBridge()!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = state.themes.find(
    (item) => item.id === state.selection.themeId
  );
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(
        relativeThemeDetail(error instanceof Error ? error.message : "") ||
          text("storageError")
      );
    } finally {
      setBusy(false);
    }
  };
  const consume = (result: HostThemeResult) => {
    if (!result.ok && !result.canceled)
      throw new Error(result.error || "Theme operation failed");
  };
  const importFile = async (file: File) => {
    let files;
    try {
      files = await readThemeZip(file);
    } catch (error) {
      // Archive/validator errors contain package-relative paths; never display host storage errors.
      const detail = error instanceof Error ? error.message : "";
      setError(
        `${text("invalidPackage")}${
          detail && !/(?:[A-Z]:\\|\/Users\/|\/home\/|\/private\/)/i.test(detail)
            ? `: ${detail}`
            : ""
        }`
      );
      return;
    }
    const pkg = validateThemePackage(files);
    let result = await bridge.install(files);
    if (result.conflict) {
      if (!(await confirm("replaceMessage"))) return;
      result = await bridge.install(files, true);
    }
    consume(result);
    if (result.ok)
      consume(
        await bridge.select(
          pkg.manifest.id,
          pkg.manifest.variants.light ? "light" : "dark"
        )
      );
  };
  return (
    <section data-theme-part="theme-manager" aria-label={text("title")}>
      <h3>{text("title")}</h3>
      <p>{text("deviceScope")}</p>
      {state.recovery && (
        <Alert type="info" showIcon message={text("recovery")} />
      )}
      {(error || state.error) && (
        <Alert
          type="error"
          showIcon
          message={
            error ||
            (relativeThemeDetail(state.error)
              ? `${text("invalidLocal")}: ${relativeThemeDetail(state.error)}`
              : text("invalidLocal"))
          }
        />
      )}
      <Space wrap>
        <Select
          aria-label={text("selection")}
          disabled={busy}
          value={state.selection.themeId}
          style={{ minWidth: 180 }}
          options={state.themes.map((item) => ({
            value: item.id,
            label: item.name,
          }))}
          onChange={(id) =>
            void perform(async () => {
              const modes = state.themes.find((item) => item.id === id)!.modes;
              const mode = modes.length === 2 ? state.selection.mode : modes[0];
              consume(await bridge.select(id, mode));
            })
          }
        />
        <Select
          aria-label={text("mode")}
          disabled={busy}
          value={state.selection.mode}
          options={[
            ...(selected?.modes ?? ["light"]),
            ...(selected?.modes.length === 2 ? ["system"] : []),
          ].map((value) => ({ value, label: text(value) }))}
          onChange={(mode) =>
            void perform(async () =>
              consume(
                await bridge.select(
                  state.selection.themeId,
                  mode as "light" | "dark" | "system"
                )
              )
            )
          }
        />
        <label>
          <Button
            disabled={busy}
            onClick={() => document.getElementById("theme-zip-input")?.click()}
          >
            {text("import")}
          </Button>
          <input
            id="theme-zip-input"
            hidden
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void perform(() => importFile(file));
            }}
          />
        </label>
        <Button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const result = await bridge.exportPackage(
                state.selection.themeId
              );
              if (!result.files) throw new Error("Theme export failed");
              await download(result.files, state.selection.themeId);
            })
          }
        >
          {text("export")}
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const manifest = {
                ...officialThemePackage.manifest,
                id: "my-theme",
                name: "My Theme",
              };
              await download(
                {
                  ...officialThemePackage.files,
                  "theme.json": encodeThemeText(
                    JSON.stringify(manifest, null, 2)
                  ),
                },
                "my-theme"
              );
            })
          }
        >
          {text("template")}
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void perform(async () => consume(await bridge.linkDirectory()))
          }
        >
          {text("link")}
        </Button>
        {selected &&
          selected.source !== "builtin" &&
          !["nuwax-default", "deepseek-inspired"].includes(selected.id) && (
            <>
              <Button
                disabled={busy}
                onClick={() =>
                  void perform(async () =>
                    consume(await bridge.openDirectory(state.selection.themeId))
                  )
                }
              >
                {text("open")}
              </Button>
              <Button
                danger
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (await confirm("removeMessage"))
                      consume(await bridge.remove(state.selection.themeId));
                  })
                }
              >
                {text("remove")}
              </Button>
            </>
          )}
        <Button
          disabled={busy}
          onClick={() =>
            void perform(async () =>
              consume(await bridge.select("nuwax-default", "light"))
            )
          }
        >
          {text("restore")}
        </Button>
      </Space>
    </section>
  );
}
