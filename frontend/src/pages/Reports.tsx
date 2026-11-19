/** Reports: DocAssist's catalogue of pharmacy reports, each with its own filters, columns and totals, read through it.
 * The Stock section's Unsold, Ageing and Expiring Stocks are this viewer opened on one report. */
import { Button, Collapse, Group, NumberInput, Select, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconAdjustmentsHorizontal, IconDownload, IconPrinter, IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { contract } from '../api'
import { useWorkLocation } from '../session'
import { DataTable, day, EmptyState, Facts, FilterBar, money, Page, PageHeader, Pager, plain, type Column } from '../ui'
import { words } from './PurchaseList'
import { dateTime } from './SaleShared'

interface Filter { field: string; label?: string; type?: string; default?: string | number | null; applied?: boolean; options?: (string | { value: string; label: string })[] }
interface Entry { report_key: string; title: string; group: string; is_implemented: boolean; status_label?: string; implementation_status?: string; filter_contract?: { filters?: Filter[] } }
interface Catalog { rows: Entry[]; groups: { group_id: string; name: string }[] }
interface Reply { status?: string; message?: string; status_label?: string; note?: string; totals_note?: string; columns?: { key: string; label: string }[]
  rows: Record<string, unknown>[]; totals?: Record<string, number>; total_count: number; shown: number; offset?: number; has_more?: boolean }

// columns that hold a stored code, found by their name; their cells are written in words
const CODE_COLUMNS = /(^|_)(type|status|mode|modes|state|kind|module|policy|direction)$|^(status_after|status_before|account_head|line_category|action_code|module_code|payer_name)$/
const HEAD_WORDS: Record<string, string> = {
  sales_number: 'Bill no.', document_number: 'Document no.', account_number: 'Document no.', grn_number: 'GRN no.', invoice_number: 'Invoice no.',
  document_date: 'Date', mrn: 'MRN', visit_number: 'Visit no.', patient_name_snapshot: 'Patient', doctor_name_snapshot: 'Doctor',
  referral_doctor_snapshot: 'Referral doctor', payer_name_snapshot: 'Payer', location_name: 'Location', balance_amount_cents: 'Balance due',
  refunded_amount_cents: 'Refunded', sales_type: 'Type', primary_payment_mode: 'Main payment mode', payment_modes: 'Payment modes used',
}
/** A heading as the screen writes it: sentence case, abbreviations kept, the definitions' "Referal" put right. */
function label(text: string) {
  return text.replace(/\bRefer+al\b/gi, (w) => (w[0] === 'R' ? 'Referral' : 'referral')).replace(/^Landed-cost amount$/i, 'Landed cost')
    .replace(/^Product name$/i, 'Product').replace(/^MRP amount$/i, 'MRP value')
    .split(' ').map((word, i) => (i === 0 || /^[A-Z0-9%/&().-]+$/.test(word) ? word : word.charAt(0).toLowerCase() + word.slice(1))).join(' ')
}
const fromKey = (k: string) => HEAD_WORDS[k] ?? k.replace(/_cents$/, '').replace(/_snapshot$/, '').replace(/^(is|has)_/, '').replace(/_amount$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
const rank = (k: string) => (/(^|_)(number|no)$/.test(k) && !/visit|phone|contact/.test(k) ? 0 : /date|_at$/.test(k) ? 1 : /^patient|^customer|^supplier/.test(k) ? 2 : k === 'mrn' ? 2.5 : /_cents$/.test(k) ? 4 : 3)
/** A report that does not declare its columns: document number and date first, money last, id-only columns left out. */
function screenColumns(rows: Record<string, unknown>[]) {
  const keys = Object.keys(rows[0] ?? {})
  const idOnly = (k: string) => /_id$/.test(k) || (/_by$/.test(k) && rows.every((r) => r[k] == null || r[k] === '' || /^\d+$/.test(String(r[k]))))
  return keys.filter((k) => !idOnly(k)).map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i).map((c) => c.k)
}
const numeric = (k: string) => /_cents$|quantity|percent|(^|_)(dis)?count|bills|lines$/.test(k)
function cell(k: string, v: unknown) {
  if (v == null || v === '') return '--'
  if (/_cents$/.test(k)) return money(Number(v))
  if (/^(is|has)_/.test(k)) { const s = String(v).toLowerCase(); return s === '1' || s === 'true' ? 'Yes' : s === '0' || s === 'false' ? 'No' : String(v) }
  if (/quantity/.test(k)) return plain(v as string)
  const text = String(v)
  if (CODE_COLUMNS.test(k) && /^[A-Z][A-Z0-9_]*(\s*,\s*[A-Z][A-Z0-9_]*)*$/.test(text)) return text.split(/\s*,\s*/).map(words).join(', ')
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return day(text)
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text)) return dateTime(text.replace(' ', 'T'))
  return text.slice(0, 60)
}

