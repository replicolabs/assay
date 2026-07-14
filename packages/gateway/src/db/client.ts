import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

let instance: Kysely<Database> | undefined;

export function getDb(): Kysely<Database> {
  if (!instance) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL must be set");
    }
    // Pool size is configurable (default: pg's own default of 10) — local dev
    // against a lightweight single-writer Postgres-wire server sometimes needs
    // this pinned to 1, where a real multi-connection Postgres wouldn't.
    const max = process.env.MAX_DB_CONNECTIONS ? Number(process.env.MAX_DB_CONNECTIONS) : undefined;
    instance = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max }) })
    });
  }
  return instance;
}
