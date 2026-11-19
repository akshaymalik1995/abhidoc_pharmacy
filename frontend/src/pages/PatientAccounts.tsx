/** A patient's money at the pharmacy: Patient Bills (the statement of every bill, grouped by visit, with write-offs sent
 * for approval) and Patient Advance (money kept on account, collected and refunded). DocAssist owns these ledgers. */
import { Alert, Anchor, Button, Checkbox, Group, NumberInput, Paper, Select, Stack, Table, Text, TextInput } from '@mantine/core'
import { IconDownload } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, contract } from '../api'
import {
  day, EmptyState, Facts, money, notifyFailure, notifySuccess, Page, PageHeader, SaveButton, SidePanel, SkeletonLines, StatusBadge,
} from '../ui'
import { PatientFinder, PatientLinks, usePatientAddress, type Lookup } from './PatientFinder'
import { words } from './PurchaseList'

interface Person { patient_id: number | null; mrn: string | null; name: string | null; phone: string | null }
interface Money { account_number: string; approved_by_name?: string | null; approved_at?: string | null; posted_at?: string | null; document_date?: string | null }
interface StatementBill { sales_document_id: number; sales_number: string; document_date: string | null; bill_type: string | null; cancelled_bill_type: string | null;
  status: string; cancelled: boolean; bill_amount_cents: number; paid_amount_cents: number; write_off_cents: number; sale_return_cents: number;
  excess_refund_cents: number; net_amount_cents: number; balance_due_cents: number; round_off_cents: number; billed_by_name: string | null;
  document_type: string | null; visit_number: string | null; receipts?: Money[]; refunds?: Money[]; returns?: { return_number: string }[]; writeoffs?: Money[] }
interface VisitGroup { label: string; visit_type: string | null; bill_count: number; bills: StatementBill[]
  totals: { sale_amount_cents?: number; paid_amount_cents?: number; write_off_cents?: number; balance_due_cents?: number } }
interface Statement { ok?: boolean; message?: string; patient: Person; matched_by?: string; current_visit: VisitGroup | null; previous_visits: VisitGroup[]
  totals: Record<string, number | null> }

const useStatement = (lookup: Lookup | null) => useQuery({
  queryKey: ['patient-bills', lookup], enabled: Boolean(lookup),
  queryFn: () => contract<Statement>(`/accounts/api/patient-bills?${new URLSearchParams(lookup!)}`),
})
const idOf = (p: Person | undefined): Lookup | null => (p?.patient_id ? { patient_id: String(p.patient_id) } : p?.mrn ? { mrn: p.mrn } : null) // a name alone never moves money

