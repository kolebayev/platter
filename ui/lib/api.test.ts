import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

const {
  cachedArtwork,
  invalidateArtwork,
  markArtworkUndecodable,
  resolvedArtwork,
  retainArtwork,
} = await import("./api");

const URL_A = "data:image/jpeg;base64,AAAA";
const fetches = () => invoke.mock.calls.filter(([cmd]) => cmd === "get_artwork").length;

/** Loads one cover through the scheduler the way a mounted thumb does. */
async function load(id: string, size: number) {
  retainArtwork(id, size);
  return cachedArtwork(id, size);
}

describe("artwork cache", () => {
  beforeEach(() => {
    invalidateArtwork();
    invoke.mockReset();
    invoke.mockResolvedValue(URL_A);
  });

  it("marks a cover the webview could not decode as no art", async () => {
    expect(await load("7", 80)).toBe(URL_A);
    expect(resolvedArtwork("7", 80)).toBe(URL_A);

    markArtworkUndecodable("7", 80);

    // Every later mount of this key paints the placeholder instead of
    // WebKit's broken-image icon...
    expect(resolvedArtwork("7", 80)).toBeNull();
    // ...without asking the backend for the same undecodable bytes again.
    const before = fetches();
    expect(await cachedArtwork("7", 80)).toBeNull();
    expect(fetches()).toBe(before);
  });

  it("keeps the mark to that track and size", async () => {
    await load("7", 80);
    await load("7", 320);
    await load("9", 80);

    markArtworkUndecodable("7", 80);

    expect(resolvedArtwork("7", 320)).toBe(URL_A);
    expect(resolvedArtwork("9", 80)).toBe(URL_A);
  });

  it("drops the mark when the cover is replaced", async () => {
    await load("7", 80);
    markArtworkUndecodable("7", 80);

    invalidateArtwork(["7"]);

    expect(resolvedArtwork("7", 80)).toBeUndefined();
    const before = fetches();
    expect(await load("7", 80)).toBe(URL_A);
    expect(fetches()).toBe(before + 1);
  });
});
