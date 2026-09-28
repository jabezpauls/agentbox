import { create } from "zustand";
import { HttpError } from "../api/http.ts";
import { filesApi } from "./api.ts";
import { UploadQueue, type TransportError, type UploadItem, type UploadTransport } from "./upload-queue.ts";

function asTransportError(err: unknown): TransportError {
  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message };
  return { status: 0, message: "The connection dropped." };
}

/** One chunk over XHR, which (unlike fetch) reports upload progress. */
function putChunk(id: string, offset: number, chunk: Blob, onProgress: (n: number) => void, signal: AbortSignal): Promise<{ received: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/files/uploads/${id}?offset=${offset}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        // not JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve({ received: Number(body.received) });
      else
        reject({
          status: xhr.status,
          code: typeof body.code === "string" ? body.code : undefined,
          message: typeof body.error === "string" ? body.error : `The upload was refused (${xhr.status}).`,
        } satisfies TransportError);
    };
    xhr.onerror = () => reject({ status: 0, message: "The connection dropped." } satisfies TransportError);
    xhr.onabort = () => reject({ status: 0, message: "Cancelled." } satisfies TransportError);
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(chunk);
  });
}

const transport: UploadTransport = {
  async start(path, size, overwrite) {
    try {
      return await filesApi.uploadStart(path, size, overwrite);
    } catch (err) {
      throw asTransportError(err);
    }
  },
  put: putChunk,
  async status(id) {
    try {
      return await filesApi.uploadStatus(id);
    } catch (err) {
      throw asTransportError(err);
    }
  },
  async finish(id) {
    try {
      await filesApi.uploadFinish(id);
    } catch (err) {
      throw asTransportError(err);
    }
  },
  async cancel(id) {
    await filesApi.uploadCancel(id).catch(() => {});
  },
  async mkdir(path) {
    await filesApi.mkdir(path);
  },
};

/** The app's one upload queue: uploads carry on while you move between surfaces. */
export const uploads = new UploadQueue(transport);

interface UploadsView {
  items: UploadItem[];
  /** The panel is folded to its header line. */
  collapsed: boolean;
}

export const useUploads = create<UploadsView>(() => ({ items: [], collapsed: false }));

// Mirror the queue into the store, at most a few times a second: progress
// events arrive far faster than anyone reads a percentage.
let pending = false;
uploads.subscribe(() => {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    useUploads.setState({ items: uploads.items });
  }, 100);
});

/** Confirm leaving while bytes are still going up. */
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (uploads.items.some((i) => i.state === "uploading" || i.state === "queued" || i.state === "finishing")) {
      e.preventDefault();
    }
  });
}
