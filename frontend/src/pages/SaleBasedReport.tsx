/** Sale-based Order Report: what the sales of a period say should be ordered. Read only; it stages nothing.
 * The figures are worked out by DocAssist's own sale-based rules, so the report is read from it. */
import { Button, Checkbox, Group, NumberInput, Select, SimpleGrid, Text, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconDownload, IconPrinter, IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../api'
import type { components } from '../api-types'
import { useWorkLocation } from '../session'
import {
  DataTable, day, downloadCsv, EmptyState, Facts, FilterBar, money, Page, PageHeader, plain, printTable, type Column,
} from '../ui'
import { useMedicineOptions } from './Medicines'

type Choice = components['schemas']['Choice']

interface Row {
  item_id: number
  product_name: string | null
  product_code: string | null
  generic_name: string | null
  manufacturer_name: string | null
  manufacturer_code: string | null
  product_group: string | null
  product_category: string | null
  supplier_name: string | null
  last_purchase_batch_number: string | null
  last_purchase_expiry_date: string | null
  last_purchase_cost_cents: number | null
  sold_quantity: string
  net_sold_quantity: string
  returned_quantity: string
  average_daily_sale: string
  sale_history_days: number
  lead_time_days: number
  safety_days: number
  reorder_level: string
  reorder_quantity: string
  current_stock_quantity: string
  on_order_quantity: string
  required_quantity: string
  wanted_quantity: string
  estimated_cost_cents: number
}
interface Report {
  rows: Row[]
  totals: { line_count?: number; quantity_total?: string; estimated_cost_cents?: number }
  filter_set: { date_from?: string; date_to?: string }
  message?: string
}

const two = (top: string, bottom: string) => <><Text size="sm">{top}</Text><Text size="xs" c="dimmed">{bottom}</Text></>

export function SaleBasedReport() {
  const { locations } = useWorkLocation()
  const options = useMedicineOptions()
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api<Choice[]>('/api/purchase/suppliers'), staleTime: 60_000 })
  const [filters, setFilters] = useState<Record<string, string | null>>({ lead_time_days: '7', safety_days: '3' })
  const [skipZero, setSkipZero] = useState(true)
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 400)
  const set = (name: string, value: string | null) => setFilters({ ...filters, [name]: value })

  const query = new URLSearchParams({ skip_zero: String(skipZero) })
  for (const [name, value] of Object.entries(filters)) if (value) query.set(name, value)
  if (q) query.set('search', q)
  const report = useQuery({
    queryKey: ['sale-based-report', query.toString()],
    queryFn: () => api<Report>(`/pharmacy/api/wanted/sale-based?${query}`),
    placeholderData: keepPreviousData,
  })
  const rows = report.data?.rows ?? []
  const totals = report.data?.totals ?? {}
  const period = report.data?.filter_set
  const name = (kind: string, code: string | null) => options.data?.[kind]?.find((o) => o.code === code)?.name ?? code ?? ''
  const maker = (row: Row) => row.manufacturer_name || name('manufacturer_code', row.manufacturer_code)
  const groupCategory = (row: Row) => [name('product_group_code', row.product_group), name('product_category_code', row.product_category)].filter(Boolean).join(' / ')
  const codes = (kind: string) => (options.data?.[kind] ?? []).map((o) => ({ value: o.code, label: o.name }))

  const columns: Column<Row>[] = [
    { header: 'Product', cell: (row) => <><Text size="sm" fw={500}>{row.product_name || 'Product'}</Text><Text size="xs" c="dimmed">{[row.generic_name, maker(row)].filter(Boolean).join(', ')}</Text></> },
    { header: 'Group / category', cell: (row) => groupCategory(row) || '--' },
    { header: 'Supplier / last purchase', cell: (row) => two(row.supplier_name || '--', [row.last_purchase_batch_number && `Batch ${row.last_purchase_batch_number}`, row.last_purchase_expiry_date && `expiry ${day(row.last_purchase_expiry_date)}`].filter(Boolean).join(', ')) },
    { header: 'Sold / net', align: 'right', cell: (row) => two(plain(row.sold_quantity), `net ${plain(row.net_sold_quantity)}${Number(row.returned_quantity) ? `, returned ${plain(row.returned_quantity)}` : ''}`) },
    { header: 'Per day', align: 'right', cell: (row) => two(plain(row.average_daily_sale), `over ${row.sale_history_days} days`) },
    { header: 'Lead time', align: 'right', cell: (row) => two(`${row.lead_time_days} d`, `+ ${row.safety_days} d safety`) },
    { header: 'Reorder level / qty', align: 'right', cell: (row) => two(plain(row.reorder_level), plain(row.reorder_quantity)) },
    { header: 'Stock / on order', align: 'right', cell: (row) => two(plain(row.current_stock_quantity), plain(row.on_order_quantity)) },
    { header: 'Required', align: 'right', cell: (row) => plain(row.required_quantity) },
    { header: 'Wanted qty', align: 'right', cell: (row) => <Text size="sm" fw={600}>{plain(row.wanted_quantity)}</Text> },
    { header: 'Estimated cost', align: 'right', cell: (row) => money(row.estimated_cost_cents) },
  ]
  const headers = ['Product', 'Generic', 'Manufacturer', 'Group / category', 'Supplier', 'Sold qty', 'Net sold', 'Returned', 'Avg sale / day',
    'Lead time (days)', 'Reorder level', 'Reorder qty', 'Stock', 'On order', 'Required qty', 'Wanted qty', 'Estimated cost']
  const cells = () => rows.map((row) => [
    row.product_name ?? '', row.generic_name ?? '', maker(row), groupCategory(row), row.supplier_name ?? '', plain(row.sold_quantity),
    plain(row.net_sold_quantity), plain(row.returned_quantity), plain(row.average_daily_sale), row.lead_time_days, plain(row.reorder_level),
    plain(row.reorder_quantity), plain(row.current_stock_quantity), plain(row.on_order_quantity), plain(row.required_quantity),
    plain(row.wanted_quantity), (row.estimated_cost_cents ?? 0) / 100,
  ])
  const pick = (field: string, label: string, placeholder: string, data: Choice[]) => (
    <Select label={label} placeholder={placeholder} data={data} value={filters[field] ?? null} onChange={(value) => set(field, value)} clearable searchable />
  )

  const header = (
    <>
      <PageHeader
        title="Sale-based order report"
        actions={
          <>
            <Button variant="default" leftSection={<IconDownload size={16} />} disabled={!rows.length} onClick={() => downloadCsv('sale_based_order_report.csv', headers, cells())}>Export CSV</Button>
            <Button variant="default" leftSection={<IconPrinter size={16} />} disabled={!rows.length} onClick={() => printTable('Sale-based order report', headers, cells())}>Print</Button>
          </>
        }
      >
        <Facts items={[
          { label: 'Sales period', value: period?.date_from ? `${day(period.date_from)} to ${day(period.date_to)}` : '--' },
          { label: 'Rows', value: totals.line_count ?? rows.length },
          { label: 'Wanted qty', value: plain(totals.quantity_total) },
          { label: 'Estimated cost', value: money(totals.estimated_cost_cents) },
        ]} />
      </PageHeader>
      <FilterBar>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4, lg: 5 }}>
          <TextInput label="Search" placeholder="Search product" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
          <TextInput label="From date" type="date" value={filters.date_from ?? ''} onChange={(e) => set('date_from', e.currentTarget.value)} />
          <TextInput label="To date" type="date" value={filters.date_to ?? ''} onChange={(e) => set('date_to', e.currentTarget.value)} />
          <NumberInput label="Lead time (days)" min={1} max={120} allowDecimal={false} value={filters.lead_time_days ?? ''} onChange={(value) => set('lead_time_days', String(value))} />
          <NumberInput label="Safety stock (days)" min={0} max={60} allowDecimal={false} value={filters.safety_days ?? ''} onChange={(value) => set('safety_days', String(value))} />
          {pick('location_id', 'Location', 'All locations', locations)}
          {pick('supplier_id', 'Supplier', 'All suppliers', suppliers.data ?? [])}
          {pick('product_group', 'Product group', 'All groups', codes('product_group_code'))}
          {pick('product_category', 'Product category', 'All categories', codes('product_category_code'))}
          {pick('manufacturer', 'Manufacturer', 'All manufacturers', codes('manufacturer_code'))}
        </SimpleGrid>
        <Group justify="space-between" mt="sm">
          <Checkbox label="Hide products with enough stock" checked={skipZero} onChange={(e) => setSkipZero(e.currentTarget.checked)} />
          <Button variant="default" size="compact-sm" onClick={() => { setFilters({ lead_time_days: '7', safety_days: '3' }); setSearch(''); setSkipZero(true) }}>Reset</Button>
        </Group>
      </FilterBar>
    </>
  )

  return (
    <Page header={header}>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.item_id}
        loading={report.isFetching}
        view={query.toString()}
        empty={report.isError
          ? <EmptyState title="Could not build the report." hint={report.error.message} />
          : <EmptyState title={report.data?.message ?? 'Nothing to order.'} hint="Change the period or the filters." />}
      />
    </Page>
  )
}
