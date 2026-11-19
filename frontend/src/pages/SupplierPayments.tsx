/** Paying suppliers is maker-checker: Pay Supplier sends a request against goods receipts, Payment Approvals approves,
 * defers or rejects it (and the patients' debt write-offs). Money moves, so all of it goes through DocAssist. */
import { Alert, Badge, Button, Checkbox, Group, NumberInput, SegmentedControl, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { contract } from '../api'
import {
  type Column, DataTable, day, EmptyState, Facts, money, notifyFailure, notifySuccess, Page, PageHeader, type RowAction, RowActions, SaveButton, SidePanel, StatusBadge, useConfirm,
} from '../ui'
import { words } from './PurchaseList'

const API = '/pharmacy/api/accounts'
const MODES = [['BANK_TRANSFER', 'Bank transfer'], ['CASH', 'Cash'], ['CHEQUE', 'Cheque'], ['UPI', 'UPI']]
const modeWord = (mode: string | null) => (mode ? MODES.find(([c]) => c === mode)?.[1] ?? words(mode) : '--')

interface Receipt { purchase_document_id: number; grn_number: string | null; purchase_number: string | null; document_date: string | null; debit_cents: number;
  credit_cents: number; due_days: number | null; payable_cents: number; waiting_cents?: number; askable_cents?: number }
interface PayableSupplier { supplier_id: number; supplier_name: string; payable_cents: number; overdue_cents: number; waiting_cents?: number; documents: Receipt[] }
interface Request { account_document_id: number; account_number: string; document_date: string | null; payment_mode: string | null; supplier_id: number;
  supplier_name: string | null; prepared_by_name?: string | null; created_by?: number; created_by_name?: string | null; net_amount_cents: number; status: string;
  defer_reason?: string | null; stale?: boolean; allocations?: { purchase_document_id: number; reference_number: string | null; allocated_amount_cents: number }[] }
interface Workspace { suppliers: PayableSupplier[]; requests: Request[]; totals: { payable_cents?: number; supplier_count?: number; request_count?: number; overdue_cents?: number } }

/** How far a goods receipt is from its due date. */
function due(days: number | null) {
  if (days == null) return '--'
  if (days < 0) return <Badge color="red" miw="max-content">{Math.abs(days)} day{days === -1 ? '' : 's'} overdue</Badge>
  return days === 0 ? 'Due today' : `Due in ${days} day${days === 1 ? '' : 's'}`
}

export function PaySupplier() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const ws = useQuery({ queryKey: ['pay-supplier'], queryFn: () => contract<Workspace>(`${API}/supplier-payments/workspace`) })
  const [supplierId, setSupplierId] = useState<string | null>(null)
  const [mode, setMode] = useState('BANK_TRANSFER')
  const [notes, setNotes] = useState('')
  // per goods receipt: false when left out, else the amount typed (rupees)
  const [pay, setPay] = useState<Record<number, string | false>>({})
  const [deferring, setDeferring] = useState<{ id: number; action: 'DEFER' | 'PROCESS' } | null>(null)
  const [deferReason, setDeferReason] = useState('')
  const supplier = ws.data?.suppliers.find((s) => String(s.supplier_id) === supplierId) ?? null
  const ask = (d: Receipt) => (d.askable_cents === undefined ? Number(d.payable_cents || 0) : Number(d.askable_cents || 0)) // owed less what already waits
  const amountOf = (d: Receipt) => { const v = pay[d.purchase_document_id]; return v === false ? 0 : Math.round(Number(v ?? ask(d) / 100) * 100) }
  const picked = (supplier?.documents ?? []).filter((d) => ask(d) > 0 && pay[d.purchase_document_id] !== false && amountOf(d) > 0)
  const paying = picked.reduce((sum, d) => sum + amountOf(d), 0)
  const over = picked.find((d) => amountOf(d) > ask(d))
  const problem = !supplier ? 'Select a supplier.' : !picked.length ? 'Select a goods receipt and enter the amount to pay.'
    : over ? `${over.grn_number || over.purchase_number}: ${money(amountOf(over))} is more than the ${money(ask(over))} payable.` : null
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pay-supplier'] })

  const send = useMutation({
    mutationFn: () => contract<{ account_number: string }>(`${API}/supplier-payments`, 'POST', {
      supplier_id: supplierId, payment_mode: mode, notes: notes.trim() || null,
      lines: picked.map((d) => ({ purchase_document_id: d.purchase_document_id, amount_cents: amountOf(d) })) }),
    onSuccess: (d) => { notifySuccess(`Sent ${d.account_number} for approval.`); setPay({}); setNotes(''); return refresh() },
    onError: notifyFailure,
  })
  const state = useMutation({
    mutationFn: (job: { id: number; action: 'DEFER' | 'PROCESS' }) => contract<{ message?: string }>(`${API}/supplier-payments/${job.id}/defer`, 'POST', { action: job.action, reason: deferReason.trim() || null }),
    onSuccess: (d) => { notifySuccess(d.message || 'Saved.'); setDeferring(null); setDeferReason(''); return refresh() },
    onError: notifyFailure,
  })

  const t = ws.data?.totals ?? {}
  const requestColumns: Column<Request>[] = [
    { header: 'Request no.', cell: (r) => <Text size="sm" fw={500}>{r.account_number}</Text> },
    { header: 'Date', cell: (r) => day(r.document_date?.slice(0, 10)) },
    { header: 'Mode', cell: (r) => modeWord(r.payment_mode) },
    { header: 'Supplier', cell: (r) => r.supplier_name || '--' },
    { header: 'Created by', cell: (r) => r.prepared_by_name || '--' },
    { header: 'Goods receipts', cell: (r) => (r.allocations ?? []).map((a) => a.reference_number || `Goods receipt ${a.purchase_document_id}`).join(', ') },
    { header: 'Amount', align: 'right', cell: (r) => money(r.net_amount_cents) },
    { header: 'Status', cell: (r) => (
      <div title={[r.status === 'DEFERRED' && r.defer_reason && `Reason: ${r.defer_reason}`, r.stale && 'A goods receipt changed after this request was created.'].filter(Boolean).join(' ')}>
        <StatusBadge status={r.status === 'DEFERRED' ? 'Deferred' : 'Pending approval'} />
        {r.stale && <Text size="xs" c="red.8">A goods receipt changed after this request was created.</Text>}
      </div>
    ) },
    { header: 'Actions', align: 'right', cell: (r) => <RowActions name={r.account_number} actions={[r.status === 'DEFERRED'
      ? { label: 'Send for approval', kind: 'main', onClick: () => setDeferring({ id: r.account_document_id, action: 'PROCESS' }) }
      : { label: 'Defer', onClick: () => setDeferring({ id: r.account_document_id, action: 'DEFER' }) }]} /> },
  ]

  return (
    <Page header={
      <PageHeader title="Pay supplier" actions={<Button variant="default" onClick={() => navigate('/accounts/payment-approvals')}>Payment approvals</Button>}>
        <Facts items={[{ label: 'Payable', value: money(t.payable_cents) }, { label: 'Suppliers', value: t.supplier_count ?? '--' },
          { label: 'Requests pending', value: t.request_count ?? '--' }, { label: 'Overdue', value: money(t.overdue_cents) }]} />
      </PageHeader>
    }>
      <Stack gap="md">
        <Group align="end" wrap="wrap">
          <Select label="Supplier" placeholder="Select supplier" w={420} searchable value={supplierId} onChange={(v) => { setSupplierId(v); setPay({}) }}
            data={(ws.data?.suppliers ?? []).map((s) => ({ value: String(s.supplier_id), label: `${s.supplier_name}, balance due ${money(s.payable_cents)}${Number(s.overdue_cents) > 0 ? `, ${money(s.overdue_cents)} overdue` : ''}` }))} />
          <Stack gap={4}><Text size="sm" fw={500}>Payment mode</Text><SegmentedControl value={mode} onChange={setMode} data={MODES.map(([value, label]) => ({ value, label }))} /></Stack>
          <TextInput label="Remarks" placeholder="Enter remarks (optional)" style={{ flex: 1 }} miw={200} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        </Group>
        {supplier && (
          <Facts items={[{ label: 'Balance due', value: money(supplier.payable_cents) },
            ...(Number(supplier.overdue_cents) > 0 ? [{ label: 'Overdue', value: <Text span fw={600} c="red.8">{money(supplier.overdue_cents)}</Text> }] : []),
            { label: 'Goods receipts', value: supplier.documents.length },
            ...(Number(supplier.waiting_cents) > 0 ? [{ label: 'Pending approval', value: money(supplier.waiting_cents) }] : []),
            { label: 'Selected', value: picked.length }, { label: 'Paying', value: money(paying) }]} />
        )}
        <Table withTableBorder highlightOnHover={false}>
          <Table.Thead bg="gray.0">
            <Table.Tr>
              <Table.Th w={40}><Checkbox aria-label="Select all" disabled={!supplier} checked={Boolean(supplier) && supplier!.documents.filter((d) => ask(d) > 0).every((d) => pay[d.purchase_document_id] !== false)}
                onChange={(e) => { const on = e.currentTarget.checked; setPay(Object.fromEntries((supplier?.documents ?? []).map((d) => [d.purchase_document_id, on ? String(ask(d) / 100) : false]))) }} /></Table.Th>
              <Table.Th>Goods receipt</Table.Th><Table.Th>Date</Table.Th><Table.Th ta="right">Debit</Table.Th><Table.Th ta="right">Credit</Table.Th><Table.Th>Due date</Table.Th>
              <Table.Th ta="right">Payable</Table.Th><Table.Th w={150} ta="right">Pay now (₹)</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {!supplier && <Table.Tr><Table.Td colSpan={8}><Text size="sm">Select a supplier.</Text></Table.Td></Table.Tr>}
            {supplier && !supplier.documents.length && <Table.Tr><Table.Td colSpan={8}><Text size="sm">No goods receipts found.</Text></Table.Td></Table.Tr>}
            {supplier?.documents.map((d) => {
              const open = ask(d) > 0
              const on = open && pay[d.purchase_document_id] !== false
              return (
                <Table.Tr key={d.purchase_document_id}>
                  <Table.Td><Checkbox aria-label={`Pay ${d.grn_number}`} disabled={!open} checked={on} onChange={(e) => setPay({ ...pay, [d.purchase_document_id]: e.currentTarget.checked ? String(ask(d) / 100) : false })} /></Table.Td>
                  <Table.Td><Text size="sm">{d.grn_number || d.purchase_number || `Goods receipt ${d.purchase_document_id}`}</Text>{!open && <Text size="xs" c="dimmed">{Number(d.payable_cents) > 0 ? 'Pending approval' : 'Paid'}</Text>}</Table.Td>
                  <Table.Td>{day(d.document_date?.slice(0, 10))}</Table.Td>
                  <Table.Td ta="right">{money(d.debit_cents)}</Table.Td>
                  <Table.Td ta="right">{money(d.credit_cents)}</Table.Td>
                  <Table.Td>{due(d.due_days)}</Table.Td>
                  <Table.Td ta="right">{money(d.payable_cents)}{Number(d.waiting_cents) > 0 && <Text size="xs" c="dimmed">{money(d.waiting_cents)} pending approval</Text>}</Table.Td>
                  <Table.Td><NumberInput aria-label="Pay now" size="xs" min={0} decimalScale={2} hideControls disabled={!on} value={on ? (pay[d.purchase_document_id] as string | undefined) ?? String(ask(d) / 100) : '0'}
                    onChange={(v) => setPay({ ...pay, [d.purchase_document_id]: String(v) })} styles={{ input: { textAlign: 'right' } }} /></Table.Td>
                </Table.Tr>
              )
            })}
          </Table.Tbody>
        </Table>
        <Group justify="flex-end">
          <SaveButton problem={problem} loading={send.isPending} onClick={() => send.mutate()}>Send for approval</SaveButton>
        </Group>
        <Title order={2} fz={16}>Payment requests</Title>
        <div><DataTable columns={requestColumns} rows={ws.data?.requests ?? []} rowKey={(r) => r.account_document_id} loading={ws.isFetching}
          empty={<EmptyState title={ws.isError ? 'Could not load.' : 'No payment requests found.'} hint={ws.error?.message} />} /></div>
      </Stack>
      {deferring && (
        <SidePanel title={deferring.action === 'DEFER' ? 'Defer payment request' : 'Send for approval'} size={480} onClose={() => setDeferring(null)}>
          <Stack>
            {deferring.action === 'DEFER' && <TextInput label="Reason" placeholder="Written with Defer" value={deferReason} onChange={(e) => setDeferReason(e.currentTarget.value)} />}
            <Group justify="flex-end"><Button loading={state.isPending} onClick={() => state.mutate(deferring)}>{deferring.action === 'DEFER' ? 'Defer' : 'Send for approval'}</Button></Group>
          </Stack>
        </SidePanel>
      )}
    </Page>
  )
}

