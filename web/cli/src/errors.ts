/**
 * Exit codes. Stable, documented in docs/cli.md, so a script can tell "you
 * typed it wrong" from "sign in again" from "the box is down".
 */
export const EXIT = {
  OK: 0,
  /** The box refused, or something else went wrong. */
  FAILURE: 1,
  /** An unknown command, a bad option, the wrong number of arguments. */
  USAGE: 2,
  /** Not signed in, or the box no longer accepts this device's token. */
  AUTH: 3,
  /** No such file, box or path. */
  NOT_FOUND: 4,
  /** The box could not be reached: DNS, TCP, TLS, a timeout. */
  UNREACHABLE: 5,
  /** Ctrl-C, or SIGINT from elsewhere. */
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error meant for the person at the terminal: a message and an exit code, no stack. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.FAILURE,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.USAGE);
    this.name = "UsageError";
  }
}

/** A non-2xx answer from the box, with what it said about why. */
export class ApiError extends CliError {
  constructor(
    readonly status: number,
    message: string,
    /** The API's machine-readable reason (`error`, or the files API's `code`), when it gave one. */
    readonly code: string | null = null,
  ) {
    super(message, status === 401 ? EXIT.AUTH : status === 404 ? EXIT.NOT_FOUND : EXIT.FAILURE);
    this.name = "ApiError";
  }
}
