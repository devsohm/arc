import { validateSqliteSchemaPrefix } from "../../shared/sqlite/index.ts";
import { openNodeSqliteDatabase, type NodeSqliteDatabaseOptions } from "../../shared/sqlite/node.ts";
import { SqliteStorage, type SqliteStorageOptions } from "./storage.ts";
export {
	NodeSqliteDatabase,
	openNodeSqliteDatabase,
	type NodeSqliteDatabaseOptions,
} from "../../shared/sqlite/node.ts";
export type NodeSqliteStorageOptions = NodeSqliteDatabaseOptions & SqliteStorageOptions;
export async function openNodeSqliteStorage(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<SqliteStorage> {
	const { prefix, ...connectionOptions } = options;
	if (prefix !== undefined) validateSqliteSchemaPrefix(prefix);
	return SqliteStorage.open(await openNodeSqliteDatabase(path, connectionOptions), { prefix });
}
