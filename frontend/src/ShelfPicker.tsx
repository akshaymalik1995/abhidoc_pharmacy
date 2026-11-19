import { Select } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from './api'
import type { components } from './api-types'
import {
  day, plain, SkeletonLines,
} from './ui'

export type Shelf = components['schemas']['StockRow']

/** Picks one batch of a product from what is on the shelves of one location. The search is done by the server. */
export function ShelfPicker(props: { locationId: string | null; value: Shelf | null; onChange: (shelf: Shelf | null) => void; label: string }) {
  const [typed, setTyped] = useState('')
  const [q] = useDebouncedValue(typed.trim(), 250)
  const search = useQuery({
    queryKey: ['shelves', props.locationId, q],
    queryFn: () => api<{ items: Shelf[] }>(`/api/stock/overall?location_id=${props.locationId}&limit=20&q=${encodeURIComponent(q)}`),
    enabled: Boolean(props.locationId) && q.length >= 2,
  })
  const found = (q.length >= 2 ? search.data?.items ?? [] : []).filter((shelf) => Number(shelf.quantity_on_hand) > 0)
  const shelves = props.value && !found.some((s) => s.stock_balance_id === props.value?.stock_balance_id) ? [props.value, ...found] : found

  return (
    <Select
      aria-label={props.label}
      placeholder={props.locationId ? 'Search product or batch' : 'Select the location first'}
      disabled={!props.locationId}
      data={shelves.map((s) => ({
        value: String(s.stock_balance_id),
        label: `${s.item_name}, batch ${s.batch_number || '--'}, expiry ${day(s.expiry_date)}, on hand ${plain(s.quantity_on_hand)}`,
      }))}
      value={props.value ? String(props.value.stock_balance_id) : null}
      onChange={(id) => props.onChange(shelves.find((s) => String(s.stock_balance_id) === id) ?? null)}
      searchable
      searchValue={typed}
      onSearchChange={setTyped}
      filter={({ options }) => options}
      nothingFoundMessage={q.length < 2 ? 'Type at least 2 letters.' : search.isFetching ? <SkeletonLines /> : 'Nothing on the shelves here.'}
      size="xs"
    />
  )
}
