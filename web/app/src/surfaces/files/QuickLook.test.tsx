import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@workbench/shared";

const loadMarkdown = vi.fn();
vi.mock("../../files/preview.ts", async (orig) => ({
  ...(await orig<typeof import("../../files/preview.ts")>()),
  readText: async () => ({ text: "# Hello\n", truncated: false, binary: false }),
  loadMarkdown: () => loadMarkdown(),
}));

const { QuickLook } = await import("./QuickLook.tsx");

const readme: FileEntry = { name: "README.md", path: "/workspace/demo/README.md", type: "file", size: 8, mtime: 0 };

describe("QuickLook, when the Markdown renderer cannot be fetched", () => {
  it("says so, offers the source, and fetches it again on Try again", async () => {
    loadMarkdown.mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"));
    loadMarkdown.mockResolvedValue({ renderMarkdown: () => ({ html: "<h1>Hello</h1>", blocked: 0 }) });
    render(<QuickLook entry={readme} siblings={[readme]} onNavigate={() => {}} onClose={() => {}} />);

    expect(await screen.findByText("Couldn't show it formatted.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show the source" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeInTheDocument();
    expect(loadMarkdown).toHaveBeenCalledTimes(2);
  });
});
