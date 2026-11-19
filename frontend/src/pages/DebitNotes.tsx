/** Supplier Debit Notes: credit a supplier owes the hospital (from a return, or agreed outside one), raised by hand and set
 * against unpaid goods receipts. Money moves, so the notes are read and saved through DocAssist. */
import { Alert, Button, Group, NumberInput, Select, Stack, Table, Text, TextInput } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { contract } from '../api'
import {
  type Column, DataTable, day, EmptyState, Facts, money, notifySuccess, Page, PageHeader, Pager, SaveButton, SidePanel, StatusBadge,
} from '../ui'
import { words } from './PurchaseList'

const API = '/pharmacy/api/accounts'
interface Note { account_document_id: number; account_number: string; reference_number: string | null; created_at: string | null; supplier_id: number;
  supplier_name: string | null; net_amount_cents: number; unallocated_amount_cents: number; created_by_name: string | null; status: string }
interface Slip { purchase_document_id: number; grn_number: string | null; purchase_number: string | null; document_date: string | null; outstanding_amount_cents: number }
interface Owing { supplier_id: number; supplier_name: string; outstanding_cents: number; slips?: Slip[] }
const useOwing = () => useQuery({ queryKey: ['supplier-outstanding'], queryFn: () => contract<{ suppliers: Owing[] }>(`${API}/supplier-outstanding`) })

export function DebitNotes() {
  const queryClient = useQueryClient()
  // the Purchase Register opens this screen on one debit note
  const [address] = useSearchParams()
  const mark = address.get('mark')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const [adding, setAdding] = useState(false)
  const [applying, setApplying] = useState<Note | null>(null)
  const list = useQuery({ queryKey: ['debit-notes', page, size], placeholderData: keepPreviousData,
    queryFn: () => contract<{ debit_notes: Note[]; total: number; open_total_cents: number }>(`${API}/debit-notes?include_closed=1&limit=${size}&offset=${(page - 1) * size}`) })
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['debit-notes'] }), queryClient.invalidateQueries({ queryKey: ['supplier-outstanding'] })])
  const open = (r: Note) => Number(r.unallocated_amount_cents) > 0 && (r.status === 'POSTED' || r.status === 'PARTIALLY_ALLOCATED')
  const columns: Column<Note>[] = [
    { header: 'Debit note', cell: (r) => <Text size="sm" fw={r.account_number === mark ? 800 : 500} c={r.account_number === mark ? 'bottle.7' : undefined}>{r.account_number}</Text> },
    { header: 'Reference', cell: (r) => r.reference_number || '--' },
    { header: 'Date', cell: (r) => day(r.created_at?.slice(0, 10)) },
    { header: 'Supplier', cell: (r) => r.supplier_name || '--' },
    { header: 'Amount', align: 'right', cell: (r) => money(r.net_amount_cents) },
    { header: 'Balance', align: 'right', cell: (r) => money(r.unallocated_amount_cents) },
    { header: 'Raised by', cell: (r) => r.created_by_name || '--' },
    { header: 'Actions', align: 'right', cell: (r) => (open(r) ? <Button size="xs" variant="light" onClick={() => setApplying(r)}>Adjust</Button>
      : <StatusBadge status={['ALLOCATED', 'POSTED', 'PARTIALLY_ALLOCATED'].includes(r.status) ? 'Adjusted' : words(r.status)} />) },
  ]
  return (
    <Page header={
      <PageHeader title="Supplier debit notes" actions={<Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>New debit note</Button>}>
        <Facts items={[{ label: 'Debit notes', value: list.data?.total ?? '--' }, { label: 'Unadjusted', value: money(list.data?.open_total_cents) }]} />
      </PageHeader>
    }>
      <DataTable columns={columns} rows={list.data?.debit_notes ?? []} rowKey={(r) => r.account_document_id} loading={list.isFetching} view={`${page}-${size}`}
        empty={<EmptyState title={list.isError ? 'Could not load.' : 'No debit notes found.'} hint={list.error?.message} />}
        footer={<Pager page={page} pageSize={size} total={list.data?.total ?? 0} onChange={setPage} sizes={[10, 25, 50, 100]} onSize={(n) => { setSize(n); setPage(1) }} />} />
      {adding && <NewDebitNote onClose={() => setAdding(false)} onSaved={() => { setPage(1); return refresh() }} />}
      {applying && <ApplyDebitNote note={applying} onClose={() => setApplying(null)} onSaved={refresh} />}
    </Page>
  )
}

