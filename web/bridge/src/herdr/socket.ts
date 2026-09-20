import net from "node:net";
import readline from "node:readline";

export class HerdrError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "HerdrError";
  }
}

interface HerdrResponse {
  id?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

let seq = 0;

export function request<T = unknown>(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `wb_${++seq}`;
    const sock = net.connect(socketPath);
    const rl = readline.createInterface({ input: sock });
    const timer = setTimeout(() => {
      rl.close();
      sock.destroy();
      reject(new HerdrError("timeout", `${method} timed out`));
    }, opts.timeoutMs ?? 10_000);
    sock.once("error", (err) => {
      clearTimeout(timer);
      rl.close();
      reject(err);
    });
    sock.once("connect", () => {
      sock.write(JSON.stringify({ id, method, params }) + "\n");
    });
    rl.once("line", (line) => {
      clearTimeout(timer);
      rl.close();
      sock.end();
      let msg: HerdrResponse;
      try {
        msg = JSON.parse(line) as HerdrResponse;
      } catch {
        reject(new HerdrError("bad_json", line.slice(0, 200)));
        return;
      }
      if (msg.error) {
        reject(new HerdrError(msg.error.code ?? "error", msg.error.message ?? "herdr error"));
        return;
      }
      resolve(msg.result as T);
    });
  });
}

export interface Subscription {
  type: string;
  pane_id?: string;
  agent_status?: string;
}

export interface HerdrStreamEvent {
  event: string;
  data: unknown;
}

export function subscribe(
  socketPath: string,
  subscriptions: Subscription[],
  onEvent: (e: HerdrStreamEvent) => void,
  onClose: (err?: Error) => void,
): Promise<{ close(): void }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let started = false;
    // Set by the caller's close() just before destroying the socket, so an
    // intentional close does not also invoke onClose (which is reserved for
    // unexpected disconnects/errors).
    let closing = false;
    const rl = readline.createInterface({ input: sock });
    sock.once("connect", () => {
      sock.write(JSON.stringify({ id: "sub", method: "events.subscribe", params: { subscriptions } }) + "\n");
    });
    sock.on("error", (err) => {
      if (!started) {
        reject(err);
      } else if (!closing) {
        onClose(err);
      }
    });
    sock.on("close", () => {
      if (started && !closing) onClose();
    });
    rl.on("line", (line) => {
      let msg: HerdrResponse & Partial<HerdrStreamEvent>;
      try {
        msg = JSON.parse(line) as HerdrResponse & Partial<HerdrStreamEvent>;
      } catch {
        return;
      }
      if (!started) {
        if (msg.error) {
          sock.destroy();
          reject(new HerdrError(msg.error.code ?? "error", msg.error.message ?? "herdr error"));
          return;
        }
        started = true;
        resolve({
          close: () => {
            closing = true;
            sock.destroy();
          },
        });
        return;
      }
      if (msg.event) onEvent(msg as HerdrStreamEvent);
    });
  });
}
