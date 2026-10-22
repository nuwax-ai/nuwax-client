import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  open,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import type {
  IpcMainInvokeEvent,
  OnBeforeRequestListenerDetails,
  WebContents,
  WebFrameMain,
} from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ dialog: {}, shell: {} }));
import { LOCAL_FILES_IPC as IPC } from "@shared/features/local-files/contract";
import { createFeatureLifecycle } from "../_kit/lifecycle";
import { createTrustedIpc } from "../_kit/trustedIpc";
import type { FeatureContext } from "../_kit/types";
import {
  authorizeLocalFilesRequest,
  isLocalFilesRequestSource,
  localFilesFeature,
  LocalFilesRuntime,
} from "./index";

let root: string;
const runtimes: LocalFilesRuntime[] = [];
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "nuwax-local-main-"))
  );
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await rm(root, { recursive: true, force: true });
});

function contents(id: number) {
  const emitter = new EventEmitter();
  let destroyed = false;
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const frame = {
    processId: 100 + id,
    routingId: 200 + id,
    url: "https://business.example/#/chat/1",
    parent: null,
  };
  const ses = {
    protocol: {
      handle: vi.fn((_scheme, callback) => {
        handler = callback;
      }),
      unhandle: vi.fn(() => {
        handler = undefined;
      }),
    },
  };
  const wc = Object.assign(emitter, {
    id,
    mainFrame: frame,
    session: ses,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      emitter.emit("destroyed");
    },
  });
  const event = {
    sender: wc,
    senderFrame: frame,
    trusted: true,
  } as unknown as IpcMainInvokeEvent;
  return {
    wc,
    frame,
    ses,
    event,
    response: (request: Request) => handler!(request),
  };
}

function harness() {
  const one = contents(1);
  const two = contents(2);
  const listeners = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  let identity: { sandboxId: string; businessOrigins: string[] } | null = {
    sandboxId: "local-device",
    businessOrigins: ["https://business.example"],
  };
  const workspace = {
    getIdentity: vi.fn(() => identity),
    resolveRoot: vi.fn(async () => root as string | null),
    getFileServerPort: () => 12580,
    isCurrentDocument: (event: unknown) =>
      !!(event as { trusted?: boolean }).trusted,
  };
  const ipc = createTrustedIpc(
    {
      handle: (channel, listener) => {
        listeners.set(channel, listener);
      },
      removeHandler: (channel) => {
        listeners.delete(channel);
      },
    },
    workspace.isCurrentDocument
  );
  const lifecycle = createFeatureLifecycle();
  const ctx = {
    product: "nuwax",
    ipc,
    hostIpc: { handle: vi.fn(), dispose: vi.fn() },
    workspace,
    permissions: { openGuide: vi.fn(), onFileAccessError: vi.fn(async (_error: unknown, _current: () => boolean) => {}) },
    lifecycle,
    scratch: {} as FeatureContext["scratch"],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const deps = {
    dialog: {
      showOpenDialog: vi.fn(async () => ({
        canceled: false,
        filePaths: [root],
      })),
      showSaveDialog: vi.fn(async () => ({
        canceled: true,
        filePath: undefined,
      })),
    },
    shell: { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() },
    fetch: vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            files: [{ name: "note.txt", isDir: false }],
            recursive: false,
          }),
          { status: 200 }
        )
    ),
  };
  const runtime = new LocalFilesRuntime(
    ctx,
    deps as unknown as ConstructorParameters<typeof LocalFilesRuntime>[1]
  );
  runtimes.push(runtime);
  const invoke = (channel: string, event = one.event, ...args: unknown[]) =>
    Promise.resolve(listeners.get(channel)!(event, ...args)) as Promise<any>;
  const resolve = async (event = one.event) => {
    const result = await invoke(IPC.RESOLVE_CONTEXT, event, {
      cId: 1,
      sandboxId: "local-device",
      userId: 99,
      workspacePath: root,
    });
    expect(result.success).toBe(true);
    return result.data;
  };
  const details = (
    url: string,
    frame = one.frame,
    wc = one.wc,
    resourceType = "xhr"
  ) =>
    ({
      url,
      frame,
      webContents: wc,
      webContentsId: wc.id,
      resourceType,
      method: "GET",
      referrer: "",
    } as unknown as OnBeforeRequestListenerDetails);
  return {
    one,
    two,
    runtime,
    permissions: ctx.permissions,
    listeners,
    invoke,
    resolve,
    details,
    workspace,
    deps,
    lifecycle,
    setIdentity: (next: typeof identity) => {
      identity = next;
    },
  };
}

