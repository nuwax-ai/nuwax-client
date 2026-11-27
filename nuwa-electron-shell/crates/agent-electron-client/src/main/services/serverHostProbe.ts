import { net } from "electron";

/** Use Chromium's system proxy/PAC and DNS settings, without credentials or redirects. */
export function probeServerHost(origin: string): Promise<"ok" | "dns" | "unreachable"> {
  return new Promise((resolve) => {
    let request: Electron.ClientRequest | undefined;
    let settled = false;
    const finish = (result: "ok" | "dns" | "unreachable") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.abort();
      resolve(result);
    };
    const timer = setTimeout(() => finish("unreachable"), 8000);
    try {
      request = net.request({ url: origin, method: "HEAD", credentials: "omit", redirect: "manual" });
      request.on("response", () => finish("ok"));
      request.on("redirect", () => finish("ok"));
      request.on("error", (error) => finish(/ERR_NAME_NOT_RESOLVED/i.test(String(error)) ? "dns" : "unreachable"));
      request.end();
    } catch { finish("unreachable"); }
  });
}
