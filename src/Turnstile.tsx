import { useEffect, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render(container: HTMLElement, options: Record<string, unknown>): string;
      remove(widgetId: string): void;
    };
  }
}

let loader: Promise<void> | undefined;

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-yuzhi-turnstile]");
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("TURNSTILE_LOAD_FAILED")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.yuzhiTurnstile = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("TURNSTILE_LOAD_FAILED"));
    document.head.append(script);
  });
  return loader;
}

export function Turnstile({ onToken, onError }: { onToken: (token: string) => void; onError: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let widgetId: string | undefined;
    let active = true;
    void loadTurnstile().then(() => {
      if (!active || !root.current || !window.turnstile) return;
      widgetId = window.turnstile.render(root.current, {
        sitekey: import.meta.env.VITE_TURNSTILE_SITE_KEY || "1x00000000000000000000AA",
        action: "start-yuzhi",
        theme: "dark",
        size: "flexible",
        callback: onToken,
        "error-callback": onError,
        "expired-callback": onError,
      });
    }).catch(onError);
    return () => {
      active = false;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [onError, onToken]);
  return <div ref={root} className="turnstile-slot" aria-label="安全验证" />;
}
