import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploads, useUploads } from "../../files/uploads.ts";
import { UploadPanel } from "./UploadPanel.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => uploads.clearFinished());
});

describe("UploadPanel", () => {
  it("shows a failed upload as failed, in words, and lets it be dismissed", async () => {
    // The box refuses the upload with a sentence naming its own paths.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "/workspace/x is a directory", code: "is-a-directory" }), { status: 409 })),
    );
    const user = userEvent.setup();
    render(<UploadPanel />);
    act(() => void uploads.add([{ file: new Blob(["hi"]), dest: "/workspace/x" }]));

    const region = await screen.findByRole("region", { name: "Uploads" });
    await waitFor(() => expect(region).toHaveTextContent("1 upload failed"));
    expect(region).toHaveTextContent("A folder already has this name.");
    expect(region).not.toHaveTextContent("/workspace/x is a directory");
    // No full progress bar over a failure.
    expect(screen.queryByRole("progressbar", { name: "All uploads" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Dismiss uploads" }));
    await waitFor(() => expect(useUploads.getState().items).toHaveLength(0));
    expect(screen.queryByRole("region", { name: "Uploads" })).toBeNull();
  });

  it("removes one failed file from the list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const user = userEvent.setup();
    render(<UploadPanel />);
    act(() => void uploads.add([{ file: new Blob(["a"]), dest: "/workspace/a" }, { file: new Blob(["b"]), dest: "/workspace/b" }]));
    await screen.findByRole("button", { name: "Remove a from the list" });
    await user.click(screen.getByRole("button", { name: "Remove a from the list" }));
    await waitFor(() => expect(useUploads.getState().items.map((i) => i.name)).toEqual(["b"]));
  });
});
