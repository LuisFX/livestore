import { makeWsSync } from '@livestore/cf-sync/sync-impl'
import { sql } from '@livestore/common'
import { type LiveStoreSchema, makeMutationEventSchema, MUTATION_LOG_META_TABLE } from '@livestore/common/schema'
import sqlite3InitModule from '@livestore/sqlite-wasm'
import { memoizeByStringifyArgs, shouldNeverHappen } from '@livestore/utils'
import type { Context } from '@livestore/utils/effect'
import {
  BrowserWorkerRunner,
  Effect,
  Layer,
  Schema,
  Stream,
  SubscriptionRef,
  WorkerRunner,
} from '@livestore/utils/effect'

import { BCMessage } from '../common/index.js'
import { configureConnection, makeApplyMutation, WorkerCtx } from './common.js'
import { makePersistedSqlite } from './persisted-sqlite.js'
import { fetchAndApplyRemoteMutations, recreateDb } from './recreate-db.js'
import type { ExecutionBacklogItem } from './schema.js'
import { Request, UnexpectedError } from './schema.js'

const sqlite3Promise = sqlite3InitModule({
  print: (message) => console.log(`[sql-client] ${message}`),
  printErr: (message) => console.error(`[sql-client] ${message}`),
})

export type WorkerOptions = {
  schema: LiveStoreSchema
}

export const makeWorker = (options: WorkerOptions) => {
  makeWorkerRunner(options as unknown as WorkerOptions).pipe(
    Layer.launch,
    Effect.scoped,
    Effect.tapCauseLogPretty,
    Effect.runFork,
  )
}

