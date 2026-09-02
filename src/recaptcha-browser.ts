import { readBoundedResponseJson } from "./bounded-response.ts";

type RecaptchaConfig = {
  readonly actions: {
    readonly confirm: string;
    readonly join: string;
  };
  readonly siteKey: string;
};

type RecaptchaGlobal = {
  readonly enterprise: {
    execute(siteKey: string, options: { action: string }): Promise<string>;
    ready(callback: () => void): void;
  };
};

declare global {
  interface Window {
    grecaptcha?: RecaptchaGlobal;
  }
}

let ready: Promise<RecaptchaConfig> | undefined;
const CONFIG_BODY_LIMIT = 4_096;
const CONFIG_TIMEOUT_MS = 5_000;
const RECAPTCHA_TIMEOUT_MS = 10_000;

export async function executeWaitlistRecaptcha(
  kind: "confirm" | "join",
): Promise<string> {
  const config = await (ready ??= loadRecaptcha());
  const action = config.actions[kind];
  const api = window.grecaptcha?.enterprise;
  if (!api) throw new Error("reCAPTCHA did not initialize");
  const token = await withTimeout(
    api.execute(config.siteKey, { action }),
    RECAPTCHA_TIMEOUT_MS,
    "reCAPTCHA execution timed out",
  );
  if (typeof token !== "string" || token.length === 0 || token.length > 4_096) {
    throw new Error("reCAPTCHA returned an invalid token");
  }
  return token;
}

async function loadRecaptcha(): Promise<RecaptchaConfig> {
  const response = await fetch("/api/waitlist/config", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("waitlist verification is unavailable");
  const value = await readBoundedResponseJson(
    response,
    CONFIG_BODY_LIMIT,
    "waitlist verification configuration",
  );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("waitlist verification configuration is invalid");
  }
  const source = value as {
    readonly actions?: { readonly confirm?: unknown; readonly join?: unknown };
    readonly siteKey?: unknown;
  };
  if (
    typeof source.siteKey !== "string" ||
    !/^[A-Za-z0-9_-]{20,100}$/.test(source.siteKey) ||
    typeof source.actions?.join !== "string" ||
    source.actions.join !== "waitlist_join" ||
    typeof source.actions.confirm !== "string" ||
    source.actions.confirm !== "waitlist_confirm"
  ) {
    throw new Error("waitlist verification configuration is invalid");
  }
  const siteKey = source.siteKey;

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        "script[data-recaptcha-enterprise]",
      );
      if (existing) {
        if (window.grecaptcha?.enterprise) resolve();
        else {
          existing.addEventListener("load", () => resolve(), { once: true });
          existing.addEventListener(
            "error",
            () => reject(new Error("reCAPTCHA failed to load")),
            { once: true },
          );
        }
        return;
      }
      const script = document.createElement("script");
      script.async = true;
      script.dataset.recaptchaEnterprise = "true";
      script.defer = true;
      script.src = `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(siteKey)}`;
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error("reCAPTCHA failed to load")), {
        once: true,
      });
      document.head.append(script);
    }),
    RECAPTCHA_TIMEOUT_MS,
    "reCAPTCHA load timed out",
  );

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const api = window.grecaptcha?.enterprise;
      if (!api) {
        reject(new Error("reCAPTCHA did not initialize"));
        return;
      }
      api.ready(resolve);
    }),
    RECAPTCHA_TIMEOUT_MS,
    "reCAPTCHA initialization timed out",
  );
  return {
    actions: { confirm: source.actions.confirm, join: source.actions.join },
    siteKey,
  };
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
