import { describe, expect, test } from "bun:test";
import { WaitlistConfirmationCodec } from "../src/waitlist-confirmation.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const ACTIVE = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PRIOR = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

describe("waitlist confirmation state", () => {
  test("encrypts the address and authenticates it", async () => {
    const codec = new WaitlistConfirmationCodec([ACTIVE]);
    const token = await codec.sealLink("member@example.com", NOW);
    expect(token).not.toContain("member");
    expect(await codec.openLink(token, NOW + 1_000)).toEqual({ email: "member@example.com" });
  });

  test("uses a fresh nonce for every link", async () => {
    const codec = new WaitlistConfirmationCodec([ACTIVE]);
    const first = await codec.sealLink("member@example.com", NOW);
    const second = await codec.sealLink("member@example.com", NOW);
    expect(first).not.toBe(second);
  });

  test("accepts the prior key during rotation", async () => {
    const old = new WaitlistConfirmationCodec([PRIOR]);
    const rotated = new WaitlistConfirmationCodec([ACTIVE, PRIOR]);
    const token = await old.sealLink("member@example.com", NOW);
    expect(await rotated.openLink(token, NOW + 1_000)).toEqual({ email: "member@example.com" });
  });

  test("rejects tampering, expiry, and purpose confusion", async () => {
    const codec = new WaitlistConfirmationCodec([ACTIVE]);
    const link = await codec.sealLink("member@example.com", NOW);
    const tampered = `${link.slice(0, -1)}${link.endsWith("a") ? "b" : "a"}`;
    await expect(codec.openLink(tampered, NOW + 1_000)).rejects.toThrow();
    await expect(codec.openLink(link, NOW + 30 * 60 * 1_000)).rejects.toThrow(/expired/);
    await expect(codec.openBrowserProof(link, NOW + 1_000)).rejects.toThrow();
  });

  test("moves the OOB credential into a short-lived authenticated browser proof", async () => {
    const codec = new WaitlistConfirmationCodec([ACTIVE]);
    const state = await codec.sealLink("member@example.com", NOW);
    const proof = await codec.sealBrowserProof(state, "oob-code_1", NOW + 1_000);
    expect(proof).not.toContain("oob-code");
    expect(await codec.openBrowserProof(proof, NOW + 2_000)).toEqual({
      linkState: state,
      oobCode: "oob-code_1",
    });
    await expect(codec.openBrowserProof(proof, NOW + 11 * 60 * 1_000)).rejects.toThrow(/expired/);
  });

  test("refuses malformed inputs before encryption", async () => {
    const codec = new WaitlistConfirmationCodec([ACTIVE]);
    await expect(codec.sealLink("Not-Normalized@Example.com", NOW)).rejects.toThrow(/normalized/);
    await expect(codec.sealBrowserProof("bad state with spaces", "code", NOW)).rejects.toThrow();
    await expect(codec.sealBrowserProof("v1.a.b", "bad code", NOW)).rejects.toThrow();
  });
});