const makeWorkerRunner = ({ schema }: WorkerOptions) =>
  Effect.gen(function* (_$) {
    const mutationEventSchema = makeMutationEventSchema(Object.fromEntries(schema.mutations.entries()) as any)
    const mutationDefSchemaHashMap = new Map(
      // TODO Running `Schema.hash` can be a bottleneck for larger schemas. There is an opportunity to run this
      // at build time and lookup the pre-computed hash at runtime.
      // Also see https://github.com/Effect-TS/effect/issues/2719
      [...schema.mutations.entries()].map(([k, v]) => [k, Schema.hash(v.schema)] as const),
    )

    const schemaHash = schema.hash

    const initialSnapshotRef = { current: undefined as any }

    return WorkerRunner.layerSerialized(Request, {
      InitialMessage: ({ storageOptions, hasLock, needsRecreate, syncOptions, key }) =>
        Effect.gen(function* () {
          const sqlite3 = yield* Effect.tryPromise(() => sqlite3Promise)

          if (hasLock === false) {
            return Layer.succeed(WorkerCtx, {
              _tag: 'NoLock',
              storageOptions,
              schema,
              ctx: undefined,
            })
          }

          const makeDb = makePersistedSqlite({
            storageOptions,
            kind: 'app',
            schemaHash,
            sqlite3,
            configure: (db) => Effect.sync(() => configureConnection(db, { fkEnabled: true })),
          })

          const makeDbLog = makePersistedSqlite({
            storageOptions,
            kind: 'mutationlog',
            schemaHash,
            sqlite3,
            configure: (db) => Effect.sync(() => configureConnection(db, { fkEnabled: false })),
          })

          // Might involve some async work, so we're running them concurrently
          const [db, dbLog] = yield* Effect.all([makeDb, makeDbLog], { concurrency: 2 })

          const cursor = yield* Effect.try(
            () =>
              dbLog.dbRef.current.selectValue(
                sql`SELECT id FROM ${MUTATION_LOG_META_TABLE} WHERE syncStatus = 'synced' ORDER BY id DESC LIMIT 1`,
              ) as string | undefined,
          ).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

          const syncImpl =
            syncOptions === undefined ? undefined : yield* makeWsSync(syncOptions.roomId)

          const keySuffix = key ? `-${key}` : ''

          const broadcastChannel = new BroadcastChannel(`livestore-sync-${schemaHash}${keySuffix}`)

          const makeSync = Effect.gen(function* () {
            if (syncImpl === undefined) return undefined

            const waitUntilOnline = SubscriptionRef.changeStreamIncludingCurrent(syncImpl.isConnected).pipe(
              Stream.filter(Boolean),
              Stream.take(1),
              Stream.runDrain,
            )

            // Wait first until we're online
            yield* waitUntilOnline

            return {
              impl: syncImpl,
              inititialMessages: syncImpl.pull(cursor),
            }
          })

          const sync = yield* makeSync

          const workerCtx = {
            _tag: 'HasLock',
            storageOptions,
            schema,
            ctx: {
              sqlite3,
              db,
              dbLog,
              mutationDefSchemaHashMap,
              mutationEventSchema,
              broadcastChannel,
              sync,
            },
          } satisfies Context.Tag.Service<WorkerCtx>

          if (needsRecreate) {
            initialSnapshotRef.current = yield* recreateDb(workerCtx)
          } else {
            yield* fetchAndApplyRemoteMutations(workerCtx, db.dbRef.current, true)
          }

          const applyMutation = makeApplyMutation(workerCtx, () => new Date().toISOString(), db.dbRef.current)

          if (syncImpl !== undefined) {
            // TODO try to do this in a batched-way if possible
            yield *
              syncImpl.pushes.pipe(
                Stream.filter(({ mutationEventEncoded }) => {
                  // Electric does not expose if an operation was originated locally with the notifier. Need to fix that.
                  const cursor = dbLog.dbRef.current.selectValue(
                    sql`SELECT id FROM ${MUTATION_LOG_META_TABLE} WHERE syncStatus = 'synced' ORDER BY id DESC LIMIT 1`,
                  )

                  return typeof cursor === 'string' && cursor < mutationEventEncoded.id
                }),
                Stream.tapSync(({ mutationEventEncoded, persisted }) =>
                  applyMutation(mutationEventEncoded, { syncStatus: 'synced', shouldBroadcast: true, persisted }),
                ),
                Stream.runDrain,
                Effect.tapCauseLogPretty,
                Effect.forkScoped,
              )
          }

          broadcastChannel.addEventListener('message', (event) => {
            const decodedEvent = Schema.decodeUnknownOption(BCMessage.Message)(event.data)
            if (decodedEvent._tag === 'Some') {
              const { sender, mutationEventEncoded, persisted } = decodedEvent.value
              if (sender === 'ui-thread') {
                // console.log('livestore-webworker: applying mutation from ui-thread', mutationEventEncoded)

                const mutationDef =
                  schema.mutations.get(mutationEventEncoded.mutation) ??
                  shouldNeverHappen(`Unknown mutation: ${mutationEventEncoded.mutation}`)

                applyMutation(mutationEventEncoded, {
                  syncStatus: mutationDef.options.localOnly ? 'localOnly' : 'pending',
                  shouldBroadcast: true,
                  persisted,
                })
              }
            }
          })

          return Layer.succeed(WorkerCtx, workerCtx)
        }).pipe(
          (_) => _,
          Effect.withPerformanceMeasure('@livestore/web:worker:InitialMessage'),
          Effect.tapCauseLogPretty,
          Effect.catchAllCause((error) => {
            // TODO remove when fixed https://github.com/Effect-TS/effect/issues/2813
            shouldNeverHappen('Error initializing worker')
            return new UnexpectedError({ error })
          }),
          Layer.unwrapScoped,
        ),
      GetRecreateSnapshot: () => Effect.sync(() => initialSnapshotRef.current),
      Export: () =>
        Effect.andThen(WorkerCtx, (_) => _.ctx!.db.export).pipe(
          Effect.withSpan('@livestore/web:worker:Export'),
          Effect.catchAllCause((error) => new UnexpectedError({ error })),
        ),
      ExportMutationlog: () =>
        Effect.andThen(WorkerCtx, (_) => _.ctx!.dbLog.export).pipe(
          Effect.catchAllCause((error) => new UnexpectedError({ error })),
        ),
      ExecuteBulk: ({ items }) =>
        executeBulk(items).pipe(Effect.catchAllCause((error) => new UnexpectedError({ error }))),
      Setup: () => Effect.never,
      NetworkStatusStream: () =>
        Effect.gen(function* (_) {
          const workerCtx = yield* WorkerCtx

          if (workerCtx.ctx?.sync === undefined) {
            return Stream.succeed({ isConnected: false, timestampMs: Date.now() })
          }

          return workerCtx.ctx.sync.impl.isConnected.changes.pipe(
            Stream.map((isConnected) => ({ isConnected, timestampMs: Date.now() })),
          )
        }).pipe(Stream.unwrap),
      Shutdown: () =>
        Effect.gen(function* () {
          // TODO get rid of explicit close calls and rely on the finalizers (by dropping the scope from `InitialMessage`)
          const { ctx } = yield* WorkerCtx
          const { db, dbLog } = ctx!
          db.dbRef.current.close()
          dbLog.dbRef.current.close()
        }).pipe(Effect.catchAllCause((error) => new UnexpectedError({ error }))),
    })
  }).pipe(Layer.unwrapScoped, Layer.provide(BrowserWorkerRunner.layer))

