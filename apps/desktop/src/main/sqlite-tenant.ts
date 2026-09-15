import type { DatabaseSync } from 'node:sqlite'
import { LOCAL_TENANT_ID } from './tenant.js'

export const TENANT_COLUMN = 'tenant_id'

interface TableInfoRow {
  name: string
  pk: number
}

interface IndexListRow {
  name: string
  unique: number
}

interface IndexInfoRow {
  name: string
  seqno: number
}

export function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database.prepare(
    `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`
  ).get(table) as { ok: number } | undefined
  return row !== undefined
}

export function columnNames(database: DatabaseSync, table: string): string[] {
  if (!tableExists(database, table)) return []
  return (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableInfoRow[]).map(({ name }) => name)
}

export function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return columnNames(database, table).includes(column)
}

export function primaryKeyColumns(database: DatabaseSync, table: string): string[] {
  if (!tableExists(database, table)) return []
  return (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableInfoRow[])
    .filter((row) => row.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map(({ name }) => name)
}

export function uniqueIndexColumnSets(database: DatabaseSync, table: string): string[][] {
  if (!tableExists(database, table)) return []
  const indexes = database.prepare(`PRAGMA index_list(${table})`).all() as unknown as IndexListRow[]
  return indexes
    .filter((index) => index.unique === 1)
    .map((index) => {
      const columns = database.prepare(`PRAGMA index_info(${index.name})`).all() as unknown as IndexInfoRow[]
      return columns.sort((left, right) => left.seqno - right.seqno).map(({ name }) => name)
    })
}

export function hasUniqueOn(database: DatabaseSync, table: string, columns: readonly string[]): boolean {
  const wanted = columns.join('\0')
  return uniqueIndexColumnSets(database, table).some((set) => set.join('\0') === wanted)
}

export function ensureTenantColumn(database: DatabaseSync, table: string): void {
  if (!tableExists(database, table)) return
  if (hasColumn(database, table, TENANT_COLUMN)) return
  database.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}'`)
}

export function rebuildSqliteTable(
  database: DatabaseSync,
  table: string,
  createSql: string,
  columns: readonly string[]
): void {
  if (!tableExists(database, table)) {
    database.exec(createSql)
    return
  }
  const renamed = `${table}_pre_tenant`
  database.exec(`ALTER TABLE ${table} RENAME TO ${renamed}`)
  database.exec(createSql)
  const list = columns.join(', ')
  database.exec(`INSERT INTO ${table} (${list}) SELECT ${list} FROM ${renamed}`)
  database.exec(`DROP TABLE ${renamed}`)
}
