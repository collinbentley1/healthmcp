import { describe, expect, test } from "bun:test";
import { RecaptchaEnterpriseClient } from "../src/recaptcha.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const SITE_KEY = "public_site_key_12345678901234567890";

function harness(result: unknown, options: { status?: number } = {}) {
  const calls: { init?: RequestInit; url: string }[] = [];
  const client = new RecaptchaEnterpriseClient({
    allowedHostnames: ["medlock.ai", "www.medlock.ai"],
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "token", expires_in: 3_600 });
      }
      calls.push({ ...(init ? { init } : {}), url });
      return Response.json(result, { status: options.status ?? 200 });
    },
    projectId: "medlock-1025243085",
    siteKey: SITE_KEY,
  });
  return { calls, client };
}

const valid = (patch: Record<string, unknown> = {}) => ({
  riskAnalysis: { score: 0.9 },
  tokenProperties: {
    action: "waitlist_join",
    createTime: "2026-09-01T11:59:30.000Z",
    hostname: "medlock.ai",
    valid: true,
    ...patch,
  },
});

describe("reCAPTCHA Enterprise assessment", () => {
  test("uses the runtime bearer and binds the site key and action", async () => {
    const { calls, client } = harness(valid());
    await expect(client.assess("token", "waitlist_join", NOW, "browser/1")).resolves.toEqual({
      action: "waitlist_join",
      hostname: "medlock.ai",
      score: 0.9,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://recaptchaenterprise.googleapis.com/v1/projects/medlock-1025243085/assessments",
    );
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer token");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      event: {
        expectedAction: "waitlist_join",
        siteKey: SITE_KEY,
        token: "token",
        userAgent: "browser/1",
      },
    });
  });

  test.each([
    ["invalid", valid({ valid: false })],
    ["wrong action", valid({ action: "login" })],
    ["wrong host", valid({ hostname: "attacker.example" })],
    ["stale", valid({ createTime: "2026-09-01T11:50:00.000Z" })],
    ["future", valid({ createTime: "2026-09-01T12:01:00.000Z" })],
    ["low score", { ...valid(), riskAnalysis: { score: 0.69 } }],
  ])("refuses %s assessments", async (_label, response) => {
    const { client } = harness(response);
    await expect(client.assess("token", "waitlist_join", NOW)).rejects.toThrow();
  });

  test("fails closed on transport and response-shape errors", async () => {
    await expect(harness({}, { status: 503 }).client.assess("token", "waitlist_join", NOW))
      .rejects.toThrow(/503/);
    for (const body of [{}, { tokenProperties: { valid: true } }]) {
      await expect(harness(body).client.assess("token", "waitlist_join", NOW)).rejects.toThrow();
    }
  });

  test("the deadline covers a hung first metadata call", async () => {
    const client = new RecaptchaEnterpriseClient({
      allowedHostnames: ["medlock.ai"],
      fetcher: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
      projectId: "medlock-1025243085",
      siteKey: SITE_KEY,
      timeoutMs: 20,
    });
    const startedAt = performance.now();
    await expect(client.assess("token", "waitlist_join", NOW)).rejects.toThrow();
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("refuses an oversized metadata token response", async () => {
    const client = new RecaptchaEnterpriseClient({
      allowedHostnames: ["medlock.ai"],
      fetcher: async () => new Response("x".repeat(4_097)),
      projectId: "medlock-1025243085",
      siteKey: SITE_KEY,
    });

    await expect(client.assess("token", "waitlist_join", NOW)).rejects.toThrow(/oversized/);
  });
});