function NewDebitNote({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<unknown> }) {
  const owing = useOwing()
  const [supplierId, setSupplierId] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const supplier = owing.data?.suppliers.find((s) => String(s.supplier_id) === supplierId)
  const problem = !supplierId ? 'Select a supplier.' : !(Math.round(Number(amount || 0) * 100) > 0) ? 'Enter an amount greater than zero.' : null
  const save = useMutation({
    mutationFn: () => contract<{ account_number: string; net_amount_cents: number; reference_number?: string }>(`${API}/debit-notes`, 'POST', {
      supplier_id: Number(supplierId), amount_cents: Math.round(Number(amount) * 100), ...(receipt ? { purchase_document_id: Number(receipt) } : {}), ...(reason.trim() ? { notes: reason.trim() } : {}) }),
    onSuccess: async (d) => {
      notifySuccess(`Debit note ${d.account_number} saved for ${money(d.net_amount_cents)}${d.reference_number ? ` against ${d.reference_number}` : ''}.`)
      await onSaved()
      onClose()
    },
  })
  return (
    <SidePanel title="New debit note" size={560} onClose={onClose} loading={owing.isPending} error={owing.error}>
      <Stack>
        <Select label="Supplier" placeholder="Select supplier" searchable value={supplierId} onChange={(v) => { setSupplierId(v); setReceipt(null) }}
          data={(owing.data?.suppliers ?? []).map((s) => ({ value: String(s.supplier_id), label: `${s.supplier_name}, balance due ${money(s.outstanding_cents)}` }))} />
        <Select label="Goods receipt" placeholder="No goods receipt" clearable value={receipt} onChange={setReceipt} disabled={!supplier}
          data={(supplier?.slips ?? []).map((s) => ({ value: String(s.purchase_document_id), label: `${s.grn_number || s.purchase_number}, ${day(s.document_date?.slice(0, 10))}, balance due ${money(s.outstanding_amount_cents)}` }))} />
        <NumberInput label="Amount (₹)" min={0} decimalScale={2} hideControls value={amount} onChange={(v) => setAmount(String(v))} />
        <TextInput label="Reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        {save.isError && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end"><SaveButton problem={problem}  loading={save.isPending} onClick={() => save.mutate()}>Save</SaveButton></Group>
      </Stack>
    </SidePanel>
  )
}

/** Setting a debit note against the supplier's unpaid goods receipts, the oldest first. */
function ApplyDebitNote({ note, onClose, onSaved }: { note: Note; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const owing = useOwing()
  const [left, setLeft] = useState(Number(note.unallocated_amount_cents))
  const [typed, setTyped] = useState<Record<number, string>>({})
  const slips = owing.data?.suppliers.find((s) => s.supplier_id === note.supplier_id)?.slips ?? []
  // what is left of the note starts on the oldest receipts first
  let remaining = left
  const start = Object.fromEntries(slips.map((s) => { const take = Math.min(remaining, Number(s.outstanding_amount_cents)); remaining -= take; return [s.purchase_document_id, take] }))
  const amountOf = (s: Slip) => (typed[s.purchase_document_id] !== undefined ? Math.max(0, Math.round(Number(typed[s.purchase_document_id] || 0) * 100)) : start[s.purchase_document_id])
  const lines = slips.map((s) => ({ purchase_document_id: s.purchase_document_id, amount_cents: amountOf(s) })).filter((l) => l.amount_cents > 0)
  const save = useMutation({
    // the server is told what this page believes is left, so a repeat is refused
    mutationFn: () => contract<{ applied_cents: number; remaining_cents: number }>(`${API}/debit-notes/${note.account_document_id}/apply`, 'POST', { lines, expected_left_cents: left }),
    onSuccess: async (d) => {
      await onSaved()
      if (d.remaining_cents === 0) { notifySuccess(`Debit note ${note.account_number} adjusted in full.`); onClose(); return }
      notifySuccess(`Adjusted ${money(d.applied_cents)}. Balance on the debit note: ${money(d.remaining_cents)}.`)
      setLeft(d.remaining_cents)
      setTyped({})
    },
  })
  return (
    <SidePanel title="Adjust debit note" subject={note.account_number} size={760} onClose={onClose} loading={owing.isPending} error={owing.error}>
      <Stack>
        <Facts items={[{ label: 'Supplier', value: note.supplier_name || '--' }, { label: 'Amount', value: money(note.net_amount_cents) }, { label: 'Balance', value: money(left) }]} />
        <Table withTableBorder highlightOnHover={false}>
          <Table.Thead bg="gray.0"><Table.Tr><Table.Th>Goods receipt</Table.Th><Table.Th>Date</Table.Th><Table.Th ta="right">Balance due</Table.Th><Table.Th w={140} ta="right">Adjust (₹)</Table.Th><Table.Th ta="right">Balance after</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {!slips.length && <Table.Tr><Table.Td colSpan={5}><Text size="sm">No unpaid goods receipts found for this supplier.</Text></Table.Td></Table.Tr>}
            {slips.map((s) => (
              <Table.Tr key={s.purchase_document_id}>
                <Table.Td>{s.grn_number || s.purchase_number}</Table.Td>
                <Table.Td>{day(s.document_date?.slice(0, 10))}</Table.Td>
                <Table.Td ta="right">{money(s.outstanding_amount_cents)}</Table.Td>
                <Table.Td><NumberInput aria-label="Adjust" size="xs" min={0} decimalScale={2} hideControls value={typed[s.purchase_document_id] ?? (start[s.purchase_document_id] / 100).toFixed(2)}
                  onChange={(v) => setTyped({ ...typed, [s.purchase_document_id]: String(v) })} styles={{ input: { textAlign: 'right' } }} /></Table.Td>
                <Table.Td ta="right">{money(Number(s.outstanding_amount_cents) - Math.min(Number(s.outstanding_amount_cents), amountOf(s)))}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {save.isError && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end">
          <SaveButton problem={lines.length ? null : 'Enter an amount on at least one goods receipt.'} loading={save.isPending} onClick={() => save.mutate()}>Adjust</SaveButton></Group>
      </Stack>
    </SidePanel>
  )
}