interface WriteOff { account_document_id: number; account_number: string; created_by: number; created_by_name: string | null; processed_at: string | null;
  patient_id: number | null; mrn: string | null; patient_name_snapshot: string | null; sales_document_id: number; sales_number: string | null;
  visit_number: string | null; reason: string | null; net_amount_cents: number }
type Decision = { kind: 'pay' | 'dwo'; action: 'approve' | 'defer' | 'reject'; id: number; number: string }
const DECISION = { approve: 'Approve', defer: 'Defer', reject: 'Reject' }

export function PaymentApprovals() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const pays = useQuery({ queryKey: ['approvals', 'pay'], queryFn: () => contract<{ requests: Request[] }>(`${API}/supplier-payments?status=PENDING_APPROVAL`) })
  const offs = useQuery({ queryKey: ['approvals', 'dwo'], queryFn: () => contract<{ writeoffs: WriteOff[] }>(`${API}/debt-writeoffs?status=PENDING_APPROVAL`) })
  const [deciding, setDeciding] = useState<Decision | null>(null)
  const confirm = useConfirm()
  const [note, setNote] = useState('')
  const decide = useMutation({
    mutationFn: (d: Decision) => (d.kind === 'dwo' ? contract<{ message?: string }>(`${API}/debt-writeoffs/${d.id}/${d.action}`, 'POST', {})
      : d.action === 'defer' ? contract<{ message?: string }>(`${API}/supplier-payments/${d.id}/defer`, 'POST', { action: 'DEFER', reason: note.trim() || null })
        // the checker's note travels with the approval or rejection
        : contract<{ message?: string }>(`${API}/supplier-payments/${d.id}/${d.action}`, 'POST', { notes: note.trim() || null })),
    onSuccess: (r, d) => { notifySuccess(r.message || `${d.number} ${{ approve: 'approved', defer: 'deferred', reject: 'rejected' }[d.action]}.`); setDeciding(null); setNote(''); return queryClient.invalidateQueries({ queryKey: ['approvals'] }) },
  })
  type Row = { key: string; number: string; kind: string; by: string; party: string; documents: string; reason: string; amount: number; actions: RowAction[] }
  const ask = (kind: 'pay' | 'dwo', action: Decision['action'], id: number, number: string): RowAction =>
    ({ label: DECISION[action], kind: action === 'reject' ? 'danger' : action === 'approve' ? 'main' : undefined,
      // a write-off takes no input: the shared "are you sure"; a supplier payment carries the checker's remarks
      onClick: () => (kind === 'dwo'
        ? confirm.ask({ action: DECISION[action], subject: number, danger: action === 'reject', run: () => decide.mutateAsync({ kind, action, id, number }) })
        : setDeciding({ kind, action, id, number })) })
  const rows: Row[] = [
    ...(offs.data?.writeoffs ?? []).map((w): Row => ({
      key: `w${w.account_document_id}`, number: w.account_number, kind: 'Write-off',
      by: [w.created_by_name || `User ${w.created_by}`, w.processed_at && day(w.processed_at.slice(0, 10))].filter(Boolean).join(', '),
      party: w.patient_name_snapshot || `Bill ${w.sales_document_id}`, documents: [w.sales_number, w.visit_number && `visit ${w.visit_number}`].filter(Boolean).join(', '),
      reason: w.reason || '--', amount: w.net_amount_cents,
      actions: [ask('dwo', 'approve', w.account_document_id, w.account_number),
        // the bill a write-off is for is read on the Patient Bills screen
        { label: 'Bill', onClick: () => navigate(`/accounts/patient-bills?${new URLSearchParams(w.patient_id ? { patient_id: String(w.patient_id) } : w.mrn ? { mrn: w.mrn } : { sales_document_id: String(w.sales_document_id) })}`) },
        ask('dwo', 'reject', w.account_document_id, w.account_number)],
    })),
    ...(pays.data?.requests ?? []).map((r): Row => ({
      key: `p${r.account_document_id}`, number: r.account_number, kind: 'Supplier payment',
      by: [r.created_by_name || `User ${r.created_by}`, r.document_date && day(r.document_date.slice(0, 10))].filter(Boolean).join(', '),
      party: r.supplier_name || `Supplier ${r.supplier_id}`, documents: (r.allocations ?? []).map((a) => `${a.reference_number || '?'} ${money(a.allocated_amount_cents)}`).join(', '),
      reason: modeWord(r.payment_mode), amount: r.net_amount_cents,
      actions: [ask('pay', 'approve', r.account_document_id, r.account_number), ask('pay', 'defer', r.account_document_id, r.account_number), ask('pay', 'reject', r.account_document_id, r.account_number)],
    })),
  ]
  const columns: Column<Row>[] = [
    { header: 'Request no.', cell: (r) => <Text size="sm" fw={500}>{r.number}</Text> },
    { header: 'Kind', cell: (r) => r.kind },
    { header: 'Requested by', cell: (r) => r.by },
    { header: 'Party', cell: (r) => r.party },
    { header: 'Documents', cell: (r) => <div title={r.documents}>{r.documents || '--'}</div> },
    { header: 'Reason / mode', cell: (r) => <div title={r.reason}>{r.reason}</div> },
    { header: 'Amount', align: 'right', cell: (r) => money(r.amount) },
    { header: 'Actions', align: 'right', cell: (r) => <RowActions name={r.number} actions={r.actions} /> },
  ]
  const word = deciding ? DECISION[deciding.action] : ''
  return (
    <Page header={<PageHeader title="Payment approvals"><Facts items={[{ label: 'Pending', value: rows.length }]} /></PageHeader>}>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.key} loading={pays.isFetching || offs.isFetching}
        empty={<EmptyState title={pays.isError || offs.isError ? 'Could not load.' : 'No pending approvals found.'} />} />
      {deciding && (
        <SidePanel title={`${word} supplier payment`} subject={deciding.number} size={480} onClose={() => setDeciding(null)}>
          <Stack>
            <TextInput label="Remarks" placeholder="Enter remarks" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
            {decide.isError && <Alert color="red">{decide.error.message}</Alert>}
            <Group justify="flex-end"><Button variant={deciding.action === 'reject' ? 'danger' : 'filled'} loading={decide.isPending} onClick={() => decide.mutate(deciding)}>{word}</Button></Group>
          </Stack>
        </SidePanel>
      )}
      {confirm.dialog}
    </Page>
  )
}
