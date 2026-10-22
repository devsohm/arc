import { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "../../shared/sqlite/cloudflare.ts";
import { SqliteStorage, type SqliteStorageOptions } from "./storage.ts";
export { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "../../shared/sqlite/cloudflare.ts";
export function openDurableObjectSqliteStorage(
	storage: DurableObjectSqliteStorage,
	options: SqliteStorageOptions = {},
): Promise<SqliteStorage> {
	return SqliteStorage.open(new DurableObjectSqliteDatabase(storage), options);
}
