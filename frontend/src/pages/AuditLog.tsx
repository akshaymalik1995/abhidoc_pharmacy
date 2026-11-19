/** Audit Log: every recorded action in the pharmacy (sales, purchases, stock, accounts, settings), newest first. The log
 * is DocAssist's, read through it; the Details line is only made readable here, never changed. */
import { Button, Checkbox, Group, Select, Text, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconDownload } from '@tabler/icons-react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { contract } from '../api'
import { DataTable, EmptyState, Facts, FilterBar, notifySuccess, Page, PageHeader, Pager, type Column } from '../ui'
import { words } from './PurchaseList'
import { dateTime } from './SaleShared'

interface Entry { audit_event_id: number; timestamp: string; log_type: string; actor: string | null; action: string | null; action_words: string | null; source_module: string | null;
  source_module_words: string | null; source_document: string | null; entity_type: string | null; entity_type_words: string | null; before_summary: string | null;
  after_summary: string | null; summary: string | null }
const LOG_TYPES: Record<string, string> = {
  ALL: 'All types', SALE: 'Sales', RETURN: 'Returns', PURCHASE: 'Purchases', RECEIVING: 'Goods receipt', STOCK_MOVEMENT: 'Stock movements', ADJUSTMENT: 'Stock adjustments',
  WRITE_OFF: 'Write-offs', CONSIGNMENT: 'Consignments', USER: 'Users', PERMISSION: 'Roles & permissions', CONFIG: 'Preferences', CANCELLATION: 'Cancellations',
  REPORT: 'Reports', ACCOUNT: 'Accounts', OTHER: 'Other',
}
const EXPORT_MAX = 50000

/** The Details line as a person reads it: a location or printer id is named, 0 reads "none", and ids with no name to show
 * (item, user, resource), ports and IP addresses are left out. */
function plainDetails(text: string | null, places: Record<string, string>, printers: Record<string, string>) {
  if (!text) return text
  const name = (names: Record<string, string>, v: string) => { const t = v.trim(); return t === '0' || t === '--' || t === '' ? 'none' : names[t] ?? null }
  const parts = text.split(';').map((part) => {
    const piece = part.trim()
    if (/^(port|ip address)\b/i.test(piece)) return null
    const m = piece.match(/^(.*?)\b([a-z][a-z ]*?) id\s*(=|:)\s*(.+)$/i)
    if (!m) return piece
    const thing = m[2].trim().toLowerCase()
    const names = thing === 'location' || thing === 'store' ? places : thing === 'device' ? printers : null
    if (!names) return m[1].trim() || null
    const values = m[4].split(/\s*(?:→|->)\s*/).map((v) => name(names, v))
    if (values.some((v) => v === null)) return m[1].trim() || null
    return `${m[1]}${names === places ? 'Location' : 'Printer'}${m[3] === '=' ? ' = ' : ': '}${values.join(' → ')}`
  }).filter((p): p is string => Boolean(p))
  // a lead-in left with nothing after it ("filters:") goes too
  return parts.filter((p, i) => !(/:$/.test(p) && i === parts.length - 1)).join('; ')
}

