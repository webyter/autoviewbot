import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'

// Adapt the Worker's D1 calls to durable SQLite for the local server.
export function openDatabase(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(directory + '/halcyon.sqlite')
  database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  function prepare(sql, parameters = []) {
    return {
      bind(...values) { return prepare(sql, values) },
      async run() { return database.prepare(sql).run(...parameters) },
      async first() { return database.prepare(sql).get(...parameters) ?? null },
      async all() { return { results: database.prepare(sql).all(...parameters) } },
    }
  }
  return { prepare }
}