export function PatientBills() {
  const queryClient = useQueryClient()
  const [lookup, setLookup] = usePatientAddress()
  const [picked, setPicked] = useState<number[]>([])
  const [writing, setWriting] = useState<StatementBill[] | null>(null)
  const statement = useStatement(lookup)
  const s = statement.data
  const canForgive = (b: StatementBill) => b.balance_due_cents > 0 && (b.status === 'CONFIRMED' || b.status === 'PARTIAL')
  const allBills = s ? [...(s.current_visit?.bills ?? []), ...s.previous_visits.flatMap((g) => g.bills)] : []
  const t = s?.totals ?? {}
  const person = s?.ok === false ? null : s?.patient
  const asked = idOf(person ?? undefined)

  const groupRow = (g: VisitGroup, current: boolean) => (
    <Table.Tr bg="gray.0"><Table.Td colSpan={13}>
      <Group gap="lg"><Text size="sm" fw={700}>{current ? 'Current visit' : 'Previous visit'}</Text>
        <Facts items={[{ label: 'Visit', value: g.label }, { label: 'Bills', value: g.bill_count }, { label: 'Sale', value: money(g.totals.sale_amount_cents) },
          { label: 'Paid', value: money(g.totals.paid_amount_cents) }, { label: 'Write-off', value: money(g.totals.write_off_cents) }, { label: 'Balance due', value: money(g.totals.balance_due_cents) }]} /></Group>
    </Table.Td></Table.Tr>
  )
  const billRow = (b: StatementBill) => {
    // receipts, refunds, returns and write-offs of the bill, every number on pointing
    const numbers = [...(b.receipts ?? []), ...(b.refunds ?? [])].map((m) => m.account_number).concat((b.returns ?? []).map((r) => r.return_number))
    const forgiven = (b.writeoffs ?? []).map((w) => `Written off ${w.account_number}, approved by ${w.approved_by_name || '--'} on ${day((w.approved_at || w.posted_at || w.document_date)?.slice(0, 10))}`)
    const refs = numbers.length + forgiven.length
    return (
      <Table.Tr key={b.sales_document_id}>
        <Table.Td>{canForgive(b) && <Checkbox aria-label={`Select ${b.sales_number}`} checked={picked.includes(b.sales_document_id)}
          onChange={(e) => setPicked(e.currentTarget.checked ? [...picked, b.sales_document_id] : picked.filter((id) => id !== b.sales_document_id))} />}</Table.Td>
        <Table.Td title={[b.cancelled_bill_type && `Cancelled type ${b.cancelled_bill_type}`, `Billed by ${b.billed_by_name || '--'}`, `Module ${b.document_type ?? '--'}`].filter(Boolean).join('\n')}>
          <Anchor component={Link} to={`/sales/bills/${b.sales_document_id}`} size="sm">{b.sales_number}</Anchor>
          <Text size="xs" c="dimmed" title={[...numbers, ...forgiven].join('\n')}>{refs ? `${refs} ref${refs === 1 ? '' : 's'}` : ''}</Text>
        </Table.Td>
        <Table.Td>{day(b.document_date)}</Table.Td>
        <Table.Td>{b.bill_type || '--'}</Table.Td>
        <Table.Td><StatusBadge status={!b.cancelled && b.balance_due_cents > 0 ? 'Pending' : words(b.status)} /></Table.Td>
        <Table.Td ta="right" title={b.round_off_cents ? `Includes round-off ${money(b.round_off_cents)}` : undefined}>{money(b.bill_amount_cents)}</Table.Td>
        <Table.Td ta="right">{money(b.paid_amount_cents)}</Table.Td>
        <Table.Td ta="right">{b.write_off_cents ? money(b.write_off_cents) : '--'}</Table.Td>
        <Table.Td ta="right">{b.sale_return_cents ? money(b.sale_return_cents) : '--'}</Table.Td>
        <Table.Td ta="right">{b.excess_refund_cents ? money(b.excess_refund_cents) : '--'}</Table.Td>
        <Table.Td ta="right">{money(b.net_amount_cents)}</Table.Td>
        <Table.Td ta="right" fw={700}>{b.cancelled ? '--' : money(b.balance_due_cents)}</Table.Td>
        <Table.Td>{canForgive(b) && <Button size="xs" variant="default" onClick={() => setWriting([b])}>Write off</Button>}</Table.Td>
      </Table.Tr>
    )
  }
  return (
    <Page header={
      <PageHeader title="Patient bills" actions={<>
        <PatientLinks lookup={asked ?? (s?.ok === false ? null : lookup)} here="bills" />
        {lookup && s?.ok !== false && <Button variant="default" leftSection={<IconDownload size={16} />} component="a" href={`/accounts/api/patient-bills/export?${new URLSearchParams(lookup)}`}>Export CSV</Button>}
        {picked.length > 0 && <Button variant="danger" onClick={() => setWriting(allBills.filter((b) => picked.includes(b.sales_document_id)))}>Write off selected ({picked.length})</Button>}
      </>}>
        {person && <Facts items={[{ label: 'Patient', value: person.name || '--' }, { label: 'MRN', value: person.mrn || '--' }, { label: 'Phone', value: person.phone || '--' }]} />}
      </PageHeader>
    }>
      <Stack gap="md">
        <PatientFinder onPick={(l) => { setPicked([]); setLookup(l) }} />
        {statement.isFetching && !s && <SkeletonLines count={6} />}
        {statement.isError && <Alert color="red">{statement.error.message}</Alert>}
        {s?.ok === false && <Alert color="yellow">{s.message || 'No patients found.'}</Alert>}
        {s && s.ok !== false && (
          <>
            {(s.matched_by === 'NAME_PHONE' || s.matched_by === 'SEARCH') && <Alert color="yellow">These bills were matched by name and phone; check that they belong to this patient.</Alert>}
            <Paper withBorder p="md">
              <Stack gap={6}>
                <Facts items={[{ label: 'Sale amount', value: money(t.sale_amount_cents) }, { label: 'Sale return', value: money(t.sr_amount_cents) }, { label: 'Paid', value: money(t.paid_amount_cents) },
                  { label: 'Write-off', value: money(t.write_off_cents) }, { label: 'Excess / refund', value: money(t.excess_refund_cents) }, { label: 'Claim approved', value: '--' },
                  { label: 'Balance due', value: <Text span fw={700}>{money(t.balance_due_cents)}</Text> }]} />
                <Group gap="lg"><Facts items={[{ label: 'Credit bills', value: money(t.credit_bill_cents) }, { label: 'Credit balance due', value: money(t.credit_outstanding_cents) },
                  { label: 'Advance used', value: money(t.advance_used_cents) }, { label: 'Advance balance', value: money(t.advance_balance_cents) }]} />
</Group>
              </Stack>
            </Paper>
            <Paper withBorder style={{ overflowX: 'auto' }}>
              <Table highlightOnHover={false}>
                <Table.Thead bg="gray.0"><Table.Tr>
                  {['', 'Bill no.', 'Bill date', 'Bill type', 'Status', 'Bill amount', 'Paid', 'Write-off', 'Sale return', 'Excess / refund', 'Net amount', 'Balance due', ''].map((h, i) =>
                    <Table.Th key={i} ta={i >= 5 && i <= 11 ? 'right' : undefined}>{h}</Table.Th>)}
                </Table.Tr></Table.Thead>
                <Table.Tbody>
                  {s.current_visit && <Fragment>{groupRow(s.current_visit, true)}{s.current_visit.bills.map(billRow)}</Fragment>}
                  {s.previous_visits.map((g, i) => <Fragment key={i}>{groupRow(g, false)}{g.bills.map(billRow)}</Fragment>)}
                  {!allBills.length && <Table.Tr><Table.Td colSpan={13}><Text size="sm">No bills found.</Text></Table.Td></Table.Tr>}
                </Table.Tbody>
              </Table>
            </Paper>
          </>
        )}
        {!lookup && <EmptyState title="Find a patient by visit number, MRN, or name and phone." />}
      </Stack>
      {writing && <WriteOff bills={writing} onClose={() => setWriting(null)} onSent={() => { setPicked([]); return queryClient.invalidateQueries({ queryKey: ['patient-bills'] }) }} />}
    </Page>
  )
}