describe("local files IPC/context ownership", () => {
  it("does not guide an old operation whose OS error arrives after logout", async () => {
    const h = harness();
    let reject!: (error: unknown) => void;
    h.workspace.resolveRoot.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const pending = h.invoke(IPC.RESOLVE_CONTEXT, h.one.event, { cId: 1, sandboxId: "local-device" });
    h.lifecycle.emitSessionEnd("logout");
    reject(Object.assign(new Error("blocked"), { code: "EPERM" }));
    await pending;
    expect(h.permissions.onFileAccessError.mock.calls[0][1]()).toBe(false);
  });

  it("passes real OS failures to the host and invalidates delayed guidance after logout", async () => {
    const h = harness();
    const error = Object.assign(new Error("blocked"), { code: "EPERM" });
    h.workspace.resolveRoot.mockRejectedValueOnce(error);
    expect(await h.invoke(IPC.RESOLVE_CONTEXT, h.one.event, { cId: 1, sandboxId: "local-device" }))
      .toMatchObject({ success: false, code: "permission-denied" });
    expect(h.permissions.onFileAccessError).toHaveBeenCalledWith(error, expect.any(Function));
    const current = h.permissions.onFileAccessError.mock.calls[0][1];
    expect(current()).toBe(true);
    h.lifecycle.emitSessionEnd("logout");
    expect(current()).toBe(false);
  });

  it("declares the scheme without bypassCSP and refuses untrusted/remote/unresolved callers", async () => {
    expect(localFilesFeature.schemes?.[0]).toMatchObject({
      scheme: "nuwax-local",
      privileges: { stream: true, supportFetchAPI: true },
    });
    expect(localFilesFeature.schemes?.[0].privileges?.bypassCSP).not.toBe(true);
    const h = harness();
    const untrusted = {
      ...h.one.event,
      trusted: false,
    } as unknown as IpcMainInvokeEvent;
    expect(await h.invoke(IPC.GET_CAPABILITIES, untrusted)).toEqual({
      apiVersion: 1,
      available: false,
    });
    expect(
      await h.invoke(IPC.RESOLVE_CONTEXT, untrusted, {
        cId: 1,
        sandboxId: "local-device",
      })
    ).toMatchObject({ success: false, code: "untrusted" });
    expect(
      await h.invoke(IPC.RESOLVE_CONTEXT, h.one.event, {
        cId: 1,
        sandboxId: "remote",
      })
    ).toMatchObject({ success: false, code: "not-local" });
    h.workspace.resolveRoot.mockResolvedValueOnce(null);
    expect(
      await h.invoke(IPC.RESOLVE_CONTEXT, h.one.event, {
        cId: 1,
        sandboxId: "local-device",
      })
    ).toMatchObject({ success: false, code: "context-unresolved" });
    expect(h.one.ses.protocol.handle).not.toHaveBeenCalled();
  });

  it("passes business directory inputs, rejects stale async resolution and never derives a path from sandboxId", async () => {
    const h = harness();
    await h.resolve();
    expect(h.workspace.resolveRoot).toHaveBeenCalledWith({
      cId: "1",
      userId: "99",
      workspacePath: root,
      projectId: undefined,
      serviceType: undefined,
    });
    h.workspace.resolveRoot.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(root), 10))
    );
    const pending = h.invoke(IPC.RESOLVE_CONTEXT, h.one.event, {
      cId: 1,
      sandboxId: "local-device",
    });
    h.lifecycle.emitSessionEnd("logout");
    expect(await pending).toMatchObject({ success: false, code: "expired" });
  });

  it("preserves document grants across same-document history/query/hash changes and revokes a reload", async () => {
    const h = harness();
    await writeFile(path.join(root, "note.txt"), "note");
    const context = await h.resolve();
    const preview = (
      await h.invoke(IPC.PREPARE_PREVIEW, h.one.event, {
        contextId: context.contextId,
        path: "note.txt",
      })
    ).data;
    h.one.frame.url =
      "https://business.example/?panel=files#/chat/1?mode=preview";
    h.one.wc.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: true,
    });
    h.one.wc.emit("did-navigate-in-page", {}, h.one.frame.url, true);
    expect(
      (
        await h.invoke(IPC.STAT, h.one.event, {
          contextId: context.contextId,
          path: "note.txt",
        })
      ).success
    ).toBe(true);
    expect(authorizeLocalFilesRequest(h.details(preview.url))).toBe(true);
    expect(await (await h.one.response(new Request(preview.url))).text()).toBe(
      "note"
    );
    h.one.wc.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(
      await h.invoke(IPC.STAT, h.one.event, {
        contextId: context.contextId,
        path: "note.txt",
      })
    ).toMatchObject({ success: false, code: "expired" });
    expect(authorizeLocalFilesRequest(h.details(preview.url))).toBe(false);
  });

  it("isolates contexts by window and expires same-URL reloads, login generations and destroyed owners", async () => {
    const h = harness();
    await writeFile(path.join(root, "note.txt"), "note");
    let context = await h.resolve();
    expect(
      await h.invoke(IPC.STAT, h.two.event, {
        contextId: context.contextId,
        path: "note.txt",
      })
    ).toMatchObject({ success: false, code: "untrusted" });
    h.one.wc.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(
      await h.invoke(IPC.STAT, h.one.event, {
        contextId: context.contextId,
        path: "note.txt",
      })
    ).toMatchObject({ success: false, code: "expired" });
    context = await h.resolve();
    h.setIdentity({
      sandboxId: "another-device",
      businessOrigins: ["https://business.example"],
    });
    expect(
      await h.invoke(IPC.STAT, h.one.event, {
        contextId: context.contextId,
        path: "note.txt",
      })
    ).toMatchObject({ success: false, code: "expired" });
    h.setIdentity({
      sandboxId: "local-device",
      businessOrigins: ["https://business.example"],
    });
    context = await h.resolve();
    h.one.wc.destroy();
    expect(
      await h.invoke(IPC.STAT, h.one.event, {
        contextId: context.contextId,
        path: "note.txt",
      })
    ).toMatchObject({ success: false });
  });

  it("uses credential-free loopback list/search with identical root, defaults and bounded search options", async () => {
    const h = harness();
    const context = await h.resolve();
    await mkdir(path.join(root, "sub"));
    expect(
      (
        await h.invoke(IPC.LIST_FILES, h.one.event, context.contextId, {
          relativePath: "sub",
          recursive: false,
          depth: 3,
          type: "all",
          limit: 40,
        })
      ).data.files[0].name
    ).toBe("note.txt");
    let [url, init] = h.deps.fetch.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    let query = new URL(url);
    expect(query.origin).toBe("http://127.0.0.1:12580");
    expect(query.pathname).toBe("/api/computer/get-file-list");
    expect(query.searchParams.get("customTargetDir")).toBe(root);
    expect(query.searchParams.get("relativePath")).toBe("sub");
    expect(query.searchParams.get("userId")).toBe("99");
    expect(query.searchParams.get("depth")).toBe("3");
    expect(init.headers).toBeUndefined();
    await h.invoke(IPC.SEARCH_FILES, h.one.event, context.contextId, {
      kw: "note",
    });
    [url] = h.deps.fetch.mock.calls[1] as unknown as [string];
    query = new URL(url);
    expect(query.pathname).toBe("/api/computer/search-files");
    expect(query.searchParams.get("customTargetDir")).toBe(root);
    expect(query.searchParams.get("limit")).toBe("200");
    expect(query.searchParams.get("maxVisit")).toBe("20000");
    expect(query.searchParams.get("timeoutMs")).toBe("2000");
    expect(query.searchParams.get("type")).toBe("file");
    h.deps.fetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(
      await h.invoke(IPC.LIST_FILES, h.one.event, context.contextId)
    ).toMatchObject({ success: false, code: "file-service-unavailable" });
    expect(
      await h.invoke(IPC.LIST_FILES, h.one.event, context.contextId, {
        customTargetDir: path.dirname(root),
      })
    ).toMatchObject({ success: false, code: "invalid-argument" });
  });

  it("reads explicit external files and surfaces not-found/open failure without a proxy fallback", async () => {
    const h = harness();
    await mkdir(path.join(root, "workspace"));
    await writeFile(path.join(root, "outside.txt"), "outside");
    h.workspace.resolveRoot.mockResolvedValue(path.join(root, "workspace"));
    const context = await h.resolve();
    const target = {
      contextId: context.contextId,
      path: path.join(root, "outside.txt"),
    };
    expect((await h.invoke(IPC.STAT, h.one.event, target)).data.size).toBe(7);
    expect(
      await h.invoke(IPC.STAT, h.one.event, { ...target, path: "missing" })
    ).toMatchObject({ success: false, code: "not-found" });
    await h.invoke(IPC.REVEAL_IN_FOLDER, h.one.event, target);
    expect(h.deps.shell.showItemInFolder).toHaveBeenCalledWith(target.path);
    h.deps.shell.openPath.mockResolvedValueOnce("OS error");
    expect(await h.invoke(IPC.OPEN_PATH, h.one.event, target)).toMatchObject({
      success: false,
      code: "failed",
    });
    expect(h.deps.fetch).not.toHaveBeenCalled();
  });
});