export function AuditLog() {
  const [filters, setFilters] = useState<Record<string, string>>({ log_type: 'ALL', source_module: '', from_date: '', to_date: '', mine: '' })
  const [doc, setDoc] = useState('')
  const [action, setAction] = useState('')
  const [typed] = useDebouncedValue({ doc: doc.trim(), action: action.trim() }, 300)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const chosen = new URLSearchParams(Object.entries({ ...filters, log_type: filters.log_type === 'ALL' ? '' : filters.log_type, source_document: typed.doc, action: typed.action })
    .filter(([, v]) => v))
  const query = new URLSearchParams([...chosen, ['limit', String(size)], ['offset', String((page - 1) * size)]])
  const log = useQuery({ queryKey: ['audit-log', query.toString()], placeholderData: keepPreviousData,
    queryFn: () => contract<{ rows: Entry[]; total: number; log_types?: string[] }>(`/pharmacy/api/mis/audit-log?${query}`) })
  // the names of this hospital's locations and printers, for the Details line
  const context = useQuery({ queryKey: ['location-context'], staleTime: 300_000,
    queryFn: () => contract<{ locations?: { location_id: number; location_name: string }[]; devices?: { device_id: number; device_name: string }[] }>('/pharmacy/api/location-context') })
  const places = Object.fromEntries((context.data?.locations ?? []).map((l) => [String(l.location_id), l.location_name]))
  const printers = Object.fromEntries((context.data?.devices ?? []).map((d) => [String(d.device_id), d.device_name]))
  const set = (name: string, v: string | null) => { setFilters({ ...filters, [name]: v ?? '' }); setPage(1) }
  const total = log.data?.total ?? 0
  const columns: Column<Entry>[] = [
    { header: 'Date and time', cell: (r) => dateTime(r.timestamp?.replace(' ', 'T')) },
    { header: 'Type', cell: (r) => LOG_TYPES[r.log_type] ?? words(r.log_type) },
    { header: 'User', cell: (r) => r.actor || '--' },
    { header: 'Action', cell: (r) => r.action_words || words(r.action) },
    { header: 'Module', cell: (r) => r.source_module_words || words(r.source_module) || '--' },
    { header: 'Document no.', cell: (r) => r.source_document || '--' },
    { header: 'Document kind', cell: (r) => r.entity_type_words || words(r.entity_type) || '--' },
    { header: 'Details', cell: (r) => {
      // the states where the entry has states, then what was done with its key figures; the whole on pointing
      const states = r.before_summary || r.after_summary ? `${plainDetails(r.before_summary, places, printers) || '--'} → ${plainDetails(r.after_summary, places, printers) || '--'}` : ''
      const text = [states, plainDetails(r.summary, places, printers)].filter(Boolean).join('; ') || '--'
      return <Text size="sm" title={text} truncate maw={320}>{text}</Text>
    } },
  ]
  const onlyType = filters.log_type !== 'ALL' && !filters.source_module && !filters.from_date && !filters.to_date && !typed.doc && !typed.action && !filters.mine
  return (
    <Page header={<>
      <PageHeader title="Audit log" actions={
        <Button variant="default" leftSection={<IconDownload size={16} />} component="a" href={`/pharmacy/api/mis/audit-log/export?${chosen}`}
          onClick={() => { if (total > EXPORT_MAX) notifySuccess(`The file holds the first ${EXPORT_MAX} of ${total} entries.`) }}>Export CSV</Button>}>
        <Facts items={[{ label: 'Entries', value: total }]} />
      </PageHeader>
      <FilterBar>
        <Group align="end" wrap="wrap">
          <Select aria-label="Type" w={190} allowDeselect={false} value={filters.log_type} onChange={(v) => set('log_type', v ?? 'ALL')}
            data={(log.data?.log_types ?? ['ALL']).map((k) => ({ value: k, label: LOG_TYPES[k] ?? words(k) }))} />
          <Select aria-label="Module" placeholder="All modules" w={160} clearable value={filters.source_module || null} onChange={(v) => set('source_module', v)}
            data={['PHARMACY', 'ACCOUNTS', 'SALES', 'PURCHASE', 'STOCK'].map((m) => ({ value: m, label: words(m) }))} />
          <TextInput aria-label="From date" type="date" w={150} value={filters.from_date} onChange={(e) => set('from_date', e.currentTarget.value)} />
          <TextInput aria-label="To date" type="date" w={150} value={filters.to_date} onChange={(e) => set('to_date', e.currentTarget.value)} />
          <TextInput aria-label="Document no." placeholder="Document no." w={170} value={doc} onChange={(e) => { setDoc(e.currentTarget.value); setPage(1) }} />
          <TextInput aria-label="Action" placeholder="Action" w={150} value={action} onChange={(e) => { setAction(e.currentTarget.value); setPage(1) }} />
          <Checkbox label="My entries only" checked={filters.mine === '1'} onChange={(e) => set('mine', e.currentTarget.checked ? '1' : '')} mb={8} />
        </Group>
      </FilterBar>
    </>}>
      <DataTable columns={columns} rows={log.data?.rows ?? []} rowKey={(r) => r.audit_event_id} loading={log.isFetching} view={query.toString()}
        empty={<EmptyState title={log.isError ? 'Could not load. Try again.' : onlyType ? 'No audit entries of this type found.' : 'No audit entries found.'} />}
        footer={<Pager page={page} pageSize={size} total={total} onChange={setPage} sizes={[10, 25, 50, 100]} onSize={(n) => { setSize(n); setPage(1) }} />} />
    </Page>
  )
}
