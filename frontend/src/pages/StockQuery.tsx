import { Alert, Button, Paper, Select, Tabs, Text } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconDownload, IconPrinter, IconSearch } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { api } from '../api'
import type { components } from '../api-types'
import {
  type Column, DataTable, day, downloadCsv, EmptyState, Facts, FilterBar, money, movementWords, Page, PageHeader, plain, printTable, SkeletonLines,
} from '../ui'

type Query = components['schemas']['StockQuery']
type Search = components['schemas']['ProductSearch']

/** One block of the answer: a title, column names, and the rows as plain text. Screen, file and print share it. */
interface Block {
  key: string
  title: string
  headers: string[]
  numeric: number[] // columns set to the right
  rows: string[][]
}

const batch = (number: string | null | undefined, expiry: string | null | undefined) =>
  [number || '--', expiry ? day(expiry) : null].filter(Boolean).join(', ')
const stamp = (value: string) => new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const words = (code: string) => code.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())

function blocks(data: Query): Block[] {
  return [
    {
      key: 'shelves', title: 'Stock by location', numeric: [3, 4],
      headers: ['Location', 'Batch / Expiry', 'Rack / Bin', 'Qty', 'Damaged'],
      rows: data.shelves.map((s) => [
        s.location_name, batch(s.batch_number, s.expiry_date), `${s.rack_code || '--'} / ${s.bin_code || '--'}`,
        plain(s.quantity_on_hand), plain(s.damaged_quantity),
      ]),
    },
    {
      key: 'purchases', title: 'Last 10 purchases', numeric: [5, 6, 7, 8, 9, 10, 11, 12],
      headers: ['Date', 'Supplier', 'GRN / Invoice no.', 'Batch / Expiry', 'Packing', 'Qty', 'Free', 'Unit cost', 'MRP',
        'Discount', 'Extra discount %', 'GST', 'Net'],
      rows: data.purchases.map((p) => [
        day(p.document_date), p.supplier_name ?? '--', [p.grn_number, p.invoice_number].filter(Boolean).join(' / ') || '--',
        batch(p.batch_number, p.expiry_date), p.packing ?? '--', plain(p.received_quantity), plain(p.free_quantity),
        money(p.unit_cost_cents), money(p.unit_mrp_cents), money(p.discount_amount_cents),
        plain(p.override_discount_percent), money(p.tax_amount_cents), money(p.net_amount_cents),
      ]),
    },
    {
      key: 'sales', title: 'Last 30 sales', numeric: [5, 6, 7],
      headers: ['Date', 'Bill no.', 'Patient', 'Referral doctor', 'Batch / Expiry', 'Qty', 'Returned', 'Net', 'Mode'],
      rows: data.sales.map((s) => [
        day(s.document_date), s.sales_number ?? '--', s.patient_name ?? '--', s.referral_doctor ?? '--',
        batch(s.batch_number, s.expiry_date), plain(s.quantity), plain(s.returned_quantity),
        money(s.net_amount_cents), s.payment_modes ?? '--',
      ]),
    },
    {
      key: 'movements', title: 'Last 50 movements', numeric: [3, 4],
      headers: ['Date', 'Movement', 'Batch / Location', 'Out qty', 'In qty', 'Reference no.'],
      rows: data.movements.map((m) => [
        stamp(m.created_at), movementWords(m), [m.batch_number, m.location_name].filter(Boolean).join(', ') || '--',
        Number(m.quantity_change) < 0 ? plain(-Number(m.quantity_change)) : '--',
        Number(m.quantity_change) > 0 ? plain(m.quantity_change) : '--', m.reference_number ?? '--',
      ]),
    },
    {
      key: 'issues', title: 'Last 30 internal issues and returns', numeric: [6, 7],
      headers: ['Date', 'Document no.', 'Type', 'Status', 'From location', 'To location', 'Issued qty', 'Returned'],
      rows: data.issues.map((i) => [
        day(i.document_date), i.stock_number ?? '--', words(i.stock_type), words(i.status),
        i.from_location_name ?? '--', i.issue_location_name ?? '--', plain(i.issued_quantity), plain(i.return_quantity),
      ]),
    },
  ]
}

