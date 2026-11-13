/**
 * The link's framing: how the gate and a machine's node share one WebSocket.
 *
 * Each WebSocket message is one frame, sent as a binary message:
 *
 *   1 byte   type      open | data | close | window | control
 *   4 bytes  stream id big-endian; 0 for control
 *   …        payload   bytes for data; JSON for control (at most 64 KiB)
 *
 * The gate opens a stream per HTTP connection or WebSocket upgrade bound for
 * a machine (stream.ts); the node never opens one. Control messages carry the
 * hello and the gate's answers (protocol.ts).
 */

export const FrameType = {
  open: 1,
  data: 2,
  close: 3,
  window: 4,
  control: 5,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

const TYPES = new Set<number>(Object.values(FrameType));

/** The bytes before the payload. */
export const HEADER_BYTES = 5;
/** A control message's JSON, at most. */
export const CONTROL_MAX_BYTES = 64 * 1024;
/** The node's hello, at most (a control message, held tighter). */
export const HELLO_MAX_BYTES = 16 * 1024;
/** The largest stream id: ids are unsigned 32-bit, 0 is the link itself. */
export const MAX_STREAM_ID = 0xffff_ffff;

export interface Frame {
  type: FrameType;
  stream: number;
  payload: Buffer;
}

export class FrameError extends Error {}

export function encodeFrame(type: FrameType, stream: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  if (!TYPES.has(type)) throw new FrameError(`unknown frame type ${type}`);
  if (!Number.isInteger(stream) || stream < 0 || stream > MAX_STREAM_ID) throw new FrameError(`bad stream id ${stream}`);
  if (type === FrameType.control && stream !== 0) throw new FrameError("control frames are on stream 0");
  if (type !== FrameType.control && stream === 0) throw new FrameError("stream 0 is the link's own");
  const out = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(stream, 1);
  out.set(payload, HEADER_BYTES);
  return out;
}

/** Read one frame; throws FrameError for anything malformed, which ends the link. */
export function decodeFrame(buf: Buffer): Frame {
  if (buf.length < HEADER_BYTES) throw new FrameError("frame too short");
  const type = buf.readUInt8(0);
  if (!TYPES.has(type)) throw new FrameError(`unknown frame type ${type}`);
  const stream = buf.readUInt32BE(1);
  const payload = buf.subarray(HEADER_BYTES);
  if (type === FrameType.control) {
    if (stream !== 0) throw new FrameError("control frames are on stream 0");
    if (payload.length > CONTROL_MAX_BYTES) throw new FrameError("control message too large");
  } else if (stream === 0) {
    throw new FrameError("stream 0 is the link's own");
  }
  return { type: type as FrameType, stream, payload };
}

/** A control message: a JSON object with a string `type`. */
export interface ControlMessage {
  type: string;
  [key: string]: unknown;
}

export function encodeControl(message: ControlMessage): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (json.length > CONTROL_MAX_BYTES) throw new FrameError("control message too large");
  return encodeFrame(FrameType.control, 0, json);
}

/** The control message in a control frame's payload; throws FrameError when it is not one. */
export function decodeControl(payload: Buffer): ControlMessage {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new FrameError("control message is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FrameError("control message is not an object");
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || type === "") throw new FrameError("control message has no type");
  return value as ControlMessage;
}
