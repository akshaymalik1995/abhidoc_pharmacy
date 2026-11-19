/** New Product Requests: products a doctor or the counter asked for that the pharmacy does not stock yet.
 * The list and every action go through DocAssist, which matches a request to a product and puts it on a wanted list. */
import { Alert, Autocomplete, Button, Group, NumberInput, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconPlus, IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../api'
import {
  type Column, DataTable, day, EmptyState, Facts, FilterBar, notifySuccess, Page, PageHeader, Pager, plain, type RowAction, RowActions, SaveButton, SidePanel, StatusBadge, useConfirm,
} from '../ui'

interface Request {
  new_product_request_id: number
  created_at: string
  medication_name: string | null
  new_medication_type: string | null
  matched_product_name: string | null
  referral_doctor_name: string | null
  requested_quantity: string
  created_by_name: string | null
  status: string
  wanted_document_id: number | null
}
interface Options {
  medication_types: string[]
  locations: { location_id: number; location_name: string }[]
  users: { user_id: string; user_name: string }[]
  referral_doctors: { doctor_id: number; doctor_name: string }[]
}
interface Reply { requests: Request[]; total: number; counts: Record<string, number>; options: Options }

const URL = '/pharmacy/api/wanted/new-products'
const STATUS: Record<string, string> = {
  REQUESTED: 'Requested', MAPPED: 'Matched', WANTED: 'In wanted list', PO_GENERATED: 'Ordered', REJECTED: 'Rejected', CANCELLED: 'Cancelled',
}
const today = () => new Date().toLocaleDateString('en-CA')
const START: Record<string, string> = { date_from: today(), date_to: today() }

export function NewProductRequests() {
  const queryClient = useQueryClient()
  const [filters, setFilters] = useState(START)
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 300)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [adding, setAdding] = useState(false)
  const confirm = useConfirm()

  const query = new URLSearchParams({ ...filters, q, limit: String(pageSize), offset: String((page - 1) * pageSize) })
  const list = useQuery({
    queryKey: ['new-product-requests', query.toString()],
    queryFn: () => api<Reply>(`${URL}?${query}`),
    placeholderData: keepPreviousData,
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['new-product-requests'] })
  const options = list.data?.options
  const counts = list.data?.counts ?? {}

  function setFilter(name: string, value: string | null) {
    const next = { ...filters }
    if (value) next[name] = value
    else delete next[name]
    setFilters(next)
    setPage(1)
  }

  const change = useMutation({
    mutationFn: (step: { row: Request; action: 'reject' | 'cancel' | 'reopen' }) =>
      api(`/pharmacy/api/new-product-requests/${step.row.new_product_request_id}/status`, 'POST', { action: step.action }),
    onSuccess: (_, step) => { notifySuccess(`Request ${{ reject: 'rejected', cancel: 'cancelled', reopen: 'reopened' }[step.action]}.`); return refresh() },
  })
  const convert = useMutation({
    mutationFn: (row: Request) =>
      api<{ created_product?: boolean; wanted_number?: string }>(`/pharmacy/api/new-product-requests/${row.new_product_request_id}/convert`, 'POST', {}),
    onSuccess: (reply) => { notifySuccess(`${reply.created_product ? 'Product created and added' : 'Added'} to wanted list ${reply.wanted_number ?? ''}.`); return refresh() },
  })

  function actions(row: Request): RowAction[] {
    const open = ['REQUESTED', 'MAPPED'].includes(row.status)
    return [
      open && { label: 'Create product', kind: 'main', onClick: () => confirm.ask({ action: 'Create product', subject: `for ${row.medication_name}`,
        note: 'It is added to the wanted list.', run: () => convert.mutateAsync(row) }) },
      ['WANTED', 'PO_GENERATED'].includes(row.status) && row.wanted_document_id && { label: 'View', to: `/purchase/wanted-list?list=${row.wanted_document_id}` },
      ['REJECTED', 'CANCELLED'].includes(row.status) && { label: 'Reopen', kind: 'main', onClick: () => confirm.ask({ action: 'Reopen', subject: `the request for ${row.medication_name}`, run: () => change.mutateAsync({ row, action: 'reopen' }) }) },
      open && { label: 'Reject', kind: 'danger', onClick: () => confirm.ask({ action: 'Reject', subject: `the request for ${row.medication_name}`, danger: true, run: () => change.mutateAsync({ row, action: 'reject' }) }) },
      (open || row.status === 'WANTED') && { label: 'Cancel', kind: 'danger', onClick: () => confirm.ask({ action: 'Cancel', subject: `the request for ${row.medication_name}`, danger: true, run: () => change.mutateAsync({ row, action: 'cancel' }) }) },
    ].filter(Boolean) as RowAction[]
  }

  const columns: Column<Request>[] = [
    { header: 'Product name', cell: (row) => <><Text size="sm" fw={500}>{row.medication_name}</Text><Text size="xs" c="dimmed">{row.new_medication_type}</Text></> },
    { header: 'Date', cell: (row) => day(row.created_at.slice(0, 10)) },
    { header: 'Matched product', cell: (row) => row.matched_product_name || '--' },
    { header: 'Referral doctor', cell: (row) => row.referral_doctor_name || '--' },
    { header: 'Qty', align: 'right', cell: (row) => plain(row.requested_quantity) },
    { header: 'Created by', cell: (row) => row.created_by_name || '--' },
    { header: 'Status', cell: (row) => <StatusBadge status={STATUS[row.status] ?? row.status} /> },
    { header: 'Actions', align: 'right', cell: (row) => <RowActions name={row.medication_name ?? undefined} actions={actions(row)} /> },
  ]

  const header = (
    <>
      <PageHeader
        title="New product requests"
        actions={<Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>New product request</Button>}
      >
        <Facts items={Object.entries(STATUS).map(([code, label]) => ({ label, value: counts[code] ?? 0 }))} />
      </PageHeader>
      <FilterBar>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4, lg: 7 }}>
          <TextInput label="Search" placeholder="Product name" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => { setSearch(e.currentTarget.value); setPage(1) }} />
          <TextInput label="From date" type="date" value={filters.date_from ?? ''} onChange={(e) => setFilter('date_from', e.currentTarget.value)} />
          <TextInput label="To date" type="date" value={filters.date_to ?? ''} onChange={(e) => setFilter('date_to', e.currentTarget.value)} />
          <Select label="Status" placeholder="All statuses" data={Object.entries(STATUS).map(([value, label]) => ({ value, label }))} value={filters.status ?? null} onChange={(v) => setFilter('status', v)} clearable />
          <Select label="Product type" placeholder="All types" data={options?.medication_types ?? []} value={filters.medication_type ?? null} onChange={(v) => setFilter('medication_type', v)} clearable searchable />
          <Select label="Location" placeholder="All locations" data={(options?.locations ?? []).map((l) => ({ value: String(l.location_id), label: l.location_name }))} value={filters.location_id ?? null} onChange={(v) => setFilter('location_id', v)} clearable searchable />
          <Select label="User" placeholder="All users" data={(options?.users ?? []).map((u) => ({ value: u.user_id, label: u.user_name }))} value={filters.created_by ?? null} onChange={(v) => setFilter('created_by', v)} clearable searchable />
        </SimpleGrid>
        <Group justify="flex-end" mt="sm">
          <Button variant="default" size="compact-sm" onClick={() => { setFilters(START); setSearch(''); setPage(1) }}>Reset</Button>
        </Group>
      </FilterBar>
    </>
  )

  return (
    <Page header={header}>
      <DataTable
        columns={columns}
        rows={list.data?.requests ?? []}
        rowKey={(row) => row.new_product_request_id}
        loading={list.isFetching}
        view={query.toString()}
        empty={list.isError
          ? <EmptyState title="Could not load the requests." hint={list.error.message} />
          : <EmptyState title="No requests found." hint="The list starts on today; widen the dates to see earlier requests." />}
        footer={<Pager page={page} pageSize={pageSize} total={list.data?.total ?? 0} onChange={setPage} sizes={[10, 25, 50, 100]} onSize={(size) => { setPageSize(size); setPage(1) }} />}
      />
      {adding && options && <NewRequest options={options} onClose={() => setAdding(false)} onSaved={refresh} />}
      {confirm.dialog}
    </Page>
  )
}

