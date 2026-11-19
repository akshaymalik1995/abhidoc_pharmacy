/** Deliveries: the home-delivery queue across bills. Tick rows to send them out, sign for them or take them back;
 * a bill's "Delivery" opens that bill's own delivery (?sale=<id>). Reads and saves go through DocAssist. */
import { Alert, Button, Checkbox, Group, Select, Stack, Text, TextInput } from '@mantine/core'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { contract } from '../api'
import { DataTable, EmptyState, Facts, FilterBar, money, notifyFailure, notifySuccess, Page, PageHeader, SidePanel, StatusBadge, type Column } from '../ui'
import { dateTime } from './SaleShared'

interface Delivery {
  stock_document_id: number
  stock_number: string
  sales_document_id: number | null
  sales_number: string | null
  patient_name_snapshot: string | null
  location_name: string | null
  net_amount_cents: number | null
  status: string
  reference_number: string | null // who carried it
  signed_by: string | null
  issued_at: string | null
  received_at: string | null
  notes: string | null
}
interface Reply { deliveries: Delivery[]; locations: { location_id: number; location_name: string }[] }

const WORDS: Record<string, string> = { PENDING: 'Packed', IN_TRANSIT: 'In transit', RETURNED: 'Returned', RECEIVED: 'Delivered', CANCELLED: 'Cancelled' }
const STATUS = [{ value: 'PENDING,IN_TRANSIT,RETURNED', label: 'Awaiting delivery' }, { value: 'PENDING', label: 'Packed' },
  { value: 'IN_TRANSIT', label: 'In transit' }, { value: 'RETURNED', label: 'Returned' }, { value: 'RECEIVED', label: 'Delivered' }, { value: 'ALL', label: 'All deliveries' }]
const done = (d: Delivery) => d.status === 'RECEIVED' || d.status === 'CANCELLED'

export function Deliveries() {
  const queryClient = useQueryClient()
  const [address, setAddress] = useSearchParams()
  const sale = address.get('sale')
  const [filters, setFilters] = useState({ date_from: '', date_to: '', location_id: '', status: 'PENDING,IN_TRANSIT,RETURNED' })
  const [ticked, setTicked] = useState<number[]>([])
  const [courier, setCourier] = useState('')
  const [signer, setSigner] = useState('')
  const wrongDates = Boolean(filters.date_from && filters.date_to && filters.date_from > filters.date_to)
  const query = new URLSearchParams(Object.entries({ ...filters, status: filters.status === 'ALL' ? '' : filters.status }).filter(([, v]) => v))
  const list = useQuery({
    queryKey: ['deliveries', query.toString()], enabled: !wrongDates, placeholderData: keepPreviousData,
    queryFn: () => contract<Reply>(`/pharmacy/api/deliveries?${query}`),
  })
  const rows = wrongDates ? [] : list.data?.deliveries ?? []
  const chosen = ticked.filter((id) => rows.some((d) => d.stock_document_id === id && !done(d)))
  const setFilter = (name: keyof typeof filters, value: string | null) => { setFilters({ ...filters, [name]: value ?? '' }); setTicked([]) }

  const bulk = useMutation({
    mutationFn: (job: { action: 'dispatch' | 'deliver' | 'comeback'; courier?: string; signed_by?: string }) =>
      contract<{ updated_count: number; failed?: { message: string; already?: boolean }[] }>('/pharmacy/api/deliveries/bulk', 'POST', { ...job, ids: chosen }),
    onSuccess: (d) => {
      // a row already where this press sends it is not a skip: nothing was refused
      const skipped = (d.failed ?? []).filter((f) => !f.already)
      const already = (d.failed ?? []).length - skipped.length
      const text = `Updated ${d.updated_count} deliver${d.updated_count === 1 ? 'y' : 'ies'}${already ? `, ${already} already done` : ''}` +
        (skipped.length ? `, ${skipped.length} skipped: ${skipped.map((f) => f.message).join(' ')}` : '.')
      if (skipped.length) notifyFailure(new Error(text))
      else notifySuccess(text)
      setTicked([])
      return queryClient.invalidateQueries({ queryKey: ['deliveries'] })
    },
    onError: notifyFailure,
  })

  const awaiting = rows.filter((d) => !done(d)).length
  const columns: Column<Delivery>[] = [
    {
      header: 'Delivery no.',
      cell: (d) => (
        <Group gap="sm" wrap="nowrap">
          <Checkbox aria-label={`Select ${d.stock_number}`} disabled={done(d)} checked={ticked.includes(d.stock_document_id)}
            onChange={(e) => setTicked(e.currentTarget.checked ? [...ticked, d.stock_document_id] : ticked.filter((id) => id !== d.stock_document_id))} />
          <Text size="sm" fw={500}>{d.stock_number}</Text>
        </Group>
      ),
    },
    { header: 'Bill no.', cell: (d) => d.sales_number || `Sale ${d.sales_document_id ?? ''}` },
    { header: 'Patient', cell: (d) => d.patient_name_snapshot || '--' },
    { header: 'Location', cell: (d) => d.location_name || '--' },
    { header: 'Amount', align: 'right', cell: (d) => money(d.net_amount_cents) },
    { header: 'Status', cell: (d) => <StatusBadge status={WORDS[d.status] ?? d.status} /> },
    // delivered by is the rider who carried it; who signed for it stands beside the name
    { header: 'Delivered by', cell: (d) => <div title={d.signed_by ? `Received by ${d.signed_by}` : undefined}>{d.reference_number || '--'}{d.signed_by && <Text size="xs" c="dimmed">received by {d.signed_by}</Text>}</div> },
    { header: 'Dispatched at', cell: (d) => dateTime(d.issued_at) },
    { header: 'Delivered at', cell: (d) => dateTime(d.received_at) },
  ]

  const header = (
    <>
      <PageHeader title="Deliveries">
        <Facts items={[{ label: 'Deliveries', value: rows.length }, { label: 'Awaiting delivery', value: awaiting }]} />
      </PageHeader>
      <FilterBar>
        <Group align="end">
          <TextInput aria-label="From date" type="date" value={filters.date_from} onChange={(e) => setFilter('date_from', e.currentTarget.value)} w={150} />
          <TextInput aria-label="To date" type="date" value={filters.date_to} onChange={(e) => setFilter('date_to', e.currentTarget.value)} w={150} />
          <Select aria-label="Location" placeholder="All locations" clearable searchable w={200} value={filters.location_id || null} onChange={(v) => setFilter('location_id', v)}
            data={(list.data?.locations ?? []).map((l) => ({ value: String(l.location_id), label: l.location_name }))} />
          <Select aria-label="Status" data={STATUS} value={filters.status} onChange={(v) => setFilter('status', v)} allowDeselect={false} w={190} />
          <Checkbox label="Select all" checked={rows.some((d) => !done(d)) && chosen.length === rows.filter((d) => !done(d)).length}
            onChange={(e) => setTicked(e.currentTarget.checked ? rows.filter((d) => !done(d)).map((d) => d.stock_document_id) : [])} mb={8} />
        </Group>
        {chosen.length > 0 && (
          <Group mt="sm" align="end">
            <Text size="sm" fw={600}>{chosen.length} selected</Text>
            <TextInput aria-label="Delivered by" placeholder="Delivered by" value={courier} onChange={(e) => setCourier(e.currentTarget.value)} w={180} />
            <Button loading={bulk.isPending} onClick={() => bulk.mutate({ action: 'dispatch', courier: courier.trim() })}>Dispatch</Button>
            <TextInput aria-label="Received by" placeholder="Received by" value={signer} onChange={(e) => setSigner(e.currentTarget.value)} w={180} />
            <Button variant="default" loading={bulk.isPending} onClick={() => bulk.mutate({ action: 'deliver', signed_by: signer.trim() })}>Mark delivered</Button>
            <Button variant="default" loading={bulk.isPending} onClick={() => bulk.mutate({ action: 'comeback' })}>Mark returned</Button>
          </Group>
        )}
      </FilterBar>
    </>
  )

  return (
    <Page header={header}>
      <DataTable columns={columns} rows={rows} rowKey={(d) => d.stock_document_id} loading={list.isFetching} view={query.toString()}
        empty={<EmptyState title={wrongDates ? 'From date is after To date.' : list.isError ? 'Could not load the deliveries.' : 'No deliveries found.'} hint={list.error?.message} />} />
      {sale && <BillDelivery saleId={sale} onClose={() => setAddress({}, { replace: true })} />}
    </Page>
  )
}

