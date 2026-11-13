import fs from "node:fs";
import os from "node:os";

/** Where throwaway test directories go. */
export function tmpBase(): string {
  return fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : os.tmpdir();
}
