import {
  dialog,
  type BrowserWindow,
  type Certificate,
  type Session,
  type WebContents,
} from "electron";
import { createHash } from "node:crypto";

// Chromium can ask again for credentialed subresources after accepting a document.
// Match its disclosed session/host/certificate scope, including other browser windows.
const approvedCertificates = new WeakMap<Session, Set<string>>();

type Challenge = {
  key: string;
  callbacks: Set<(trusted: boolean) => void>;
  abort: AbortController;
};

function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Prompt only browser-owned main documents; Chromium caches consent per session/host/certificate. */
export function confirmBrowserCertificates(
  window: BrowserWindow,
  contents: WebContents,
  translate: (key: string) => string,
  initialUrl?: string,
): () => void {
  let approved = approvedCertificates.get(contents.session);
  if (!approved) {
    approved = new Set<string>();
    approvedCertificates.set(contents.session, approved);
  }
  const sessionApprovals = approved;
  let origin = httpsOrigin(initialUrl ?? contents.getURL());
  let pending: Challenge | null = null;
  let disposed = false;
  const alive = () =>
    !disposed && !window.isDestroyed() && !contents.isDestroyed();
  const finish = (challenge: Challenge, allowed: boolean) => {
    if (pending !== challenge) return;
    pending = null;
    const trusted = allowed && alive();
    if (trusted) sessionApprovals.add(challenge.key);
    challenge.abort.abort();
    for (const callback of challenge.callbacks) {
      // Chromium may have already discarded the request after navigation/teardown.
      try {
        callback(trusted);
      } catch {
        // No live request remains.
      }
    }
  };
  const cancel = () => {
    if (pending) finish(pending, false);
  };
  const onNavigation = (
    _event: Electron.Event,
    url: string,
    inPlace: boolean,
    mainFrame: boolean,
  ) => {
    if (!mainFrame || inPlace) return;
    cancel();
    origin = httpsOrigin(url);
  };
  const onCertificate = (
    event: Electron.Event,
    url: string,
    error: string,
    certificate: Certificate,
    callback: (trusted: boolean) => void,
    mainFrame: boolean,
  ) => {
    event.preventDefault();
    const target = httpsOrigin(url);
    if (!alive() || !target || !certificate.data || target !== origin) {
      callback(false);
      return;
    }
    const key = JSON.stringify([
      new URL(target).hostname,
      createHash("sha256").update(certificate.data).digest("hex"),
      error,
    ]);
    if (sessionApprovals.has(key)) {
      callback(true);
      return;
    }
    // A third-party iframe or image cannot turn a page visit into extra trust grants.
    if (!mainFrame) {
      callback(false);
      return;
    }
    if (pending?.key === key) {
      pending.callbacks.add(callback);
      return;
    }
    cancel();
    const challenge: Challenge = {
      key,
      callbacks: new Set([callback]),
      abort: new AbortController(),
    };
    pending = challenge;
    const reason =
      error === "net::ERR_CERT_AUTHORITY_INVALID"
        ? "certificateAuthority"
        : error === "net::ERR_CERT_DATE_INVALID"
          ? "certificateDate"
          : error === "net::ERR_CERT_COMMON_NAME_INVALID"
            ? "certificateName"
            : "certificateInvalid";
    const t = (key: string) => translate(`Claw.Browser.${key}`);
    try {
      // Certificate verification can pause before the first document makes the window visible.
      if (!window.isVisible()) window.show();
      void dialog
        .showMessageBox(window, {
          type: "warning",
          title: t("certificateTitle"),
          message: t("certificateTitle"),
          detail: `${target}\n\n${t(reason)}\n\n${t("certificateWarning")}`,
          buttons: [t("certificateCancel"), t("certificateContinue")],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          signal: challenge.abort.signal,
        })
        .then(
          ({ response }) => finish(challenge, response === 1),
          () => finish(challenge, false),
        );
    } catch {
      finish(challenge, false);
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancel();
    contents.removeListener("certificate-error", onCertificate);
    contents.removeListener("did-start-navigation", onNavigation);
    contents.removeListener("did-redirect-navigation", onNavigation);
    contents.removeListener("did-stop-loading", cancel);
    contents.removeListener("destroyed", dispose);
    window.removeListener("closed", dispose);
  };
  contents.on("certificate-error", onCertificate);
  contents.on("did-start-navigation", onNavigation);
  contents.on("did-redirect-navigation", onNavigation);
  contents.on("did-stop-loading", cancel);
  contents.once("destroyed", dispose);
  window.once("closed", dispose);
  return dispose;
}
