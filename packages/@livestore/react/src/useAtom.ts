import type { DerivedMutationHelperFns, QueryInfo } from '@livestore/common'
import type { DbSchema } from '@livestore/common/schema'
import type { SqliteDsl } from '@livestore/db-schema'
import type { GetResult, LiveQueryDef, Store } from '@livestore/livestore'
import { shouldNeverHappen } from '@livestore/utils'
import React from 'react'

import { useStore } from './LiveStoreContext.js'
import { useQueryRef } from './useQuery.js'
import type { Dispatch, SetStateAction } from './useRow.js'

export const useAtom = <
  // TODO also support colJsonValue
  TQuery extends LiveQueryDef<any, QueryInfo.Row | QueryInfo.Col>,
>(
  queryDef: TQuery,
  options?: {
    store?: Store
  },
): [value: GetResult<TQuery>, setValue: Dispatch<SetStateAction<Partial<GetResult<TQuery>>>>] => {
  const queryRef = useQueryRef(queryDef, { store: options?.store })
  const query$ = queryRef.queryRcRef.value

  // @ts-expect-error runtime check
  if (query$.queryInfo._tag === 'None') {
    shouldNeverHappen(`Can't useAtom with a query that has no queryInfo`, queryDef)
  }

  const { store } = useStore()

  // TODO make API equivalent to useRow
  const setValue = React.useMemo<Dispatch<SetStateAction<Partial<GetResult<TQuery>>>>>(
    () => (newValueOrFn: any) => {
      const newValue = typeof newValueOrFn === 'function' ? newValueOrFn(queryRef.valueRef.current) : newValueOrFn
      const table = query$.queryInfo.table as DbSchema.TableDef &
        DerivedMutationHelperFns<SqliteDsl.Columns, DbSchema.TableOptions>

      if (query$.queryInfo._tag === 'Row') {
        if (table.options.isSingleton && table.options.isSingleColumn) {
          store.mutate(table.update(newValue))
        } else if (table.options.isSingleColumn) {
          store.mutate(table.update({ where: { id: query$.queryInfo.id }, values: { value: newValue } }))
        } else {
          store.mutate(table.update({ where: { id: query$.queryInfo.id }, values: newValue }))
        }
      } else {
        if (table.options.isSingleton && table.options.isSingleColumn) {
          store.mutate(table.update({ [query$.queryInfo.column]: newValue }))
        } else {
          store.mutate(
            table.update({
              where: { id: query$.queryInfo.id },
              values: { [query$.queryInfo.column]: newValue },
            }),
          )
        }
      }
    },
    [query$.queryInfo, queryRef.valueRef, store],
  )

  return [queryRef.valueRef.current, setValue]
}
