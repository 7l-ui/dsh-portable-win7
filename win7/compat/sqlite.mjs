// Only the synchronous exec/prepare/get/all/run/close surface is consumed by DSH's derived search index.
// better-sqlite3 preserves SQLite FTS5 and STRICT tables on the Node 20 ABI.
import Database from 'better-sqlite3';
export const DatabaseSync = Database;
