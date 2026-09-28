import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@workbench/shared";

const MAX_PAGE = 5000;
let folder: FileEntry[] = [];
const list = vi.fn(async (path: string, opts: { offset?: number; limit?: number } = {}) => {
  const offset = opts.offset ?? 0;
  // The bridge clamps the page size, as the real one does.
  const limit = Math.min(opts.limit ?? 1000, MAX_PAGE);
  const entries = folder.slice(offset, offset + limit);
  return { path, root: "workspace", entries, total: folder.length, offset, truncated: offset + entries.length < folder.length };
});
vi.mock("../../files/api.ts", () => ({ filesApi: { list: (...a: Parameters<typeof list>) => list(...a) } }));

const { useListing, PAGE } = await import("./useListing.ts");

const name = (i: number) => `f${String(i).padStart(5, "0")}`;
const entry = (i: number): FileEntry => ({ name: name(i), path: `/workspace/big/${name(i)}`, type: "file", size: 1, mtime: 0 });

beforeEach(() => {
  list.mockClear();
  folder = Array.from({ length: 6500 }, (_, i) => entry(i));
});

describe("useListing", () => {
  it("keeps every loaded row of a folder past the API's cap on refresh", async () => {
    const { result } = renderHook(() => useListing("/workspace/big", false));
    await waitFor(() => expect(result.current.listing.status).toBe("ready"));
    expect(result.current.listing.entries).toHaveLength(PAGE);

    while (result.current.listing.truncated) await act(() => result.current.loadMore());
    expect(result.current.listing.entries).toHaveLength(6500);

    await act(() => result.current.refresh());
    expect(result.current.listing.entries).toHaveLength(6500);
    expect(result.current.listing.truncated).toBe(false);
    // Read a page at a time, never more than one page per request.
    for (const [, opts] of list.mock.calls) expect(opts?.limit ?? 0).toBeLessThanOrEqual(PAGE);
  });

  it("refreshes a partly loaded folder to as much as was loaded, not back to one page", async () => {
    const { result } = renderHook(() => useListing("/workspace/big", false));
    await waitFor(() => expect(result.current.listing.status).toBe("ready"));
    await act(() => result.current.loadMore());
    await act(() => result.current.loadMore());
    expect(result.current.listing.entries).toHaveLength(3 * PAGE);
    folder.splice(10, 0, { ...entry(99_999), name: "new", path: "/workspace/big/new" });
    await act(() => result.current.refresh());
    expect(result.current.listing.entries.length).toBeGreaterThanOrEqual(3 * PAGE);
    expect(result.current.listing.entries.some((e) => e.name === "new")).toBe(true);
    expect(new Set(result.current.listing.entries.map((e) => e.path)).size).toBe(result.current.listing.entries.length);
  });

  it("drops a page that lands after a refresh instead of appending it twice", async () => {
    const { result } = renderHook(() => useListing("/workspace/big", false));
    await waitFor(() => expect(result.current.listing.status).toBe("ready"));
    await act(async () => {
      const more = result.current.loadMore();
      await result.current.refresh();
      await more;
    });
    const paths = result.current.listing.entries.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
