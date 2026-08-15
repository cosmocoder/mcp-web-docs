import { DatabaseSync } from 'node:sqlite';

/** node:sqlite refuses to bind a boolean or undefined, so callers pass 1/0 and null instead. */
export type SqlParam = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
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

  async run(sql: string, params: readonly SqlParam[] = []): Promise<RunResult> {
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
