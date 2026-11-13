import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "../store.js";

/**
 * The shared Claude Code sign-in for machines: a setup token (`claude
 * setup-token`, the owner's own subscription) pasted on the machines Admin
 * page. Write-only: kept in a secrets file of its own in the gate's volume,
 * `0600`, never in gate.json, never answered back to any request, never
 * logged. It goes only to machines the owner opted in, over their links
 * (`claude-token` control messages), and each replacement bumps a generation
 * so the Admin page can say which machines still have the old one.
 */

export const SECRETS_FILE = "machines-secrets.json";

/** What a pasted token must look like: printable, no spaces, a sane length. */
const TOKEN_SHAPE = /^[A-Za-z0-9_\-.~+/=]{20,512}$/;

export function isClaudeTokenShape(v: unknown): v is string {
  return typeof v === "string" && TOKEN_SHAPE.test(v);
}

interface Secrets {
  claudeToken: string | null;
  /** Bumped on every set, replace or remove. */
  generation: number;
  setAt: number | null;
}

export interface ClaudeTokenStatus {
  set: boolean;
  generation: number;
  setAt: number | null;
}

export class ClaudeTokens {
  private readonly file: string;
  private data: Secrets;

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(dataDir, SECRETS_FILE);
    this.data = this.read();
  }

  private read(): Secrets {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Secrets>;
      return {
        claudeToken: isClaudeTokenShape(v.claudeToken) ? v.claudeToken : null,
        generation: typeof v.generation === "number" ? v.generation : 0,
        setAt: typeof v.setAt === "number" ? v.setAt : null,
      };
    } catch {
      return { claudeToken: null, generation: 0, setAt: null };
    }
  }

  status(): ClaudeTokenStatus {
    return { set: this.data.claudeToken !== null, generation: this.data.generation, setAt: this.data.setAt };
  }

  /** The token itself: for pushing to opted-in machines, and nothing else. */
  token(): string | null {
    return this.data.claudeToken;
  }

  get generation(): number {
    return this.data.generation;
  }

  async set(token: string): Promise<number> {
    if (!isClaudeTokenShape(token)) throw new Error("that does not look like a Claude Code token");
    const next: Secrets = { claudeToken: token, generation: this.data.generation + 1, setAt: this.now() };
    await writeAtomic(this.file, `${JSON.stringify(next)}\n`);
    this.data = next;
    return next.generation;
  }

  async remove(): Promise<number> {
    const next: Secrets = { claudeToken: null, generation: this.data.generation + 1, setAt: null };
    await writeAtomic(this.file, `${JSON.stringify(next)}\n`);
    this.data = next;
    return next.generation;
  }
}
