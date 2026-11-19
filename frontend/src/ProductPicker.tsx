import { Select } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from './api'
import type { components } from './api-types'
import { SkeletonLines } from './ui'

export type OrderProduct = components['schemas']['OrderProduct']

/** Finds a product by typing part of its name; the search is done by the server. */
export function ProductPicker(props: { value: OrderProduct | null; onChange: (product: OrderProduct | null) => void; label: string }) {
  const [typed, setTyped] = useState('')
  const [q] = useDebouncedValue(typed.trim(), 250)
  const search = useQuery({
    queryKey: ['order-products', q],
    queryFn: () => api<OrderProduct[]>(`/api/purchase/products?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
  })
  const found = q.length >= 2 ? search.data ?? [] : []
  // the picked product stays among the choices, so its name stays in the box
  const products = props.value && !found.some((p) => p.item_id === props.value?.item_id) ? [props.value, ...found] : found

  return (
    <Select
      aria-label={props.label}
      placeholder="Search product"
      data={products.map((p) => ({ value: String(p.item_id), label: p.item_name }))}
      value={props.value ? String(props.value.item_id) : null}
      onChange={(id) => props.onChange(products.find((p) => String(p.item_id) === id) ?? null)}
      searchable
      searchValue={typed}
      onSearchChange={setTyped}
      filter={({ options }) => options}
      nothingFoundMessage={q.length < 2 ? 'Type at least 2 letters.' : search.isFetching ? <SkeletonLines /> : 'No product found.'}
      size="xs"
    />
  )
}
