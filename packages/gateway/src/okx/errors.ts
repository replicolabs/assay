/**
 * Error taxonomy for the onchainos CLI adapter. Kept distinct so callers can
 * tell "the binary isn't there" from "the CLI ran but rejected the business
 * request" from "the CLI's JSON didn't match the documented shape" — collapsing
 * these into one generic Error is exactly the kind of silent failure that would
 * make Assay's own evidence untrustworthy.
 */

export class OnchainosNotInstalledError extends Error {
  constructor(bin: string) {
    super(
      `onchainos binary not found ("${bin}"). Install it (see README §Setup) or set ONCHAINOS_MODE=fake for local dev/tests.`
    );
    this.name = "OnchainosNotInstalledError";
  }
}

export class OnchainosExecError extends Error {
  constructor(
    public readonly command: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string
  ) {
    super(`onchainos ${command.join(" ")} exited ${exitCode}: ${stderr.slice(0, 2000)}`);
    this.name = "OnchainosExecError";
  }
}

export class OnchainosParseError extends Error {
  constructor(
    public readonly command: string[],
    public readonly raw: string,
    cause: unknown
  ) {
    super(`onchainos ${command.join(" ")} did not return valid JSON: ${String(cause)}`);
    this.name = "OnchainosParseError";
  }
}

/** The CLI ran and returned JSON, but it didn't match the schema we expect for this command. */
export class OnchainosSchemaError extends Error {
  constructor(
    public readonly command: string[],
    public readonly zodMessage: string
  ) {
    super(`onchainos ${command.join(" ")} returned JSON that doesn't match the expected schema: ${zodMessage}`);
    this.name = "OnchainosSchemaError";
  }
}

/** The CLI ran, returned well-formed JSON, but reports a business-level rejection. */
export class OnchainosBusinessError extends Error {
  constructor(
    public readonly command: string[],
    public readonly code: string | number | undefined,
    message: string
  ) {
    super(`onchainos ${command.join(" ")} business error${code !== undefined ? ` (${code})` : ""}: ${message}`);
    this.name = "OnchainosBusinessError";
  }
}
