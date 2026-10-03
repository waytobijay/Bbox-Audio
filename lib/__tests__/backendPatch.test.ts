import { describe, expect, it } from "vitest";
import { backendPatchSchema } from "../server/backendPatch";

/**
 * This schema shipped broken: a {provider, url} body matched the
 * enable/priority union member first, zod stripped `url`, and the route then
 * tried to update a backend that didn't exist — so "Add" on Modal and Custom
 * did nothing but flash a 404. These tests pin the ordering that fixes it.
 */

describe("backendPatchSchema", () => {
  it("keeps url when adding Modal, instead of silently dropping it", () => {
    const parsed = backendPatchSchema.parse({
      provider: "modal",
      url: "https://ws--voiceforge-api.modal.run",
    });
    expect(parsed).toEqual({
      provider: "modal",
      url: "https://ws--voiceforge-api.modal.run",
    });
  });

  it("keeps url when adding a custom backend", () => {
    const parsed = backendPatchSchema.parse({
      provider: "custom",
      url: "https://my-gpu.example.com",
    });
    expect("url" in parsed && parsed.url).toBe("https://my-gpu.example.com");
  });

  it("still accepts an active-selection change", () => {
    expect(backendPatchSchema.parse({ active: "auto" })).toEqual({ active: "auto" });
    expect(backendPatchSchema.parse({ active: "colab" })).toEqual({ active: "colab" });
  });

  it("still accepts enable and priority changes", () => {
    expect(backendPatchSchema.parse({ provider: "colab", enabled: false })).toEqual({
      provider: "colab",
      enabled: false,
    });
    expect(backendPatchSchema.parse({ provider: "kaggle", priority: 2 })).toEqual({
      provider: "kaggle",
      priority: 2,
    });
  });

  it("rejects a url for a provider that registers itself", () => {
    // Colab's URL comes from the notebook; accepting one by hand would let a
    // stale URL silently replace a live registration.
    expect(() =>
      backendPatchSchema.parse({ provider: "colab", url: "https://x.trycloudflare.com" })
    ).toThrow();
  });

  it("rejects an unknown key rather than discarding it", () => {
    expect(() => backendPatchSchema.parse({ provider: "modal", urll: "https://x.com" })).toThrow();
  });

  it("rejects a url that isn't one", () => {
    expect(() => backendPatchSchema.parse({ provider: "modal", url: "not a url" })).toThrow();
    expect(() =>
      backendPatchSchema.parse({ provider: "modal", url: "ws--voiceforge-api.modal.run" })
    ).toThrow();
  });
});