export function Reports({ fixed, title }: { fixed?: string; title?: string }) {
  const [address] = useSearchParams()
  const { locationId, locations } = useWorkLocation()
  const catalog = useQuery({ queryKey: ['report-catalog'], queryFn: () => contract<Catalog>('/pharmacy/api/mis/catalog'), staleTime: 300_000 })
  const [key, setKey] = useState<string | null>(fixed ?? address.get('report'))
  const [days, setDays] = useState(['7', '30', '90'].includes(address.get('days') ?? '') ? address.get('days')! : '30')
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 300)
  const [values, setValues] = useState<Record<string, string>>({})
  const [moreOpen, setMoreOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const entry = catalog.data?.rows.find((r) => r.report_key === key)
  // only the filters this report uses; days, paging and search have their own boxes
  const fields = (entry?.filter_contract?.filters ?? []).filter((f) => !['days', 'limit', 'offset', 'q'].includes(f.field) && f.applied !== false)
  // the location starts on the working location; "All locations" is 0
  const valueOf = (f: Filter) => values[f.field] ?? (f.field === 'location_id' ? locationId ?? '' : '')
  const params = new URLSearchParams({ days })
  if (q) params.set('q', q)
  for (const f of fields) { const v = String(valueOf(f)).trim(); if (v && v !== String(f.default ?? '')) params.set(f.field, v) }
  const query = new URLSearchParams([...params, ['limit', String(size)], ['offset', String((page - 1) * size)]])
  const report = useQuery({ queryKey: ['report', key, query.toString()], enabled: Boolean(key && entry), placeholderData: keepPreviousData,
    queryFn: () => contract<Reply>(`/pharmacy/api/reports/${key}?${query}`) })
  const d = report.data?.status === 'success' || report.data?.rows ? report.data : undefined
  const set = (name: string, v: string | null) => { setValues({ ...values, [name]: v ?? '' }); setPage(1) }
  const heading = Object.fromEntries((d?.columns ?? []).map((c) => [c.key, c.label]))
  const cols = d?.columns ? d.columns.map((c) => c.key) : screenColumns(d?.rows ?? [])
  const columns: Column<Record<string, unknown>>[] = cols.map((k) => ({ header: label(heading[k] ?? fromKey(k)), align: numeric(k) ? 'right' : undefined, cell: (r) => cell(k, r[k]) }))
  const totalKeys = d?.totals ? (d.columns ? d.columns.map((c) => c.key).filter((k) => k in d.totals!) : Object.keys(d.totals)) : []
  const firstRow = fields.slice(0, 3)
  const folded = fields.slice(3)
  const setCount = folded.filter((f) => values[f.field] !== undefined && values[f.field] !== '' && values[f.field] !== String(f.default ?? '')).length

  const control = (f: Filter) => {
    const name = label(f.label ?? fromKey(f.field))
    if (f.field === 'location_id') return <Select key={f.field} label={name} w={200} allowDeselect={false} value={String(valueOf(f) || '0')} onChange={(v) => set(f.field, v)}
      data={[{ value: '0', label: 'All locations' }, ...locations]} />
    if (f.type === 'select') return <Select key={f.field} label={name} w={200} allowDeselect={false} value={String(values[f.field] ?? f.default ?? '')} onChange={(v) => set(f.field, v)}
      data={(f.options ?? []).map((o) => (typeof o === 'object' ? { value: String(o.value), label: o.label } : { value: String(o ?? ''), label: o ? words(String(o)) : 'All' }))} />
    if (f.type === 'date') return <TextInput key={f.field} label={name} type="date" w={160} value={values[f.field] ?? ''} onChange={(e) => set(f.field, e.currentTarget.value)} />
    if (f.type === 'number' || f.type === 'location') return <NumberInput key={f.field} label={name} w={160} min={0} hideControls value={values[f.field] ?? ''} onChange={(v) => set(f.field, String(v))} />
    return <TextInput key={f.field} label={name} w={200} value={values[f.field] ?? ''} onChange={(e) => set(f.field, e.currentTarget.value)} />
  }
  const groups = (catalog.data?.groups ?? []).map((g) => ({
    group: g.name, items: (catalog.data?.rows ?? []).filter((r) => r.group === g.group_id).sort((a, b) => a.title.localeCompare(b.title))
      .map((r) => ({ value: r.report_key, label: r.is_implemented ? r.title : `${r.title} (${r.status_label})`, disabled: !r.is_implemented })),
  })).filter((g) => g.items.length)
  const ready = Boolean(key) && entry?.implementation_status === 'available'
  const refused = report.data && report.data.status !== 'success' && !report.data.rows ? report.data.status_label || report.data.message || 'This report is not available.' : null

  const header = (
    <>
      <PageHeader title={title ?? (entry?.title || 'Reports')} actions={<>
        <Button variant="default" leftSection={<IconPrinter size={16} />} disabled={!ready} component="a" target="_blank" href={`/pharmacy/api/reports/${key}/print?${params}&view=page`}>Print</Button>
        <Button variant="default" leftSection={<IconDownload size={16} />} disabled={!ready} component="a" href={`/pharmacy/api/reports/${key}/export?${params}&format=CSV`}>Export CSV</Button>
      </>}>
        {totalKeys.length > 0 && <Facts items={totalKeys.map((k) => ({ label: label(heading[k] ?? fromKey(k)), value: /_cents$/.test(k) ? money(d!.totals![k]) : plain(d!.totals![k]) }))} />}
      </PageHeader>
      <FilterBar>
        <Group align="end" wrap="wrap">
          {!fixed && <Select label="Report" placeholder="Select report" w={300} searchable data={groups} value={key} onChange={(v) => { setKey(v); setValues({}); setPage(1) }} />}
          <Select label="Period" w={140} allowDeselect={false} value={days} onChange={(v) => { setDays(v ?? '30'); setPage(1) }}
            data={[{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }]} />
          <TextInput label="Search" placeholder="Search product" leftSection={<IconSearch size={16} />} w={220} value={search} onChange={(e) => { setSearch(e.currentTarget.value); setPage(1) }} />
          {firstRow.map(control)}
          {folded.length > 0 && <Button variant="default" leftSection={<IconAdjustmentsHorizontal size={16} />} onClick={() => setMoreOpen(!moreOpen)}>More filters{setCount ? ` (${setCount})` : ''}</Button>}
          <Button variant="default" onClick={() => { setValues({}); setSearch(''); setPage(1) }}>Reset</Button>
        </Group>
        <Collapse expanded={folded.length > 0 && (moreOpen || setCount > 0)}><Group mt="sm" align="end" wrap="wrap">{folded.map(control)}</Group></Collapse>
      </FilterBar>
    </>
  )
  return (
    <Page header={header}>
      <DataTable columns={columns} rows={(d?.rows ?? []).map((r, i) => ({ ...r, __row: i }))} rowKey={(r) => r.__row as number} loading={report.isFetching || catalog.isPending} view={`${key}-${query}`}
        empty={<EmptyState title={!key ? 'Select a report.' : refused || (report.isError ? 'Could not load. Try again.' : 'No rows found.')} />}
        footer={d && <Pager page={page} pageSize={size} total={d.total_count} onChange={setPage} sizes={[10, 25, 50, 100]} onSize={(n) => { setSize(n); setPage(1) }} />} />
    </Page>
  )
}
