import path from "node:path";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dialog, shell, session } from "electron";
import type {
  IpcMainInvokeEvent,
  OnBeforeRequestListenerDetails,
  Session,
  WebContents,
  WebFrameMain,
} from "electron";
import type { ReadStream } from "node:fs";
import {
  LOCAL_FILES_API_VERSION,
  LOCAL_FILES_IPC,
  LOCAL_FILES_SCHEME,
} from "@shared/features/local-files/contract";
import type {
  LocalFileTarget,
  LocalFilesContextInput,
  LocalFilesContext,
  LocalFilesResult,
  LocalFilesList,
  LocalFilesListOptions,
  LocalFilesSearchOptions,
  LocalFileSaveOptions,
  LocalFileSaved,
} from "@shared/features/local-files/contract";
import type { DesktopFeature, FeatureContext } from "../_kit/types";
import {
  containsPath,
  encodeResourcePath,
  fileFailure,
  LocalFilesFailure,
  metadata,
  relativeDirectory,
  requireString,
  resourceResponse,
} from "./files";
import {
  copyFileAtomic,
  exportWorkspaceAtomic,
  type FileOperation,
} from "./operations";

type Owner = {
  event: IpcMainInvokeEvent;
  contents: WebContents;
  processId: number;
  routingId: number;
  origin: string;
};
type Context = LocalFilesContext & {
  input: LocalFilesContextInput;
  owner: Owner;
  epoch: number;
  identity: string;
};
type Grant = {
  id: string;
  context: Context;
  root: string;
  streams: Set<ReadStream>;
};
type Operation = FileOperation & { context: Context; id: string };
type RequestSource = Pick<
  OnBeforeRequestListenerDetails,
  "frame" | "referrer" | "webContents" | "webContentsId"
