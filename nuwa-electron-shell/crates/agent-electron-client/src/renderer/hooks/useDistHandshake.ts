import { useEffect, useRef, useState } from "react";
import { observeDistHandshake, type DistHandshakeState } from "../services/distHandshake";

export function useDistHandshake(enabled = true) {
  const [state, setState] = useState<DistHandshakeState & { observedAt: number }>({ snapshot: null, checking: false, observedAt: 0 });
  const observer = useRef<ReturnType<typeof observeDistHandshake> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const current = observeDistHandshake(window.electronAPI, next => setState({ ...next, observedAt: Date.now() }));
    observer.current = current;
    // Age the displayed result locally; a clock tick must not recheck the cloud.
    const clock = setInterval(() => {
      setState(previous => ({ ...previous, observedAt: Date.now() }));
    }, 60_000);
    const focus = () => { void current.refresh(); };
    window.addEventListener("focus", focus);
    void current.refresh();
    return () => {
      clearInterval(clock);
      current.dispose();
      observer.current = null;
      window.removeEventListener("focus", focus);
    };
  }, [enabled]);
  return { ...state, ...(!enabled ? { snapshot: null, checking: false } : {}), refresh: () => observer.current?.refresh(true) };
}
