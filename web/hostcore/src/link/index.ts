// The link between the gate and a machine's node: framing, control messages
// and the byte streams over it. No dependencies beyond Node's own, so the gate
// can carry it.
export * from "./frame.js";
export * from "./protocol.js";
export * from "./stream.js";