const executeBulk = (executionItems: ReadonlyArray<ExecutionBacklogItem>) =>
  Effect.gen(function* () {
    let batchItems: ExecutionBacklogItem[] = []
    const workerCtx = yield* WorkerCtx
    if (workerCtx._tag === 'NoLock') return
    const { db, dbLog } = workerCtx.ctx

    const createdAtMemo = memoizeByStringifyArgs(() => new Date().toISOString())
    const applyMutation = makeApplyMutation(workerCtx, createdAtMemo, db.dbRef.current)

    let offset = 0

    while (offset < executionItems.length) {
      try {
        db.dbRef.current.exec('BEGIN TRANSACTION') // Start the transaction
        dbLog.dbRef.current.exec('BEGIN TRANSACTION') // Start the transaction

        batchItems = executionItems.slice(offset, offset + 50)
        offset += 50

        // console.group('livestore-webworker: executing batch')
        // batchItems.forEach((_) => {
        //   if (_._tag === 'execute') {
        //     console.log(_.query, _.bindValues)
        //   } else if (_._tag === 'mutate') {
        //     console.log(_.mutationEventEncoded.mutation, _.mutationEventEncoded.id, _.mutationEventEncoded.args)
        //   }
        // })
        // console.groupEnd()

        for (const item of batchItems) {
          if (item._tag === 'execute') {
            const { query, bindValues } = item
            db.dbRef.current.exec({ sql: query, bind: bindValues })

            // NOTE we're not writing `execute` events to the mutation_log
          } else if (item._tag === 'mutate') {
            const mutationDef =
              workerCtx.schema.mutations.get(item.mutationEventEncoded.mutation) ??
              shouldNeverHappen(`Unknown mutation: ${item.mutationEventEncoded.mutation}`)

            applyMutation(item.mutationEventEncoded, {
              syncStatus: mutationDef.options.localOnly ? 'localOnly' : 'pending',
              shouldBroadcast: true,
              persisted: item.persisted,
            })
          } else {
            // TODO handle txn
          }
        }

        db.dbRef.current.exec('COMMIT') // Commit the transaction
        dbLog.dbRef.current.exec('COMMIT') // Commit the transaction
      } catch (error) {
        try {
          db.dbRef.current.exec('ROLLBACK') // Rollback in case of an error
          dbLog.dbRef.current.exec('ROLLBACK') // Rollback in case of an error
        } catch (e) {
          console.error('Error rolling back transaction', e)
        }

        shouldNeverHappen(`Error executing query: ${error} \n ${JSON.stringify(batchItems)}`)
      }
    }
  })