/** Writing a bill (or several) off: sent for approval; nothing changes until it is approved. */
function WriteOff({ bills, onClose, onSent }: { bills: StatementBill[]; onClose: () => void; onSent: () => Promise<unknown> }) {
  const one = bills.length === 1 ? bills[0] : null
  const [reason, setReason] = useState('')
  const [amount, setAmount] = useState(one ? (one.balance_due_cents / 100).toFixed(2) : '')
  const cents = Math.round(Number(amount || 0) * 100)
  const send = useMutation({
    mutationFn: async () => {
      // one at a time: a retry never sends again a bill already sent
      const sent: string[] = []
      for (const b of bills) {
        try { sent.push((await contract<{ account_number: string }>(`/pharmacy/api/sales/${b.sales_document_id}/write-off`, 'POST', one ? { reason: reason.trim(), amount_cents: cents } : { reason: reason.trim() })).account_number) }
        catch (e) { throw new Error(`${b.sales_number}: ${(e as Error).message}${sent.length ? ` (${sent.join(', ')} already sent)` : ''}`) }
      }
      return sent
    },
    onSuccess: async (sent) => { notifySuccess(one ? `Sent ${sent[0]} for approval.` : 'Selected bills sent for write-off approval.'); await onSent(); onClose() },
  })
  const left = one ? Math.max(one.balance_due_cents - cents, 0) : 0
  return (
    <SidePanel title={one ? 'Write off bill' : `Request write-off for ${bills.length} bills`} subject={one?.sales_number} size={520} onClose={onClose}>
      <Stack>
        {!one && <Facts items={[{ label: 'Bills', value: bills.map((b) => b.sales_number).join(', ') }]} />}
        <TextInput label="Write-off reason" required value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        {one && <NumberInput label="Amount (₹)" min={0} decimalScale={2} hideControls value={amount} onChange={(v) => setAmount(String(v))} />}
        {one && <Facts items={[{ label: 'Balance due', value: money(one.balance_due_cents) }, { label: 'After approval', value: money(left) }]} />}
        {send.isError && <Alert color="red">{send.error.message}</Alert>}
        <Group justify="flex-end">
          <SaveButton problem={reason.trim() ? null : 'Enter the write-off reason.'} variant="danger" loading={send.isPending} onClick={() => send.mutate()}>Send for approval</SaveButton></Group>
      </Stack>
    </SidePanel>
  )
}