export function StockQuery() {
  const [params, setParams] = useSearchParams()
  const itemId = Number(params.get('item')) || null
  const [typed, setTyped] = useState('')
  const [q] = useDebouncedValue(typed.trim(), 300)
  const [tab, setTab] = useState<string | null>('shelves')

  const search = useQuery({
    queryKey: ['stock-query', 'products', q],
    queryFn: () => api<Search>(`/api/stock/query/products?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
  })
  const answer = useQuery({
    queryKey: ['stock-query', itemId],
    queryFn: () => api<Query>(`/api/stock/query/${itemId}`),
    enabled: Boolean(itemId),
  })
  const data = itemId ? answer.data : undefined
  const all = data ? blocks(data) : []
  const open = all.find((block) => block.key === tab)

  // the picked product is always among the choices, so its name stays in the box
  const found = (q.length >= 2 ? search.data?.items ?? [] : []).map((p) => ({
    value: String(p.item_id), label: p.is_active ? p.item_name : `${p.item_name} (inactive)`,
  }))
  const choices = data && !found.some((c) => c.value === String(data.item_id))
    ? [{ value: String(data.item_id), label: data.item_name }, ...found]
    : found

  const header = (
    <>
      <PageHeader
        title={data ? `Stock query: ${data.item_name}` : 'Stock query'}
        actions={open && (
          <>
            <Button variant="default" leftSection={<IconDownload size={16} />} disabled={!open.rows.length}
              onClick={() => downloadCsv(`stock_query_${open.key}.csv`, open.headers, open.rows)}>Export CSV</Button>
            <Button variant="default" leftSection={<IconPrinter size={16} />} disabled={!open.rows.length}
              onClick={() => printTable(`${data?.item_name}: ${open.title}`, open.headers, open.rows)}>Print</Button>
          </>
        )}
      >
        {data && (
          <Facts
            items={[
              { label: 'On hand', value: `${plain(data.summary.on_hand)} ${data.unit_of_measure ?? ''}` },
              { label: 'Damaged', value: plain(data.summary.damaged) },
              { label: 'In transit', value: plain(data.summary.in_transit) },
              { label: 'MRP value', value: money(data.summary.value_cents) },
              { label: 'Generic', value: data.generic_name || '--' },
            ]}
          />
        )}
      </PageHeader>
      <FilterBar>
        <Select
          aria-label="Product"
          placeholder="Search product by name, generic name or code"
          leftSection={<IconSearch size={16} />}
          data={choices}
          value={itemId ? String(itemId) : null}
          onChange={(value) => setParams(value ? { item: value } : {}, { replace: true })}
          searchable
          searchValue={typed}
          onSearchChange={setTyped}
          filter={({ options }) => options} // the server has already done the searching
          nothingFoundMessage={q.length < 2 ? 'Type at least 2 letters.' : search.isFetching ? <SkeletonLines /> : 'No product found.'}
          clearable
          maw={520}
        />
        {search.data?.more && <Text size="xs" c="dimmed" mt={4}>More products match. Type more of the name.</Text>}
      </FilterBar>
    </>
  )

  return (
    <Page header={header}>
      {answer.isError && <Alert color="red">{answer.error.message}</Alert>}
      {!itemId && <Paper withBorder><EmptyState title="Pick a product." hint="Its stock, purchases, sales and movements are shown here." /></Paper>}
      {data && (
        <Tabs value={tab} onChange={setTab}>
          <Tabs.List mb="md">
            {all.map((block) => <Tabs.Tab key={block.key} value={block.key}>{block.title} ({block.rows.length})</Tabs.Tab>)}
          </Tabs.List>
          {all.map((block) => (
            <Tabs.Panel key={block.key} value={block.key}>
              <DataTable
                columns={block.headers.map((title, index): Column<string[]> => ({
                  header: title, align: block.numeric.includes(index) ? 'right' : undefined, cell: (row) => row[index],
                }))}
                rows={block.rows}
                rowKey={(row) => block.rows.indexOf(row)}
                empty={<EmptyState title="Nothing here for this product." />}
              />
            </Tabs.Panel>
          ))}
        </Tabs>
      )}
    </Page>
  )
}