describe("preview grants and request policy", () => {
  it("retains preview provenance across opaque document changes and grant revocation", async () => {
    const h = harness();
    await writeFile(path.join(root, "index.html"), "preview");
    const context = await h.resolve();
    const preview = (
      await h.invoke(IPC.PREPARE_PREVIEW, h.one.event, {
        contextId: context.contextId,
        path: "index.html",
      })
    ).data;
    const frame = {
      processId: 500,
      routingId: 500,
      frameTreeNodeId: 900,
      url: "about:blank",
      parent: h.one.frame,
    };
    expect(
      authorizeLocalFilesRequest(
        h.details(preview.url, frame as any, h.one.wc, "subFrame")
      )
    ).toBe(true);
    // FrameTreeNode identity survives a document/process replacement.
    const replaced = {
      ...frame,
      processId: 700,
      routingId: 701,
      url: "data:text/plain,preview",
    };
    expect(
      isLocalFilesRequestSource(
        h.details("https://cdn.example/image.png", replaced as any)
      )
    ).toBe(true);
    expect(
      authorizeLocalFilesRequest(
        h.details("https://business.example/api/data", replaced as any)
      )
    ).toBe(false);
    expect(
      authorizeLocalFilesRequest(
        h.details("http://127.0.0.1:9999/", replaced as any)
      )
    ).toBe(false);
    await h.invoke(IPC.RELEASE_PREVIEW, h.one.event, preview.grantId);
    expect(
      authorizeLocalFilesRequest(
        h.details("https://cdn.example/image.png", replaced as any)
      )
    ).toBe(false);
    expect(
      authorizeLocalFilesRequest(
        h.details(
          "https://business.example/api/data",
          replaced as any,
          h.two.wc
        )
      )
    ).toBeUndefined();
    h.one.wc.emit("did-navigate", {}, h.one.frame.url);
    expect(
      isLocalFilesRequestSource(
        h.details("https://cdn.example/image.png", replaced as any)
      )
    ).toBe(false);
  });

  it("blocks preview document navigation outside its grant before non-HTTP URLs load", async () => {
    const h = harness();
    await writeFile(path.join(root, "index.html"), "preview");
    const context = await h.resolve();
    const preview = (
      await h.invoke(IPC.PREPARE_PREVIEW, h.one.event, {
        contextId: context.contextId,
        path: "index.html",
      })
    ).data;
    const frame = {
      processId: 500,
      routingId: 500,
      frameTreeNodeId: 901,
      url: preview.url,
      parent: h.one.frame,
    };
    for (const eventName of ["will-frame-navigate", "will-redirect"]) {
      for (const url of [
        "data:text/plain,preview",
        "blob:https://business.example/fixture",
        "https://business.example/page",
      ]) {
        const event = {
          url,
          frame,
          isMainFrame: false,
          preventDefault: vi.fn(),
        };
        h.one.wc.emit(eventName, event);
        expect(event.preventDefault).toHaveBeenCalledOnce();
      }
    }
    const own = {
      url: preview.url + "#section",
      frame,
      isMainFrame: false,
      preventDefault: vi.fn(),
    };
    h.one.wc.emit("will-frame-navigate", own);
    expect(own.preventDefault).not.toHaveBeenCalled();
    const top = {
      url: "https://business.example/page",
      frame: h.one.frame,
      initiator: frame,
      isMainFrame: true,
      preventDefault: vi.fn(),
    };
    h.one.wc.emit("will-frame-navigate", top);
    expect(top.preventDefault).toHaveBeenCalledOnce();
  });

  it("permits the owner document/own resources; rejects foreign windows, remote frames, top-level and cross-grant requests", async () => {
    const h = harness();
    await writeFile(path.join(root, "index.html"), "hello");
    const context = await h.resolve();
    const first = (
      await h.invoke(IPC.PREPARE_PREVIEW, h.one.event, {
        contextId: context.contextId,
        path: "index.html",
      })
    ).data;
    const second = (
      await h.invoke(IPC.PREPARE_PREVIEW, h.one.event, {
        contextId: context.contextId,
        path: "index.html",
      })
    ).data;
    expect(authorizeLocalFilesRequest(h.details(first.url))).toBe(true);
    expect(
      authorizeLocalFilesRequest(h.details(first.url, h.two.frame, h.two.wc))
    ).toBe(false);
    expect(
      authorizeLocalFilesRequest(
        h.details(first.url, h.one.frame, h.one.wc, "mainFrame")
      )
    ).toBe(false);
    const child = {
      processId: 500,
      routingId: 500,
      url: first.url,
      parent: h.one.frame,
    };
    expect(authorizeLocalFilesRequest(h.details(first.url, child as any))).toBe(
      true
    );
    expect(
      authorizeLocalFilesRequest(h.details(second.url, child as any))
    ).toBe(false);
    const remote = { ...child, url: "https://other.example" };
    expect(
      authorizeLocalFilesRequest(h.details(first.url, remote as any))
    ).toBe(false);
    const blank = { ...child, url: "about:blank" };
    expect(
      authorizeLocalFilesRequest(
        h.details(first.url, blank as any, h.one.wc, "subFrame")
      )
    ).toBe(true);
    expect(
      authorizeLocalFilesRequest(h.details("https://unrelated.example/x"))
    ).toBeUndefined();
  });

  it("blocks business/loopback traffic and navigation from local HTML and descendant opaque/remote frames", async () => {
    const h = harness();
    await writeFile(path.join(root, "index.html"), "hello");
    const context = await h.resolve();
    const preview = (
      await h.invoke(IPC.PREPARE_PREVIEW, h.one.event, {
        contextId: context.contextId,
        path: "index.html",
      })
    ).data;
    const local = {
      processId: 500,
      routingId: 500,
      url: preview.url,
      parent: h.one.frame,
    };
    const descendant = {
      processId: 501,
      routingId: 501,
      url: "about:srcdoc",
      parent: local,
    };
    const remote = { ...descendant, url: "https://other.example/child" };
    for (const frame of [local, descendant, remote]) {
      for (const url of [
        "https://business.example/api/private",
        "http://127.0.0.1:9999/",
        "http://localhost:9999/",
        "http://[::1]/",
      ]) {
        expect(authorizeLocalFilesRequest(h.details(url, frame as any))).toBe(
          false
        );
      }
      expect(
        authorizeLocalFilesRequest(
          h.details(
            "https://other.example/",
            frame as any,
            h.one.wc,
            "subFrame"
          )
        )
      ).toBe(false);
    }
    expect(
      authorizeLocalFilesRequest(h.details(preview.url, descendant as any))
    ).toBe(true);
    expect(
      authorizeLocalFilesRequest(h.details(preview.url, remote as any))
    ).toBe(false);
    expect(
      authorizeLocalFilesRequest(
        h.details("https://cdn.example/image.png", local as any)
      )
    ).toBe(true);
  });

  it("actively closes a live stream on release/logout/navigation and makes the protocol reject revoked grants", async () => {
    const h = harness();
    const large = await open(path.join(root, "large.mp4"), "w");
    await large.truncate(110 * 1024 * 1024);
    await large.close();
    for (const revoke of ["release", "logout", "navigate"]) {
      const context = await h.resolve();
      const preview = (
        await h.invoke(IPC.PREPARE_PREVIEW, h.one.event, {
          contextId: context.contextId,
          path: "large.mp4",
        })
      ).data;
      const response = await h.one.response(new Request(preview.url));
      expect(response.status).toBe(200);
      const stream = [
        ...(h.runtime as any).grants.get(preview.grantId).streams,
      ][0] as import("node:fs").ReadStream;
      if (revoke === "release")
        await h.invoke(IPC.RELEASE_PREVIEW, h.one.event, preview.grantId);
      if (revoke === "logout") h.lifecycle.emitSessionEnd("logout");
      if (revoke === "navigate")
        h.one.wc.emit("did-start-navigation", { isMainFrame: true });
      expect(stream.destroyed).toBe(true);
      expect((await h.one.response(new Request(preview.url))).status).toBe(403);
      await expect(response.arrayBuffer()).rejects.toThrow();
    }
  });

  it("keeps release and cancel scoped to the owner and removes all handlers on dispose", async () => {
    const h = harness();
    await writeFile(path.join(root, "note.txt"), "note");
    const context = await h.resolve();
    const preview = (
      await h.invoke(IPC.PREPARE_PREVIEW, h.one.event, {
        contextId: context.contextId,
        path: "note.txt",
      })
    ).data;
    await h.invoke(IPC.RELEASE_PREVIEW, h.two.event, preview.grantId);
    expect((await h.one.response(new Request(preview.url))).status).toBe(200);
    await h.runtime.dispose();
    expect(h.listeners.size).toBe(0);
    expect(h.one.ses.protocol.unhandle).toHaveBeenCalledWith("nuwax-local");
    expect(authorizeLocalFilesRequest(h.details(preview.url))).toBe(false);
  });
});