interface Ledger { date: string; document_number: string; kind: string; bill_number?: string | null; payment_mode: string | null; advance_cents: number;
  spent_cents: number; return_cents: number; balance_cents: number; source_module: string | null; created_by_name: string | null }
const LEDGER_WORDS: Record<string, string> = { ADVANCE: 'Advance collected', REFUND_IN: 'Bill refund to advance', RETURN: 'Advance refunded' }
const ADVANCE_MODES = [['CASH', 'Cash'], ['UPI', 'UPI'], ['CREDIT_CARD', 'Credit card'], ['DEBIT_CARD', 'Debit card'], ['BANK_TRANSFER', 'Bank transfer'], ['CHEQUE', 'Cheque'], ['OTHER', 'Other']]

export function PatientAdvance() {
  const queryClient = useQueryClient()
  const [lookup, setLookup] = usePatientAddress()
  const [action, setAction] = useState<'topup' | 'return' | null>(null)
  const statement = useStatement(lookup)
  const person = statement.data?.ok === false ? null : statement.data?.patient
  const id = idOf(person ?? undefined)
  const advance = useQuery({ queryKey: ['patient-advance', id], enabled: Boolean(id),
    queryFn: () => contract<{ totals: { in_cents?: number; spent_cents?: number; returned_cents?: number; sitting_cents?: number }; ledger: Ledger[] }>(`/pharmacy/api/patients/advance?${new URLSearchParams(id!)}`) })
  const t = advance.data?.totals ?? {}
  const print = useMutation({
    mutationFn: () => contract<{ print_job?: { print_job_id: number; target_device?: { printer_name?: string } }; message?: string }>(`/pharmacy/api/patients/advance/print?${new URLSearchParams(id!)}`),
    onSuccess: (d) => (d.print_job ? notifySuccess(`Sent to ${d.print_job.target_device?.printer_name || 'the counter printer'}.`) : notifyFailure(new Error(d.message || 'Could not print. Try again.'))),
    onError: notifyFailure,
  })
  return (
    <Page header={
      <PageHeader title="Patient advance" actions={id && <>
        <PatientLinks lookup={id} here="advance" />
        <Button variant="default" loading={print.isPending} onClick={() => print.mutate()}>Print</Button>
        <Button variant="default" onClick={() => setAction('return')}>Refund advance</Button>
        <Button onClick={() => setAction('topup')}>Collect advance</Button>
      </>}>
        {person && <Facts items={[{ label: 'Patient', value: person.name || '--' }, { label: 'MRN', value: person.mrn || '--' }, { label: 'Phone', value: person.phone || '--' }]} />}
      </PageHeader>
    }>
      <Stack gap="md">
        <PatientFinder onPick={setLookup} />
        {statement.data?.ok === false && <Alert color="yellow">{statement.data.message || 'No patients found.'}</Alert>}
        {person && !id && <Alert color="yellow">This patient has no patient number or MRN: an advance cannot be kept.</Alert>}
        {id && (
          <>
            <Facts items={[{ label: 'Collected', value: money(t.in_cents) }, { label: 'Used', value: money(t.spent_cents) }, { label: 'Refunded', value: money(t.returned_cents) },
              { label: 'Advance balance', value: <Text span fw={700}>{money(t.sitting_cents)}</Text> }]} />
            <Paper withBorder style={{ overflowX: 'auto' }}>
              <Table highlightOnHover={false}>
                <Table.Thead bg="gray.0"><Table.Tr>{['Date', 'Document no.', 'Particulars', 'Payment mode', 'Advance', 'Used', 'Refunded', 'Balance', 'Collected at', 'Created by'].map((h, i) =>
                  <Table.Th key={h} ta={i >= 4 && i <= 7 ? 'right' : undefined}>{h}</Table.Th>)}</Table.Tr></Table.Thead>
                <Table.Tbody>
                  {(advance.data?.ledger ?? []).map((r, i) => (
                    <Table.Tr key={i}>
                      <Table.Td>{day(r.date?.slice(0, 10))}</Table.Td><Table.Td>{r.document_number}</Table.Td>
                      <Table.Td>{r.kind === 'USE' ? `Used on bill ${r.bill_number || '--'}` : LEDGER_WORDS[r.kind] ?? words(r.kind)}</Table.Td>
                      <Table.Td>{words(r.payment_mode) || '--'}</Table.Td>
                      <Table.Td ta="right">{r.advance_cents ? money(r.advance_cents) : '--'}</Table.Td><Table.Td ta="right">{r.spent_cents ? money(r.spent_cents) : '--'}</Table.Td>
                      <Table.Td ta="right">{r.return_cents ? money(r.return_cents) : '--'}</Table.Td><Table.Td ta="right" fw={700}>{money(r.balance_cents)}</Table.Td>
                      <Table.Td>{r.source_module === 'IPD' ? 'IP desk' : 'Pharmacy'}</Table.Td><Table.Td>{r.created_by_name || '--'}</Table.Td>
                    </Table.Tr>
                  ))}
                  {advance.data && !advance.data.ledger.length && <Table.Tr><Table.Td colSpan={10}><Text size="sm">No advance entries found.</Text></Table.Td></Table.Tr>}
                </Table.Tbody>
              </Table>
            </Paper>
          </>
        )}
        {!lookup && <EmptyState title="Find a patient by visit number or MRN." />}
      </Stack>
      {action && id && (
        <AdvanceForm action={action} who={id} sitting={t.sitting_cents ?? null} onClose={() => setAction(null)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['patient-advance'] })} />
      )}
    </Page>
  )
}