/** One bill's delivery: pack it, send it out, then mark it delivered or brought back. */
function BillDelivery({ saleId, onClose }: { saleId: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  // this bill's own delivery, asked for by the bill so it is never missed behind newer rows of the queue
  const found = useQuery({ queryKey: ['deliveries', 'sale', saleId], queryFn: () => contract<Reply>(`/pharmacy/api/deliveries?sales_document_id=${saleId}`) })
  const docs = (found.data?.deliveries ?? []).filter((d) => String(d.sales_document_id) === saleId)
  const active = docs.find((d) => !done(d))
  const last = docs[0]
  const [text, setText] = useState('')
  const step = useMutation({
    mutationFn: (job: { path: string; body: object }) => contract(job.path, 'POST', job.body),
    onSuccess: () => { setText(''); return queryClient.invalidateQueries({ queryKey: ['deliveries'] }) },
  })
  const shown = active ?? last
  const control = !active
    ? last?.status === 'RECEIVED' ? null
      : { label: 'Address', button: 'Pack for delivery', path: `/pharmacy/api/sales/${saleId}/delivery`, body: { address: text.trim() } }
    : ['PENDING', 'RETURNED'].includes(active.status) ? { label: 'Delivered by', button: 'Dispatch', path: `/pharmacy/api/deliveries/${active.stock_document_id}/dispatch`, body: { courier: text.trim() } }
      : active.status === 'IN_TRANSIT' ? { label: 'Received by', button: 'Mark delivered', path: `/pharmacy/api/deliveries/${active.stock_document_id}/deliver`, body: { signed_by: text.trim() } }
        : null

  return (
    <SidePanel title="Home delivery" subject={shown?.sales_number ?? `Sale ${saleId}`} size={560} onClose={onClose} loading={found.isPending} error={found.error}>
      <Stack gap="md">
        {shown
          ? <Facts items={[{ label: 'Delivery', value: shown.stock_number }, { label: 'Status', value: WORDS[shown.status] ?? shown.status },
            ...(shown.reference_number ? [{ label: 'Delivered by', value: shown.reference_number }] : []), ...(shown.notes ? [{ label: 'Notes', value: shown.notes }] : [])]} />
          : <Text size="sm">No delivery found for this sale.</Text>}
        {control && (
          <Group align="end">
            <TextInput label={control.label} value={text} onChange={(e) => setText(e.currentTarget.value)} style={{ flex: 1 }} />
            <Button loading={step.isPending} onClick={() => step.mutate({ path: control.path, body: control.body })}>{control.button}</Button>
            {active?.status === 'IN_TRANSIT' && (
              <Button variant="default" loading={step.isPending} onClick={() => step.mutate({ path: `/pharmacy/api/deliveries/${active.stock_document_id}/comeback`, body: {} })}>Mark returned</Button>
            )}
          </Group>
        )}
        {step.isError && <Alert color="red">{step.error.message}</Alert>}
      </Stack>
    </SidePanel>
  )
}