>;
type RuntimeDeps = {
  dialog: Pick<typeof dialog, "showOpenDialog" | "showSaveDialog">;
  shell: Pick<typeof shell, "openPath" | "showItemInFolder">;
  fetch: typeof fetch;
  session?: Session;
};
const active = new Set<LocalFilesRuntime>();

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
function localGrantId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${LOCAL_FILES_SCHEME}:`
      ? parsed.hostname
      : null;
  } catch {
    return null;
  }
}
function initiatingGrant(
  details: OnBeforeRequestListenerDetails
): string | null {
  try {
    let frame = details.frame;
    for (
      let depth = 0;
      frame && depth < 64;
      depth += 1, frame = frame.parent ?? undefined
    ) {
      const id = localGrantId(frame.url);
      if (id) return id;
    }
    return localGrantId(details.referrer);
  } catch {
    return "invalid-frame";
  }
}
function identityKey(
  identity: { sandboxId: string; businessOrigins: string[] } | null | undefined
): string {
  return identity
    ? JSON.stringify([identity.sandboxId, [...identity.businessOrigins].sort()])
    : "";
}
function scalar(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number")
    throw new LocalFilesFailure("invalid-argument");
  return requireString(String(value));
}
function failure(error: unknown): LocalFilesResult<never> {
  return { success: false, code: fileFailure(error).code };
}
const denied: LocalFilesResult<never> = { success: false, code: "untrusted" };

export class LocalFilesRuntime {
  private readonly contexts = new Map<string, Context>();
  private readonly grants = new Map<string, Grant>();
  private readonly operations = new Map<string, Operation>();
  private readonly pendingIO = new Set<Promise<void>>();
  private readonly requests = new Map<Context, Set<AbortController>>();
  private readonly observed = new Map<WebContents, () => void>();
  // FrameTreeNode IDs survive document/process changes. Keep provenance after
  // grant revocation until the owning top-level document is replaced.
  private readonly previewFrames = new Map<WebContents, Map<number, string>>();
  private readonly sessions = new Set<Session>();
  private readonly off: Array<() => void> = [];
  private epoch = 0;
  private disposed = false;

  constructor(
    private readonly ctx: FeatureContext,
    private readonly deps: RuntimeDeps = {
      dialog,
      shell,
      fetch,
      session: session.defaultSession,
    }
  ) {
    try {
      // Electron 40 creates protocol URLLoaderFactories on the first document load.
      // Register before that load; grants can still be issued lazily after login.
      if (deps.session) this.installProtocol(deps.session);
      this.off.push(
        ctx.lifecycle.onSessionEnd(() => this.expireAll()),
        ctx.lifecycle.onQuit(async () => {
          this.expireAll();
          await Promise.allSettled([...this.pendingIO]);
        })
      );
      this.registerIpc();
      active.add(this);
    } catch (error) {
      void this.dispose();
      throw error;
    }
  }

  private owner(event: IpcMainInvokeEvent): Owner {
    if (
      !this.ctx.workspace?.isCurrentDocument(event) ||
      event.sender.isDestroyed()
    )
      throw new LocalFilesFailure("untrusted");
    const frame = event.senderFrame;
    const main = event.sender.mainFrame;
    if (
      !frame ||
      frame.parent ||
      frame.processId !== main.processId ||
      frame.routingId !== main.routingId
    )
      throw new LocalFilesFailure("untrusted");
    return {
      event,
      contents: event.sender,
      processId: frame.processId,
      routingId: frame.routingId,
      origin: originOf(frame.url),
    };
  }

  private ownerCurrent(owner: Owner): boolean {
    try {
      const main = owner.contents.mainFrame;
      return (
        !owner.contents.isDestroyed() &&
        main.processId === owner.processId &&
        main.routingId === owner.routingId &&
        originOf(main.url) === owner.origin &&
        !!this.ctx.workspace?.isCurrentDocument(owner.event)
      );
    } catch {
      return false;
    }
  }

  private valid(context: Context): boolean {
    return (
      !this.disposed &&
      this.contexts.get(context.contextId) === context &&
      context.epoch === this.epoch &&
      this.ownerCurrent(context.owner) &&
      context.identity === identityKey(this.ctx.workspace?.getIdentity())
    );
  }

  private context(event: IpcMainInvokeEvent, id: unknown): Context {
    const owner = this.owner(event);
    const context = this.contexts.get(requireString(id));
    if (!context || !this.valid(context)) {
      if (context) this.release(context);
      throw new LocalFilesFailure("expired");
    }
    if (
      context.owner.contents !== owner.contents ||
      context.owner.processId !== owner.processId ||
      context.owner.routingId !== owner.routingId ||
      context.owner.origin !== owner.origin
    ) {
      throw new LocalFilesFailure("untrusted");
    }
    return context;
  }

  private check(context: Context): void {
    if (!this.valid(context)) throw new LocalFilesFailure("expired");
  }

  private rememberFrame(
    contents: WebContents,
    frame: WebFrameMain,
    id: string
  ): void {
    if (!frame.parent || !Number.isSafeInteger(frame.frameTreeNodeId)) return;
    let frames = this.previewFrames.get(contents);
    if (!frames) this.previewFrames.set(contents, (frames = new Map()));
    frames.set(frame.frameTreeNodeId, id);
  }

  private frameGrant(
    contents: WebContents | undefined,
    frame: WebFrameMain | null | undefined
  ): string | null {
    try {
      for (let depth = 0; frame && depth < 64; depth++, frame = frame.parent) {
        const id =
          (contents &&
            this.previewFrames.get(contents)?.get(frame.frameTreeNodeId)) ||
          localGrantId(frame.url);
        if (id) return id;
      }
      return null;
    } catch {
      return "invalid-frame";
    }
  }

  sourceGrant(details: RequestSource): string | null {
    const contents =
      details.webContents ??
      [...this.observed.keys()].find(
        (item) => item.id === details.webContentsId
      );
    return (
      this.frameGrant(contents, details.frame) || localGrantId(details.referrer)
    );
  }

  private observe(contents: WebContents): void {
    if (this.observed.has(contents)) return;
    const expire = () => {
      for (const context of [...this.contexts.values()])
        if (context.owner.contents === contents) this.release(context);
    };
    const navigation = (
      details: { isMainFrame?: boolean; isSameDocument?: boolean },
      _url?: string,
      sameDocument?: boolean,
      main?: boolean
    ) => {
      if (
        (details.isMainFrame ?? main) &&
        !(details.isSameDocument ?? sameDocument)
      )
        expire();
    };
    const inPage = (_event: unknown, url: string, main: boolean) => {
      if (main)
        for (const context of [...this.contexts.values()]) {
          if (
            context.owner.contents === contents &&
            context.owner.origin !== originOf(url)
          )
            this.release(context);
        }
    };
    const guardNavigation = (
      event: Electron.Event & {
        url: string;
        isMainFrame: boolean;
        frame: WebFrameMain | null;
        initiator?: WebFrameMain | null;
      }
    ) => {
      const sourceId =
        this.frameGrant(contents, event.frame) ||
        this.frameGrant(contents, event.initiator);
      if (!sourceId) return;
      const grant = this.grants.get(sourceId);
      if (event.frame) this.rememberFrame(contents, event.frame, sourceId);
      if (
        !grant ||
        !this.valid(grant.context) ||
        grant.context.owner.contents !== contents ||
        event.isMainFrame ||
        localGrantId(event.url) !== sourceId
      )
        event.preventDefault();
    };
    const documentReplaced = () => this.previewFrames.delete(contents);
    const cleanup = () => {
      expire();
      documentReplaced();
      contents.removeListener("will-frame-navigate", guardNavigation);
      contents.removeListener("will-redirect", guardNavigation);
      contents.removeListener("did-navigate", documentReplaced);
      contents.removeListener("did-start-navigation", navigation);
      contents.removeListener("did-navigate-in-page", inPage);
      contents.removeListener("render-process-gone", expire);
      contents.removeListener("destroyed", cleanup);
      this.observed.delete(contents);
    };
    contents.on("will-frame-navigate", guardNavigation);
    contents.on("will-redirect", guardNavigation);
    contents.on("did-navigate", documentReplaced);
    contents.on("did-start-navigation", navigation);
    contents.on("did-navigate-in-page", inPage);
    contents.on("render-process-gone", expire);
    contents.once("destroyed", cleanup);
    this.observed.set(contents, cleanup);
  }

  private installProtocol(ses: Session): void {
    if (this.sessions.has(ses)) return;
    ses.protocol.handle(LOCAL_FILES_SCHEME, async (request) => {
      const grant = this.grants.get(localGrantId(request.url) ?? "");
      if (!grant || !this.valid(grant.context))
        return new Response(null, { status: 403 });
      return resourceResponse(request, {
        root: grant.root,
        origin: grant.context.owner.origin,
        streams: grant.streams,
        onAccessError: error => {
          void this.ctx.permissions?.onFileAccessError(error, () =>
            this.grants.get(grant.id) === grant && this.valid(grant.context)
          ).catch(error => this.ctx.log.warn("[LocalFiles] permission guide failed", error));
        },
        valid: () =>
          this.grants.get(grant.id) === grant && this.valid(grant.context),
      });
    });
    this.sessions.add(ses);
  }

  async resolveContext(
    event: IpcMainInvokeEvent,
    input: LocalFilesContextInput
  ): Promise<LocalFilesContext> {
    const owner = this.owner(event);
    const services = this.ctx.workspace;
    const identity = services?.getIdentity();
    if (!services || !identity) throw new LocalFilesFailure("unavailable");
    if (!input || input.sandboxId !== identity.sandboxId)
      throw new LocalFilesFailure("not-local");
    const cId = scalar(input.cId);
    const epoch = this.epoch;
    const signature = identityKey(identity);
    const rootInput = await services.resolveRoot({
      cId,
      workspacePath: input.workspacePath,
      projectId:
        input.projectId === undefined ? undefined : scalar(input.projectId),
      serviceType: input.serviceType,
      userId: input.userId === undefined ? undefined : scalar(input.userId),
    });
    if (!rootInput || !path.isAbsolute(rootInput))
      throw new LocalFilesFailure("context-unresolved");
    const root = await realpath(rootInput);
    if (!(await stat(root)).isDirectory())
      throw new LocalFilesFailure("context-unresolved");
    if (
      this.disposed ||
      epoch !== this.epoch ||
      signature !== identityKey(services.getIdentity()) ||
      !this.ownerCurrent(owner)
    )
      throw new LocalFilesFailure("expired");
    this.installProtocol(owner.contents.session);
    this.observe(owner.contents);
    const context: Context = {
      contextId: randomUUID(),
      cId,
      sandboxId: identity.sandboxId,
      root,
      input,
      owner,
      epoch,
      identity: signature,
    };
    this.contexts.set(context.contextId, context);
    return {
      contextId: context.contextId,
      cId,
      sandboxId: context.sandboxId,
      root,
    };
  }

  private releaseGrant(grant: Grant): void {
    this.grants.delete(grant.id);
    for (const stream of grant.streams) stream.destroy();
    grant.streams.clear();
  }

  private release(context: Context): void {
    this.contexts.delete(context.contextId);
    for (const grant of [...this.grants.values()])
      if (grant.context === context) this.releaseGrant(grant);
    for (const operation of this.operations.values())
      if (operation.context === context) operation.controller.abort();
    for (const request of this.requests.get(context) ?? []) request.abort();
    this.requests.delete(context);
  }

  private expireAll(): void {
    this.epoch += 1;
    for (const context of [...this.contexts.values()]) this.release(context);
  }

  private async list(
    context: Context,
    options: LocalFilesListOptions | LocalFilesSearchOptions = {},
    search = false
  ): Promise<LocalFilesList> {
    this.check(context);
    if (!options || typeof options !== "object")
      throw new LocalFilesFailure("invalid-argument");
    if (
      options.customTargetDir &&
      path.resolve(options.customTargetDir) !== context.root
    )
      throw new LocalFilesFailure("invalid-argument");
    const relativePath = await relativeDirectory(
      context.root,
      options.relativePath
    );
    const params = new URLSearchParams({
      cId: context.cId,
      userId:
        context.input.userId === undefined
          ? "local"
          : scalar(context.input.userId),
      customTargetDir: context.root,
      relativePath,
    });
    const number = (
      value: unknown,
      fallback: number,
      max = Number.MAX_SAFE_INTEGER
    ) => {
      if (value === undefined) return fallback;
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value <= 0
      )
        throw new LocalFilesFailure("invalid-argument");
      return Math.min(value, max);
    };
    params.set("type", options.type ?? (search ? "file" : "all"));
    if (search) {
      const opts = options as LocalFilesSearchOptions;
      params.set("kw", requireString(opts.kw));
      params.set("limit", String(number(opts.limit, 200, 200)));
      params.set("maxVisit", String(number(opts.maxVisit, 20000, 200000)));
      params.set("timeoutMs", String(number(opts.timeoutMs, 2000, 15000)));
    } else {
      if (
        options.recursive !== undefined &&
        typeof options.recursive !== "boolean"
      )
        throw new LocalFilesFailure("invalid-argument");
      if (options.recursive !== undefined)
        params.set("recursive", String(options.recursive));
      params.set("depth", String(number(options.depth, 2)));
      if (options.limit !== undefined)
        params.set(
          "limit",
          String(options.limit === 0 ? 0 : number(options.limit, 200))
        );
    }
    const port = this.ctx.workspace!.getFileServerPort();
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new LocalFilesFailure("file-service-unavailable");
    const controller = new AbortController();
    const requests = this.requests.get(context) ?? new Set<AbortController>();
    requests.add(controller);
    this.requests.set(context, requests);
    const timeout = setTimeout(
      () => controller.abort(),
      search
        ? number((options as LocalFilesSearchOptions).timeoutMs, 2000, 15000) +
            5000
        : 30000
    );
    try {
      this.check(context);
      const response = await this.deps.fetch(
        `http://127.0.0.1:${port}/api/computer/${
          search ? "search-files" : "get-file-list"
        }?${params}`,
        { method: "GET", signal: controller.signal }
      );
      this.check(context);
      if (!response.ok)
        throw new LocalFilesFailure(
          response.status === 403
            ? "permission-denied"
            : response.status === 404
            ? "not-found"
            : "file-service-unavailable"
        );
      const payload = await response.json();
      this.check(context);
      // Native file-server returns {success, files,...}; support its data envelope too.
      const data = payload.data ?? payload;
      if (payload.success === false || !Array.isArray(data.files))
        throw new LocalFilesFailure("file-service-unavailable");
      const { success: _success, ...result } = data;
      return result as LocalFilesList;
    } catch (error) {
      this.check(context);
      if (error instanceof LocalFilesFailure) throw error;
      throw new LocalFilesFailure("file-service-unavailable");
    } finally {
      clearTimeout(timeout);
      requests.delete(controller);
      if (!requests.size) this.requests.delete(context);
    }
  }

  private async file(event: IpcMainInvokeEvent, target: LocalFileTarget) {
    if (!target || typeof target !== "object")
      throw new LocalFilesFailure("invalid-argument");
    const context = this.context(event, target.contextId);
    const info = await metadata(context.root, target.path);
    this.check(context);
    return { context, info };
  }

  private operation(
    context: Context,
    options?: LocalFileSaveOptions
  ): Operation {
    const id =
      options?.operationId === undefined
        ? randomUUID()
        : requireString(options.operationId);
    // An operation ID belongs to one invocation; replacing it must not lose a live stream.
    if (this.operations.has(id))
      throw new LocalFilesFailure("invalid-argument");
    const operation: Operation = {
      id,
      context,
      controller: new AbortController(),
      valid: () => this.valid(context),
    };
    this.operations.set(id, operation);
    return operation;
  }

  private async save(
    context: Context,
    source: string | null,
    options?: LocalFileSaveOptions
  ): Promise<LocalFileSaved> {
    const operation = this.operation(context, options);
    try {
      const chosen = await this.deps.dialog.showSaveDialog({
        defaultPath: path.basename(
          options?.fileName ||
            (source
              ? path.basename(source)
              : `${path.basename(context.root) || "workspace"}.zip`)
        ),
        ...(source ? {} : { filters: [{ name: "ZIP", extensions: ["zip"] }] }),
      });
      this.check(context);
      if (
        chosen.canceled ||
        !chosen.filePath ||
        operation.controller.signal.aborted
      )
        return { canceled: true };
      const work = source
        ? copyFileAtomic(source, chosen.filePath, operation)
        : exportWorkspaceAtomic(context.root, chosen.filePath, operation);
      this.pendingIO.add(work);
      try {
        await work;
      } finally {
        this.pendingIO.delete(work);
      }
      return { canceled: false, path: chosen.filePath };
    } catch (error) {
      if (operation.controller.signal.aborted && this.valid(context))
        return { canceled: true };
      throw error;
    } finally {
      this.operations.delete(operation.id);
    }
  }

  private registerIpc(): void {
    const ipc = this.ctx.ipc;
    const handle = <A extends unknown[], T>(
      channel: string,
      callback: (event: IpcMainInvokeEvent, ...args: A) => T | Promise<T>
    ) => {
      ipc.handle<IpcMainInvokeEvent, A, LocalFilesResult<T>>(
        channel,
        async (event, ...args) => {
          const epoch = this.epoch;
          const identity = identityKey(this.ctx.workspace?.getIdentity());
          try {
            return { success: true, data: await callback(event, ...args) };
          } catch (error) {
            void this.ctx.permissions?.onFileAccessError(error, () =>
              !this.disposed && this.epoch === epoch && identity !== "" &&
              identity === identityKey(this.ctx.workspace?.getIdentity()) && !!this.ctx.workspace?.isCurrentDocument(event)
            ).catch(error => this.ctx.log.warn("[LocalFiles] permission guide failed", error));
            return failure(error);
          }
        },
        denied
      );
    };
    ipc.handle(
      LOCAL_FILES_IPC.GET_CAPABILITIES,
      () => {
        const identity = this.ctx.workspace?.getIdentity();
        return {
          apiVersion: LOCAL_FILES_API_VERSION,
          available: !!identity && !this.disposed,
          ...(identity ? { sandboxId: identity.sandboxId } : {}),
        };
      },
      { apiVersion: LOCAL_FILES_API_VERSION, available: false }
    );
    ipc.handle(
      LOCAL_FILES_IPC.PICK_DIRECTORY,
      async (event: IpcMainInvokeEvent) => {
        try {
          this.owner(event);
          const result = await this.deps.dialog.showOpenDialog({
            properties: ["openDirectory", "createDirectory"],
          });
          this.owner(event);
          return { canceled: result.canceled, paths: result.filePaths };
        } catch {
          return { canceled: true, paths: [] };
        }
      },
      { canceled: true, paths: [] }
    );
    handle(
      LOCAL_FILES_IPC.RESOLVE_CONTEXT,
      (event, input: LocalFilesContextInput) =>
        this.resolveContext(event, input)
    );
    ipc.handle(
      LOCAL_FILES_IPC.RELEASE_CONTEXT,
      (event: IpcMainInvokeEvent, id: string) => {
        try {
          this.release(this.context(event, id));
        } catch {
          /* Idempotent release; other owners gain no capability. */
        }
      },
      undefined
    );
    handle(
      LOCAL_FILES_IPC.LIST_FILES,
      (event, id: string, options?: LocalFilesListOptions) =>
        this.list(this.context(event, id), options)
    );
    handle(
      LOCAL_FILES_IPC.SEARCH_FILES,
      (event, id: string, options: LocalFilesSearchOptions) =>
        this.list(this.context(event, id), options, true)
    );
    handle(
      LOCAL_FILES_IPC.STAT,
      async (event, target: LocalFileTarget) =>
        (await this.file(event, target)).info
    );
    handle(
      LOCAL_FILES_IPC.PREPARE_PREVIEW,
      async (event, target: LocalFileTarget) => {
        const { context, info } = await this.file(event, target);
        if (info.isDir) throw new LocalFilesFailure("invalid-argument");
        const root = containsPath(context.root, info.path)
          ? context.root
          : path.dirname(info.path);
        const id = randomUUID();
        const baseUrl = `${LOCAL_FILES_SCHEME}://${id}/`;
        this.grants.set(id, { id, context, root, streams: new Set() });
        return {
          grantId: id,
          url: `${baseUrl}${encodeResourcePath(
            path.relative(root, info.path)
          )}`,
          baseUrl,
          mime: info.mime,
          bytes: info.size,
        };
      }
    );
    ipc.handle(
      LOCAL_FILES_IPC.RELEASE_PREVIEW,
      (event: IpcMainInvokeEvent, id: string) => {
        try {
          const grant = this.grants.get(id);
          if (grant) {
            this.context(event, grant.context.contextId);
            this.releaseGrant(grant);
          }
        } catch {
          /* expired/foreign release has no effect */
        }
      },
      undefined
    );
    handle(
      LOCAL_FILES_IPC.OPEN_PATH,
      async (event, target: LocalFileTarget) => {
        const { context, info } = await this.file(event, target);
        this.check(context);
        if (await this.deps.shell.openPath(info.path))
          throw new LocalFilesFailure("failed");
      }
    );
    handle(
      LOCAL_FILES_IPC.REVEAL_IN_FOLDER,
      async (event, target: LocalFileTarget) => {
        const { context, info } = await this.file(event, target);
        this.check(context);
        this.deps.shell.showItemInFolder(info.path);
      }
    );
    handle(
      LOCAL_FILES_IPC.SAVE_FILE,
      async (
        event,
        target: LocalFileTarget,
        options?: LocalFileSaveOptions
      ) => {
        const { context, info } = await this.file(event, target);
        if (info.isDir) throw new LocalFilesFailure("invalid-argument");
        return this.save(context, info.path, options);
      }
    );
    handle(
      LOCAL_FILES_IPC.EXPORT_WORKSPACE,
      (event, id: string, options?: LocalFileSaveOptions) =>
        this.save(this.context(event, id), null, options)
    );
    ipc.handle(
      LOCAL_FILES_IPC.CANCEL,
      (event: IpcMainInvokeEvent, id: string) => {
        try {
          const operation = this.operations.get(id);
          if (operation) {
            this.context(event, operation.context.contextId);
            operation.controller.abort();
          }
        } catch {
          /* Foreign operation cannot be canceled. */
        }
      },
      undefined
    );
  }

  /** Undefined is unrelated traffic. Every local request must pass the one host listener. */
  authorize(details: OnBeforeRequestListenerDetails): boolean | undefined {
    const id = localGrantId(details.url);
    const frame = details.frame;
    const sourceId = this.sourceGrant(details);
    if (!id && !sourceId) return undefined;
    const grant = this.grants.get(id ?? sourceId!);
    if (!grant || !this.valid(grant.context)) return false;
    const owner = grant.context.owner;
    const contents = details.webContents;
    if (
      contents
        ? contents !== owner.contents
        : details.webContentsId !== owner.contents.id
    )
      return false;
    if (sourceId && frame) this.rememberFrame(owner.contents, frame, sourceId);
    if (id) {
      if (details.resourceType === "mainFrame" || !frame) return false;
      if (sourceId && sourceId !== id) return false;
      if (sourceId === id) {
        // A remote iframe inside a local HTML preview remains a remote frame.
        return (
          localGrantId(frame.url) === id ||
          frame.url === "about:blank" ||
          frame.url === "about:srcdoc" ||
          !frame.url
        );
      }
      try {
        if (
          frame.processId === owner.processId &&
          frame.routingId === owner.routingId &&
          originOf(frame.url) === owner.origin
        )
          return true;
        // The first load of a sandboxed preview iframe starts in about:blank.
        const parent: WebFrameMain | null = frame.parent;
        const allowed =
          details.resourceType === "subFrame" &&
          (frame.url === "about:blank" || !frame.url) &&
          !!parent &&
          parent.processId === owner.processId &&
          parent.routingId === owner.routingId &&
          originOf(parent.url) === owner.origin;
        if (allowed) this.rememberFrame(owner.contents, frame, id);
        return allowed;
      } catch {
        return false;
      }
    }
    try {
      const target = new URL(details.url);
      if (
        details.resourceType === "mainFrame" ||
        details.resourceType === "subFrame"
      )
        return false;
      const blocked = new Set(
        this.ctx.workspace?.getIdentity()?.businessOrigins ?? []
      );
      return (
        !blocked.has(target.origin) &&
        !["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"].includes(
          target.hostname.toLowerCase()
        )
      );
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.expireAll();
    for (const cleanup of [...this.observed.values()]) cleanup();
    for (const off of this.off) off();
    for (const ses of this.sessions) ses.protocol.unhandle(LOCAL_FILES_SCHEME);
    this.sessions.clear();
    this.ctx.ipc.dispose();
    active.delete(this);
    await Promise.allSettled([...this.pendingIO]);
  }
}

export function authorizeLocalFilesRequest(
  details: OnBeforeRequestListenerDetails
): boolean | undefined {
  for (const runtime of active) {
    const result = runtime.authorize(details);
    if (result !== undefined) return result;
  }
  return localGrantId(details.url) || initiatingGrant(details)
    ? false
    : undefined;
}

export function isLocalFilesRequestSource(details: RequestSource): boolean {
  return [...active].some((runtime) => !!runtime.sourceGrant(details));
}

export const localFilesFeature: DesktopFeature = {
  id: "local-files",
  products: ["nuwax"],
  enabledByDefault: true,
  // 本机文件直访尚未提测，本次上线强制关闭，避免历史设置重新启用。
  lockedOff: "3.0.22 preserves the existing local-file release boundary",
  bridge: { namespaces: ["localFiles"] },
  requests: { authorize: authorizeLocalFilesRequest, isSource: isLocalFilesRequestSource },
  schemes: [
    {
      scheme: LOCAL_FILES_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ],
  register(ctx) {
    return new LocalFilesRuntime(ctx);
  },
};
