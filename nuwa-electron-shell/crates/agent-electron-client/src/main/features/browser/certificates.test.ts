import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmBrowserCertificates } from "./certificates";

const { prompt } = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock("electron", () => ({ dialog: { showMessageBox: prompt } }));

const origin = "https://unsafe.example:8998";
const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.resetAllMocks();
});

function fixture(initialUrl?: string, session = {}) {
  const contents = Object.assign(new EventEmitter(), {
    getURL: () => "about:blank",
    isDestroyed: () => false,
    session,
  });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isVisible: () => false,
    show: vi.fn(),
  });
  const dispose = confirmBrowserCertificates(window as never, contents as never, (key) => key, initialUrl);
  disposers.push(dispose);
  const navigate = (url = origin) => contents.emit("did-start-navigation", {}, url, false, true);
  const fail = ({ url = origin + "/entry", data = "certificate A", error = "net::ERR_CERT_AUTHORITY_INVALID", main = true } = {}) => {
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    contents.emit("certificate-error", event, url, error, { data }, callback, main);
    return { event, callback };
  };
  return { contents, window, navigate, fail, dispose };
}

function deferPrompt() {
  let resolve!: (result: { response: number }) => void;
  prompt.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  return async (response: number) => {
    resolve({ response });
    await Promise.resolve();
  };
}

