// TODO: create types for these libraries? SQL.js already should have types;
// we just need the types to apply to the fork.
import { prepareBindValues, sql } from '@livestore/common'
import type { LiveStoreSchema } from '@livestore/common/schema'
import { makeMutationEventSchema } from '@livestore/common/schema'
import type * as SqliteWasm from '@livestore/sqlite-wasm'
import sqlite3InitModule from '@livestore/sqlite-wasm'
import { casesHandled, memoize, shouldNeverHappen } from '@livestore/utils'
import { Schema } from '@livestore/utils/effect'
import * as Comlink from 'comlink'

import { IDB } from '../utils/idb.js'
import type { ExecutionBacklogItem } from './common.js'
import type { StorageOptionsWeb } from './index.js'

export type WorkerOptions<TSchema extends LiveStoreSchema = LiveStoreSchema> = {
  schema: TSchema
  mutationLog?: {
    /**
     * Mutations to exclude in the mutation log
     *
     * @default new Set(['livestore.RawSql'])
     */
    exclude?: ReadonlySet<keyof TSchema['_MutationDefMapType']>
  }
}

export const makeWorker = <TSchema extends LiveStoreSchema = LiveStoreSchema>({
  schema,
  mutationLog,
}: WorkerOptions<TSchema>) => {
  // A global variable to hold the database connection.
  let db: SqliteWasm.Database

  let dbLog: SqliteWasm.Database

  let sqlite3: SqliteWasm.Sqlite3Static

  const mutationLogExclude = mutationLog?.exclude ?? new Set(['livestore.RawSql'])

  // TODO refactor
  const mutationArgsSchema = makeMutationEventSchema(Object.fromEntries(schema.mutations.entries()) as any)
  const schemaHashMap = new Map([...schema.mutations.entries()].map(([k, v]) => [k, Schema.hash(v.schema)] as const))

  // TODO get rid of this in favour of a "proper" IDB SQLite storage
  let idb: IDB | undefined

  /** The location where this database storage persists its data */
  let options_: Omit<StorageOptionsWeb, 'worker'>

  const configureConnection = () =>
    db.exec(sql`
    PRAGMA page_size=8192;
    PRAGMA journal_mode=MEMORY;
    PRAGMA foreign_keys='ON'; -- we want foreign key constraints to be enforced
  `)

  /** A full virtual filename in the IDB FS */

  const initialize = async (options: Omit<StorageOptionsWeb, 'worker'>) => {
    options_ = options

    sqlite3 = await sqlite3InitModule({
      print: (message) => console.log(`[sql-client] ${message}`),
      printErr: (message) => console.error(`[sql-client] ${message}`),
    })

    switch (options.type) {
      case 'opfs': {
        try {
          db = new sqlite3.oo1.OpfsDb(options.fileName, 'c')

          dbLog = new sqlite3.oo1.OpfsDb(options.fileName + '-log.db', 'c')
        } catch (e) {
          debugger
        }
        break
      }
      case 'indexeddb': {
        try {
          db = new sqlite3.oo1.DB({ filename: ':memory:', flags: 'c' })
          idb = new IDB(options.fileName)

          const bytes = await idb.get('db')

          if (bytes !== undefined) {
            // Based on https://sqlite.org/forum/forumpost/2119230da8ac5357a13b731f462dc76e08621a4a29724f7906d5f35bb8508465
            // TODO find cleaner way to do this once possible in sqlite3-wasm
            const p = sqlite3.wasm.allocFromTypedArray(bytes)
            const _rc = sqlite3.capi.sqlite3_deserialize(db.pointer!, 'main', p, bytes.length, bytes.length, 0)
          }
        } catch (e) {
          debugger
        }
        break
      }
      default: {
        casesHandled(options.type)
      }
    }

    // Creates `mutation_log` table if it doesn't exist
    dbLog.exec(sql`
      CREATE TABLE IF NOT EXISTS mutation_log (
        id TEXT PRIMARY KEY NOT NULL,
        mutation TEXT NOT NULL,
        args_json TEXT NOT NULL,
        schema_hash INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `)

    configureConnection()
  }

  // TODO get rid of this in favour of a "proper" IDB SQLite storage
  let idbPersistTimeout: number | undefined

  const executeBulk = (executionItems: ExecutionBacklogItem[]): void => {
    let batchItems: ExecutionBacklogItem[] = []

    const createdAtMemo = memoize(() => new Date().toISOString())

    while (executionItems.length > 0) {
      try {
        // db.exec('BEGIN TRANSACTION') // Start the transaction
        // dbLog.exec('BEGIN TRANSACTION') // Start the transaction

        batchItems = executionItems.splice(0, 50)

        // console.debug('livestore-webworker: executing batch', batchItems)

        for (const item of batchItems) {
          if (item._tag === 'execute') {
            const { query, bindValues } = item
            db.exec({ sql: query, bind: bindValues as TODO })

            // NOTE we're not writing `execute` events to the mutation_log
          } else {
            const { mutation, args } = Schema.decodeUnknownSync(mutationArgsSchema)(item.mutationEventEncoded)

            const mutationDef = schema.mutations.get(mutation) ?? shouldNeverHappen(`Unknown mutation: ${mutation}`)

            const statementRes = typeof mutationDef.sql === 'function' ? mutationDef.sql(args) : mutationDef.sql
            const statementSql = typeof statementRes === 'string' ? statementRes : statementRes.sql

            const bindValues =
              typeof statementRes === 'string' ? item.mutationEventEncoded.args : statementRes.bindValues

            db.exec({ sql: statementSql, bind: prepareBindValues(bindValues ?? {}, statementSql) as TODO })

            // write to mutation_log
            if (options_.type === 'opfs' && mutationLogExclude.has(mutation) === false) {
              const schemaHash = schemaHashMap.get(mutation) ?? shouldNeverHappen(`Unknown mutation: ${mutation}`)

              const argsJson = JSON.stringify(item.mutationEventEncoded.args ?? {})

              dbLog.exec({
                sql: `INSERT INTO mutation_log (id, mutation, args_json, schema_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
                bind: [
                  item.mutationEventEncoded.id,
                  item.mutationEventEncoded.mutation,
                  argsJson,
                  schemaHash,
                  createdAtMemo(),
                ],
              })
            }
          }
        }

        // db.exec('COMMIT') // Commit the transaction
        // dbLog.exec('COMMIT') // Commit the transaction
      } catch (error) {
        try {
          // db.exec('ROLLBACK') // Rollback in case of an error
          // dbLog.exec('ROLLBACK') // Rollback in case of an error
        } catch (e) {
          console.error('Error rolling back transaction', e)
        }

        shouldNeverHappen(`Error executing query: ${error} \n ${JSON.stringify(batchItems)}`)
      }
    }

    // TODO get rid of this in favour of a "proper" IDB SQLite storage
    if (options_.type === 'indexeddb') {
      if (idbPersistTimeout !== undefined) {
        clearTimeout(idbPersistTimeout)
      }

      idbPersistTimeout = setTimeout(() => {
        const data = sqlite3.capi.sqlite3_js_db_export(db.pointer!)

        void idb!.put('db', data)
      }, 1000)
    }
  }

  const shutdown = () => {
    try {
      db.close()
      dbLog.close()
    } catch (e) {
      console.error('Error closing database', e)
      debugger
    }

    if (idbPersistTimeout !== undefined) {
      clearTimeout(idbPersistTimeout)
    }
  }

  const wrappedWorker = { initialize, executeBulk, shutdown }

  Comlink.expose(wrappedWorker)

  // NOTE keep this around for debugging
  // db.exec({
  //   sql: `select * from sqlite_master where name = 'library_tracks'`,
  //   callback: (_: TODO) => console.log(_),
  //   rowMode: 'object',
  // } as TODO)

  return wrappedWorker
}

export type WrappedWorker = ReturnType<typeof makeWorker>
