import { beforeEach, describe, it, expect, vi } from "vitest";
const m = vi.hoisted(() => ({ load: vi.fn(), post: vi.fn() }));
vi.mock("../../src/runtime", () => ({
  getDingTalkRuntime: () => ({ media: { loadWebMedia: m.load } }),
}));
vi.mock("axios", () => ({
  default: { post: m.post, isAxiosError: () => false },
}));
import { uploadMedia } from "../../src/media-utils";
beforeEach(() => {
  vi.clearAllMocks();
  m.post.mockResolvedValue({ data: { errcode: 0, media_id: "media-1" } });
});
describe("outbound 20 MiB file limit", () => {
  it.each([5 * 1024 * 1024 + 1, 20 * 1024 * 1024])(
    "allows %s bytes through the host loader and upload",
    async (size) => {
      m.load.mockImplementation(async (_path, options) => {
        expect(options.maxBytes).toBe(20 * 1024 * 1024);
        expect(options.localRoots).toEqual(["/workspace"]);
        return { buffer: Buffer.alloc(size), fileName: "report.pdf" };
      });
      const result = await uploadMedia(
        { clientId: "id", clientSecret: "secret" } as any,
        "/workspace/report.pdf",
        "file",
        async () => "token",
        undefined,
        { mediaLocalRoots: ["/workspace"] },
      );
      expect(result?.mediaId).toBe("media-1");
      expect(m.post).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects 20 MiB + 1 before upload even if a custom loader returns it", async () => {
    m.load.mockResolvedValue({
      buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
      fileName: "report.pdf",
    });
    expect(
      await uploadMedia(
        { clientId: "id", clientSecret: "secret" } as any,
        "/workspace/report.pdf",
        "file",
        async () => "token",
        undefined,
        { mediaLocalRoots: ["/workspace"] },
      ),
    ).toBeNull();
    expect(m.post).not.toHaveBeenCalled();
  });
  it("retains the separate 2 MiB voice limit", async () => {
    m.load.mockResolvedValue({ buffer: Buffer.alloc(2 * 1024 * 1024 + 1), fileName: "voice.mp3" });
    expect(
      await uploadMedia(
        { clientId: "id", clientSecret: "secret" } as any,
        "/workspace/voice.mp3",
        "voice",
        async () => "token",
        undefined,
        { mediaLocalRoots: ["/workspace"] },
      ),
    ).toBeNull();
    expect(m.post).not.toHaveBeenCalled();
  });
});