describe("browser certificate risk confirmation", () => {
  it("defaults to cancel and explains the exact site and certificate risk before trusting it", async () => {
    const decide = deferPrompt();
    const f = fixture();
    f.navigate();
    const request = f.fail();
    expect(request.event.preventDefault).toHaveBeenCalledOnce();
    expect(request.callback).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledWith(f.window, expect.objectContaining({
      type: "warning", defaultId: 0, cancelId: 0,
      buttons: ["Claw.Browser.certificateCancel", "Claw.Browser.certificateContinue"],
      detail: expect.stringContaining(origin),
    }));
    expect(prompt.mock.calls[0][1].detail).toContain("Claw.Browser.certificateAuthority");
    expect(f.window.show).toHaveBeenCalledOnce();
    await decide(0);
    expect(request.callback.mock.calls).toEqual([[false]]);
    prompt.mockResolvedValueOnce({ response: 0 });
    f.fail();
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("allows explicit consent and explains new certificate errors on subsequent challenges", async () => {
    prompt.mockResolvedValueOnce({ response: 1 });
    const f = fixture(origin + "/entry");
    const first = f.fail();
    await Promise.resolve();
    expect(first.callback.mock.calls).toEqual([[true]]);
    expect(f.fail({ url: origin + "/app.js", main: false }).callback.mock.calls).toEqual([[true]]);
    expect(prompt).toHaveBeenCalledOnce();

    const decideChanged = deferPrompt();
    const changed = f.fail({ data: "certificate B" });
    expect(changed.callback).not.toHaveBeenCalled();
    await decideChanged(0);
    expect(changed.callback.mock.calls).toEqual([[false]]);

    const decideExpired = deferPrompt();
    const expired = f.fail({ error: "net::ERR_CERT_DATE_INVALID" });
    expect(prompt.mock.calls.at(-1)?.[1].detail).toContain("Claw.Browser.certificateDate");
    await decideExpired(0);
    expect(expired.callback.mock.calls).toEqual([[false]]);
  });

  it("keeps accepted host/certificate scope across ports and revisits, with separate prompts for new hosts", async () => {
    prompt.mockResolvedValue({ response: 1 });
    const f = fixture();
    f.navigate();
    f.fail();
    await Promise.resolve();
    const other = fixture();
    other.navigate();
    other.fail();
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledTimes(2);

    const redirected = "https://unsafe.example:9999";
    f.contents.emit("did-redirect-navigation", {}, redirected, false, true);
    f.fail({ url: redirected });
    await Promise.resolve();
    f.navigate("https://elsewhere.example");
    f.fail({ url: "https://elsewhere.example/" });
    await Promise.resolve();
    f.navigate(origin);
    f.fail();
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it("reuses consent for same-certificate resources in a shared session, while rejecting other sessions and changed certificates", async () => {
    prompt.mockResolvedValueOnce({ response: 1 });
    const session = {};
    const first = fixture(origin, session);
    first.fail();
    await Promise.resolve();
    const second = fixture(origin, session);
    expect(second.fail({ main: false }).callback.mock.calls).toEqual([[true]]);
    expect(second.fail({ main: false, data: "another certificate" }).callback.mock.calls).toEqual([[false]]);
    expect(second.fail({ main: false, error: "net::ERR_CERT_DATE_INVALID" }).callback.mock.calls).toEqual([[false]]);
    const separate = fixture(origin);
    expect(separate.fail({ main: false }).callback.mock.calls).toEqual([[false]]);
    expect(prompt).toHaveBeenCalledOnce();
    first.dispose();
    expect(second.fail({ main: false }).callback.mock.calls).toEqual([[true]]);
  });

  it("shares one pending confirmation for matching main-frame challenges", async () => {
    const decide = deferPrompt();
    const f = fixture(origin);
    const first = f.fail();
    const second = f.fail();
    expect(prompt).toHaveBeenCalledOnce();
    await decide(1);
    expect(first.callback.mock.calls).toEqual([[true]]);
    expect(second.callback.mock.calls).toEqual([[true]]);
  });

  it("cannot apply consent from a replaced certificate challenge", async () => {
    const decideOld = deferPrompt();
    const f = fixture(origin);
    const old = f.fail();
    const oldSignal = prompt.mock.calls[0][1].signal as AbortSignal;
    const decideCurrent = deferPrompt();
    const current = f.fail({ data: "replacement certificate" });
    expect(old.callback.mock.calls).toEqual([[false]]);
    expect(oldSignal.aborted).toBe(true);
    await decideOld(1);
    expect(current.callback).not.toHaveBeenCalled();
    await decideCurrent(0);
    expect(current.callback.mock.calls).toEqual([[false]]);
  });

  it.each(["navigation", "stop", "destroyed", "closed", "dispose"])(
    "rejects pending requests on %s and ignores a late Continue result",
    async (action) => {
      const decide = deferPrompt();
      const f = fixture(origin);
      const request = f.fail();
      const signal = prompt.mock.calls[0][1].signal as AbortSignal;
      if (action === "navigation") f.navigate(origin + "/replacement");
      if (action === "stop") f.contents.emit("did-stop-loading");
      if (action === "destroyed") f.contents.emit("destroyed");
      if (action === "closed") f.window.emit("closed");
      if (action === "dispose") f.dispose();
      expect(signal.aborted).toBe(true);
      expect(request.callback.mock.calls).toEqual([[false]]);
      await decide(1);
      expect(request.callback).toHaveBeenCalledTimes(1);
      if (["destroyed", "closed", "dispose"].includes(action)) {
        expect(f.contents.listenerCount("certificate-error")).toBe(0);
      } else {
        prompt.mockResolvedValueOnce({ response: 0 });
        f.fail();
        expect(prompt).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("rejects unseen subresources, stale challenges and non-HTTPS or credential-bearing addresses", () => {
    const f = fixture(origin);
    for (const options of [
      { main: false },
      { url: "https://other.example" },
      { url: "http://unsafe.example" },
      { url: "https://user:secret@unsafe.example:8998" },
      { url: "not a URL" },
      { data: "" },
    ]) {
      expect(f.fail(options).callback.mock.calls).toEqual([[false]]);
    }
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each(["reject", "throw"])("keeps verification enforced when the native dialog fails: %s", async (mode) => {
    if (mode === "reject") prompt.mockRejectedValueOnce(new Error("dialog unavailable"));
    else prompt.mockImplementationOnce(() => { throw new Error("dialog unavailable"); });
    const f = fixture(origin);
    const request = f.fail({ error: "net::ERR_CERT_COMMON_NAME_INVALID" });
    await Promise.resolve();
    expect(request.callback.mock.calls).toEqual([[false]]);
    expect(prompt.mock.calls[0][1].detail).toContain("Claw.Browser.certificateName");
  });
});