function AdvanceForm(props: { action: 'topup' | 'return'; who: Lookup; sitting: number | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState('CASH')
  const [notes, setNotes] = useState('')
  const label = props.action === 'topup' ? 'Collect advance' : 'Refund advance'
  const save = useMutation({
    mutationFn: () => api(`/pharmacy/api/patients/${props.action === 'topup' ? 'advance' : 'advance-return'}`, 'POST', {
      // the balance as this page shows it: a press after the balance has moved is refused
      ...props.who, amount_cents: Math.round(Number(amount || 0) * 100), payment_mode: mode, notes: notes.trim() || null,
      ...(props.sitting !== null ? { expected_sitting_cents: props.sitting } : {}) }),
    onSuccess: async () => { notifySuccess(props.action === 'topup' ? 'Advance collected.' : 'Advance refunded.'); await props.onSaved(); props.onClose() },
  })
  return (
    <SidePanel title={label} size={480} onClose={props.onClose}>
      <Stack>
        <NumberInput label="Amount (₹)" placeholder="0.00" min={0} decimalScale={2} hideControls value={amount} onChange={(v) => setAmount(String(v))} />
        <Select label="Payment mode" allowDeselect={false} value={mode} onChange={(v) => setMode(v ?? 'CASH')} data={ADVANCE_MODES.map(([value, l]) => ({ value, label: l }))} />
        <TextInput label="Remarks" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        {save.isError && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end"><Button loading={save.isPending} onClick={() => save.mutate()}>{label}</Button></Group>
      </Stack>
    </SidePanel>
  )
}