describe("save IPC cancellation", () => {
  it("treats dialog cancel as a successful canceled result and creates no file", async () => {
    const h = harness();
    await writeFile(path.join(root, "note.txt"), "note");
    const context = await h.resolve();
    const result = await h.invoke(IPC.SAVE_FILE, h.one.event, {
      contextId: context.contextId,
      path: "note.txt",
    });
    expect(result).toEqual({ success: true, data: { canceled: true } });
    expect(await readdir(root)).toEqual(["note.txt"]);
  });

  it("cancels a live local copy, protects it against foreign cancel and cleans temporary files", async () => {
    const h = harness();
    const large = await open(path.join(root, "large.bin"), "w");
    await large.truncate(200 * 1024 * 1024);
    await large.close();
    const destination = path.join(root, "target.bin");
    await writeFile(destination, "old");
    h.deps.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: destination,
    } as any);
    const context = await h.resolve();
    const pending = h.invoke(
      IPC.SAVE_FILE,
      h.one.event,
      { contextId: context.contextId, path: "large.bin" },
      { operationId: "save-1" }
    );
    await vi.waitFor(() =>
      expect((h.runtime as any).operations.has("save-1")).toBe(true)
    );
    await h.invoke(IPC.CANCEL, h.two.event, "save-1");
    expect(
      (h.runtime as any).operations.get("save-1").controller.signal.aborted
    ).toBe(false);
    await h.invoke(IPC.CANCEL, h.one.event, "save-1");
    expect(await pending).toEqual({ success: true, data: { canceled: true } });
    expect(await readFile(destination, "utf8")).toBe("old");
    expect((await readdir(root)).some((name) => name.includes(".nuwax-"))).toBe(
      false
    );
  });
});
