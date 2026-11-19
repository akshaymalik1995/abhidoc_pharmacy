import { Anchor, Button, Select, SimpleGrid, Text, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconDownload, IconPrinter, IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../api'
import type { components } from '../api-types'
import {
  DataTable, EmptyState, Facts, FilterBar, money, notifyFailure, Page, PageHeader, Pager, plain, printTable,
  type Column,
} from '../ui'
import { StockDiary } from './StockDiary'

type Ledger = components['schemas']['Ledger']
type Row = components['schemas']['LedgerRow']

const URL = '/api/stock/ledger'
const NO_FILTERS: Record<string, string> = {}
const both = (quantity: string | undefined, cents: number | undefined) => `${plain(quantity)} (${money(cents)})`

export function StockLedger() {
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 300)
  const [filters, setFilters] = useState(NO_FILTERS)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [diaryOf, setDiaryOf] = useState<Row | null>(null)
  const [printing, setPrinting] = useState(false)

  const chosen = new URLSearchParams({ ...filters, q })
  const query = new URLSearchParams({ ...filters, q, limit: String(pageSize), offset: String((page - 1) * pageSize) })
  const ledger = useQuery({
    queryKey: ['stock-ledger', query.toString()],
    queryFn: () => api<Ledger>(`${URL}?${query}`),
    placeholderData: keepPreviousData,
  })

  function setFilter(name: string, value: string | null) {
    const next = { ...filters }
    if (value) next[name] = value
    else delete next[name]
    setFilters(next)
    setPage(1)
  }

  async function print() {
    setPrinting(true)
    try {
      const all = await api<Ledger>(`${URL}?${chosen}&output=all`)
      printTable(
        'Stock ledger',
        ['Product', 'Generic', 'Group / category', 'Opening qty', 'Opening value', 'Inward qty', 'Inward value',
          'Outward qty', 'Outward value', 'Closing qty', 'Closing value'],
        all.items.map((row) => [
          row.item_name, row.generic_name ?? '', [row.product_group, row.product_category].filter(Boolean).join(' / '),
          plain(row.opening_quantity), money(row.opening_value_cents), plain(row.in_quantity), money(row.in_value_cents),
          plain(row.out_quantity), money(row.out_value_cents), plain(row.closing_quantity), money(row.closing_value_cents),
        ]),
      )
    } catch (error) {
      notifyFailure(error as Error)
    } finally {
      setPrinting(false)
    }
  }

  const columns: Column<Row>[] = [
    {
      header: 'Product',
      cell: (row) => (
        <>
          <Anchor component="button" type="button" size="sm" fw={500} c="bottle.7" onClick={() => setDiaryOf(row)}>{row.item_name}</Anchor>
          <Text size="xs" c="dimmed">{row.generic_name}</Text>
        </>
      ),
    },
    { header: 'Group / category', cell: (row) => [row.product_group, row.product_category].filter(Boolean).join(' / ') || '--' },
    { header: 'Opening qty', align: 'right', cell: (row) => plain(row.opening_quantity) },
    { header: 'Opening value', align: 'right', cell: (row) => money(row.opening_value_cents) },
    { header: 'Inward qty', align: 'right', cell: (row) => plain(row.in_quantity) },
    { header: 'Inward value', align: 'right', cell: (row) => money(row.in_value_cents) },
    { header: 'Outward qty', align: 'right', cell: (row) => plain(row.out_quantity) },
    { header: 'Outward value', align: 'right', cell: (row) => money(row.out_value_cents) },
    { header: 'Closing qty', align: 'right', cell: (row) => <Text size="sm" fw={600}>{plain(row.closing_quantity)}</Text> },
    { header: 'Closing value', align: 'right', cell: (row) => <Text size="sm" fw={600}>{money(row.closing_value_cents)}</Text> },
  ]
  const totals = ledger.data?.totals
  const choice = (name: string, label: string, placeholder: string, data: { value: string; label: string }[] | undefined) => (
    <Select label={label} placeholder={placeholder} data={data ?? []} value={filters[name] ?? null}
      onChange={(value) => setFilter(name, value)} clearable searchable />
  )

  const header = (
    <>
      <PageHeader
        title="Stock ledger"
        actions={
          <>
            <Button variant="default" leftSection={<IconDownload size={16} />} component="a" href={`${URL}?${chosen}&output=csv`}>Export CSV</Button>
            <Button variant="default" leftSection={<IconPrinter size={16} />} loading={printing} onClick={print}>Print</Button>
          </>
        }
      >
        <Facts
          items={[
            { label: 'Opening', value: both(totals?.opening_quantity, totals?.opening_value_cents) },
            { label: 'Inward', value: both(totals?.in_quantity, totals?.in_value_cents) },
            { label: 'Outward', value: both(totals?.out_quantity, totals?.out_value_cents) },
            { label: 'Closing', value: both(totals?.closing_quantity, totals?.closing_value_cents) },
            ...(filters.location_id ? [] : [{ label: 'Of which in transit', value: plain(totals?.in_transit_quantity) }]),
          ]}
        />
      </PageHeader>
      <FilterBar>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4, lg: 7 }} style={{ alignItems: 'end' }}>
          <TextInput label="From date" type="date" value={filters.from_date ?? ''} onChange={(e) => setFilter('from_date', e.currentTarget.value)} />
          <TextInput label="To date" type="date" value={filters.to_date ?? ''} onChange={(e) => setFilter('to_date', e.currentTarget.value)} />
          {choice('location_id', 'Location', 'All locations', ledger.data?.locations)}
          {choice('product_group_code', 'Product group', 'All groups', ledger.data?.product_groups)}
          {choice('product_category_code', 'Product category', 'All categories', ledger.data?.product_categories)}
          <TextInput label="Product" placeholder="Search product" maxLength={128} leftSection={<IconSearch size={16} />}
            value={search} onChange={(e) => { setSearch(e.currentTarget.value); setPage(1) }} />
          <Button variant="default" onClick={() => { setFilters(NO_FILTERS); setSearch(''); setPage(1) }}>Reset</Button>
        </SimpleGrid>
      </FilterBar>
    </>
  )

  return (
    <Page header={header}>
      <DataTable
        columns={columns}
        rows={ledger.data?.items ?? []}
        rowKey={(row) => row.item_id}
        view={query.toString()}
        loading={ledger.isFetching}
        empty={ledger.isError
          ? <EmptyState title="Could not load the stock ledger." hint={ledger.error.message} />
          : <EmptyState title="No products found." hint="Change the dates or the filters." />}
        footer={
          <Pager page={page} pageSize={pageSize} total={ledger.data?.total ?? 0} onChange={setPage}
            sizes={[10, 25, 50, 100]} onSize={(size) => { setPageSize(size); setPage(1) }} />
        }
      />
      {diaryOf && (
        <StockDiary itemId={diaryOf.item_id} itemName={diaryOf.item_name} locationId={filters.location_id}
          from={filters.from_date} to={filters.to_date} onClose={() => setDiaryOf(null)} />
      )}
    </Page>
  )
}
