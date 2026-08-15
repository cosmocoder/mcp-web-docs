import { DatabaseSync } from 'node:sqlite';

/** node:sqlite refuses to bind a boolean or undefined, so callers pass 1/0 and null instead. */
export type SqlParam = string | number | bigint | null | Uint8Array;

const SQLITE_BUSY = 5;

/**
 * A busy database arrives as the primary code 5, or as an extended variant of it: a WAL reader that
 * upgrades to a write after a peer commits gets 517, SQLITE_BUSY_SNAPSHOT. Both word the message
 * "database is locked", which is why callers must not match on the text.
 */
export function isSqliteBusy(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === 'number' && (errcode & 0xff) === SQLITE_BUSY;
}

/**
 * Promise-returning wrapper over node:sqlite, whose API is synchronous.
 *
 * Every statement runs to completion before the returned promise settles, so a slow query or a
 * busy_timeout wait blocks the event loop instead of yielding it.
 */
export class SqliteDatabase {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
  }

  async exec(sql: string): Promise<void> {
    this.database.exec(sql);
  }

  async run(sql: string, params: readonly SqlParam[] = []): Promise<{ changes: number }> {
    const { changes } = this.database.prepare(sql).run(...params);
    return { changes: Number(changes) };
  }

  async get<T>(sql: string, params: readonly SqlParam[] = []): Promise<T | undefined> {
    return this.database.prepare(sql).get(...params) as T | undefined;
  }

  async all<T>(sql: string, params: readonly SqlParam[] = []): Promise<T> {
    return this.database.prepare(sql).all(...params) as T;
  }

  async close(): Promise<void> {
    this.database.close();
  }
}
