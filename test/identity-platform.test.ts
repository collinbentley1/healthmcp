import { describe, expect, test } from "bun:test";
import { IdentityPlatformClient } from "../src/identity-platform.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const MEMBER = "member@example.com";

function harness(responder: (url: string, init?: RequestInit) => Response) {
  const calls: { init?: RequestInit; url: string }[] = [];
  const client = new IdentityPlatformClient({
    continueUrl: "https://medlock.ai/api/waitlist/confirm",
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "sa-token", expires_in: 3_600 });
      }
      calls.push({ ...(init ? { init } : {}), url });
      return responder(url, init);
    },
    projectId: "medlock-1025243085",
  });
  return { calls, client };
}

describe("Identity Platform ownership transport", () => {
  test("dispatch uses the project-scoped OAuth surface and encrypted state", async () => {
    const { calls, client } = harness(() => Response.json({ email: MEMBER }));
    await client.sendSignInLink(MEMBER, "v1.encrypted.state", NOW);
    const call = calls[0]!;
    expect(call.url).toBe(
      "https://identitytoolkit.googleapis.com/v1/projects/medlock-1025243085/accounts:sendOobCode",
    );
    expect((call.init?.headers as Record<string, string>).Authorization).toBe("Bearer sa-token");
    expect(call.url).not.toContain("key=");
    const body = JSON.parse(String(call.init?.body));
    expect(body.requestType).toBe("EMAIL_SIGNIN");
    expect(new URL(body.continueUrl).searchParams.get("state")).toBe("v1.encrypted.state");
    expect(body.continueUrl).not.toContain(MEMBER);
  });

  test("verification uses the documented OAuth check-only endpoint and no API key", async () => {
    const { calls, client } = harness(() =>
      Response.json({ email: MEMBER, requestType: "EMAIL_SIGNIN" })
    );
    await expect(client.verifyEmailLink("oob-code_1", NOW)).resolves.toBe(MEMBER);
    const call = calls[0]!;
    expect(call.url).toBe("https://identitytoolkit.googleapis.com/v1/accounts:resetPassword");
    expect(call.url).not.toContain("key=");
    expect((call.init?.headers as Record<string, string>).Authorization).toBe("Bearer sa-token");
    expect(JSON.parse(String(call.init?.body))).toEqual({ oobCode: "oob-code_1" });
  });

  test("only EMAIL_SIGNIN codes with a valid address are accepted", async () => {
    for (const body of [
      { email: MEMBER, requestType: "PASSWORD_RESET" },
      { requestType: "EMAIL_SIGNIN" },
      { email: 42, requestType: "EMAIL_SIGNIN" },
      { email: "", requestType: "EMAIL_SIGNIN" },
    ]) {
      const { client } = harness(() => Response.json(body));
      await expect(client.verifyEmailLink("code", NOW)).rejects.toThrow();
    }
  });

  test("transport errors never echo the address or OOB credential", async () => {
    const { client } = harness(() => new Response("private upstream body", { status: 403 }));
    await client.verifyEmailLink("secret-oob", NOW).catch((error: Error) => {
      expect(error.message).toContain("403");
      expect(error.message).not.toContain("secret-oob");
      expect(error.message).not.toContain(MEMBER);
      expect(error.message).not.toContain("private upstream body");
    });
  });

  test("unreadable and oversized success bodies fail closed", async () => {
    for (const body of ["not-json", "[]", "null"]) {
      const { client } = harness(() => new Response(body));
      await expect(client.verifyEmailLink("code", NOW)).rejects.toThrow();
    }
    const { client } = harness(() => new Response(JSON.stringify({ padding: "x".repeat(9_000) })));
    await expect(client.verifyEmailLink("code", NOW)).rejects.toThrow(/oversized/);
  });

  test("one deadline covers a hung first metadata call", async () => {
    const client = new IdentityPlatformClient({
      continueUrl: "https://medlock.ai/api/waitlist/confirm",
      fetcher: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
      projectId: "medlock-1025243085",
      timeoutMs: 20,
    });
    const startedAt = performance.now();
    await expect(client.verifyEmailLink("code", NOW)).rejects.toThrow();
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("refuses an oversized metadata token response", async () => {
    const client = new IdentityPlatformClient({
      continueUrl: "https://medlock.ai/api/waitlist/confirm",
      fetcher: async () => new Response("x".repeat(4_097)),
      projectId: "medlock-1025243085",
    });

    await expect(client.verifyEmailLink("code", NOW)).rejects.toThrow(/oversized/);
  });
});