function NewRequest(props: { options: Options; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [form, setForm] = useState({ medication_name: '', new_medication_type: '', referral_doctor_id: '', requested_quantity: '1', location_id: '', notes: '' })
  const set = (name: keyof typeof form, value: string) => setForm({ ...form, [name]: value })
  const problem = !form.medication_name.trim() ? 'Enter the product name.' : !(Number(form.requested_quantity) > 0) ? 'Enter a quantity above 0.' : null
  const save = useMutation({
    mutationFn: () => api<{ request?: { matched_item_id?: number; matched_product_name?: string } }>('/pharmacy/api/new-product-requests', 'POST', {
      ...form, medication_name: form.medication_name.trim(), new_medication_type: form.new_medication_type.trim(),
      referral_doctor_id: form.referral_doctor_id || null, location_id: form.location_id || null, notes: form.notes.trim(),
    }),
    onSuccess: async (reply) => {
      await props.onSaved()
      notifySuccess(reply.request?.matched_item_id ? `Saved. Matched to ${reply.request.matched_product_name ?? 'an existing product'}.` : 'Request saved.')
      props.onClose()
    },
  })
  return (
    <SidePanel title="New product request" onClose={props.onClose}>
      <Stack gap="sm">
        <TextInput label="Product name" required maxLength={255} data-autofocus value={form.medication_name} onChange={(e) => set('medication_name', e.currentTarget.value)} />
        <Autocomplete label="Product type" data={props.options.medication_types} value={form.new_medication_type} onChange={(value) => set('new_medication_type', value)} />
        <Select label="Referral doctor" placeholder="None" clearable searchable
          data={props.options.referral_doctors.map((d) => ({ value: String(d.doctor_id), label: d.doctor_name }))}
          value={form.referral_doctor_id || null} onChange={(value) => set('referral_doctor_id', value ?? '')} />
        <NumberInput label="Qty" required min={0.001} decimalScale={3} allowNegative={false} hideControls value={form.requested_quantity} onChange={(value) => set('requested_quantity', String(value))} />
        <Select label="Location" placeholder="Current location" clearable searchable
          data={props.options.locations.map((l) => ({ value: String(l.location_id), label: l.location_name }))}
          value={form.location_id || null} onChange={(value) => set('location_id', value ?? '')} />
        <TextInput label="Notes" maxLength={500} value={form.notes} onChange={(e) => set('notes', e.currentTarget.value)} />
        {save.isError && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end" mt="sm">
          <SaveButton problem={problem}  loading={save.isPending} onClick={() => save.mutate()}>Save request</SaveButton>
        </Group>
      </Stack>
    </SidePanel>
  )
}
