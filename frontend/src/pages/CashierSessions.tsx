/** Cashier Sessions: each cashier's shift at the counter, from opening float to the counted close. Every read and
 * save here is DocAssist's cashier ledger, used through it. */
import { Alert, Button, Group, NumberInput, Paper, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core'
import { IconArrowLeft, IconDownload, IconPlus, IconPrinter } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { contract } from '../api'
import {
  type Column, DataTable, EmptyState, Facts, FilterBar, money, notifyFailure, notifySuccess, Page, PageHeader, PageSkeleton, SaveButton, SidePanel, StatusBadge, useConfirm,
} from '../ui'
import { words } from './PurchaseList'
import { dateTime } from './SaleShared'

const API = '/pharmacy/api/cashier-sessions'
const TYPE_WORDS: Record<string, string> = { SALE: 'Sale', RECEIPT: 'Receipt', REFUND: 'Refund', ADVANCE: 'Advance' }
const typeWord = (t: string) => TYPE_WORDS[t] ?? words(t)
const paise = (rupees: string | number) => Math.round(Number(rupees || 0) * 100)

interface SessionRow { cashier_session_id: number; session_number: string; cashier_user_id: number; cashier_name: string | null; opened_at: string; closed_at: string | null;
  location_name: string | null; transaction_count: number; tender_net_cents: number; cash_transfer_out_cents: number; unconfirmed_transfers: number;
  variance_cash_cents: number | null; status: string }

export function CashierSessions() {
  const navigate = useNavigate()
  // Cash Counter and the payment panel open this screen with the new-session form: ?new=1
  const [address, setAddress] = useSearchParams()
  const [filters, setFilters] = useState<Record<string, string>>({ date_from: '', date_to: '', cashier_user_id: '', status: '', transaction_type: '' })
  const [opening, setOpening] = useState(address.get('new') === '1')
  const chosen = new URLSearchParams(Object.entries(filters).filter(([, v]) => v))
  const list = useQuery({ queryKey: ['cashier-sessions', chosen.toString()], placeholderData: keepPreviousData,
    queryFn: () => contract<{ rows: SessionRow[]; transaction_types?: string[]; totals?: { sessions?: number; open_sessions?: number; unconfirmed_transfers?: number } }>(`${API}?${chosen}`) })
  const rows = list.data?.rows ?? []
  const cashiers = [...new Map(rows.map((r) => [String(r.cashier_user_id), r.cashier_name || `User ${r.cashier_user_id}`])).entries()].map(([value, label]) => ({ value, label }))
  const set = (name: string, value: string | null) => setFilters({ ...filters, [name]: value ?? '' })
  const t = list.data?.totals ?? {}
  const columns: Column<SessionRow>[] = [
    // the location sits under the session number, so the row fits without scrolling sideways
    { header: 'Session no.', cell: (r) => <><Text size="sm" fw={500}>{r.session_number}</Text><Text size="xs" c="dimmed">{r.location_name || '--'}</Text></> },
    { header: 'Cashier', cell: (r) => r.cashier_name || '--' },
    { header: 'Opened', cell: (r) => dateTime(r.opened_at) },
    { header: 'Closed', cell: (r) => (r.closed_at ? dateTime(r.closed_at) : '--') },
    { header: 'Transactions', align: 'right', cell: (r) => r.transaction_count },
    { header: 'Net collected', align: 'right', cell: (r) => money(r.tender_net_cents) },
    { header: 'Transfers out', align: 'right', cell: (r) => money(r.cash_transfer_out_cents) },
    { header: 'Unconfirmed', align: 'right', cell: (r) => (Number(r.unconfirmed_transfers) ? <Text size="sm" fw={700}>{r.unconfirmed_transfers}</Text> : '0') },
    // a shortfall or an excess is the one figure to look at; zero stays quiet
    { header: 'Variance', align: 'right', cell: (r) => (r.variance_cash_cents == null ? '--' : <Text size="sm" fw={Number(r.variance_cash_cents) ? 700 : 400} c={Number(r.variance_cash_cents) ? 'red.8' : undefined}>{money(r.variance_cash_cents)}</Text>) },
    { header: 'Status', cell: (r) => <StatusBadge status={words(r.status)} /> },
    { header: 'Actions', align: 'right', cell: (r) => <Button size="xs" variant="default" onClick={() => navigate(`/accounts/cashier-sessions/${r.cashier_session_id}`)}>View</Button> },
  ]
  const header = (
    <>
      <PageHeader title="Cashier sessions" actions={<Button leftSection={<IconPlus size={16} />} onClick={() => setOpening(true)}>Open cashier session</Button>}>
        <Facts items={[{ label: 'Sessions', value: t.sessions ?? '--' }, { label: 'Open', value: t.open_sessions ?? '--' }, { label: 'Unconfirmed transfers', value: t.unconfirmed_transfers ?? '--' }]} />
      </PageHeader>
      <FilterBar>
        <Group align="end" wrap="wrap">
          <TextInput aria-label="From date" type="date" w={150} value={filters.date_from} onChange={(e) => set('date_from', e.currentTarget.value)} />
          <TextInput aria-label="To date" type="date" w={150} value={filters.date_to} onChange={(e) => set('date_to', e.currentTarget.value)} />
          <Select aria-label="Cashier" placeholder="All cashiers" w={190} clearable data={cashiers} value={filters.cashier_user_id || null} onChange={(v) => set('cashier_user_id', v)} />
          <Select aria-label="Status" placeholder="All statuses" w={160} clearable value={filters.status || null} onChange={(v) => set('status', v)}
            data={['OPEN', 'CLOSING', 'CLOSED', 'CANCELLED'].map((s) => ({ value: s, label: words(s) }))} />
          <Select aria-label="Transaction type" placeholder="All types" w={160} clearable value={filters.transaction_type || null} onChange={(v) => set('transaction_type', v)}
            data={(list.data?.transaction_types ?? []).map((ty) => ({ value: ty, label: typeWord(ty) }))} />
        </Group>
      </FilterBar>
    </>
  )
  return (
    <Page header={header}>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.cashier_session_id} loading={list.isFetching} view={chosen.toString()}
        empty={<EmptyState title={list.isError ? list.error.message : 'No cashier sessions found.'} />} />
      {opening && <OpenSession onClose={() => { setOpening(false); if (address.has('new')) setAddress({}, { replace: true }) }} onOpened={(id) => navigate(`/accounts/cashier-sessions/${id}`)} />}
    </Page>
  )
}

function OpenSession({ onClose, onOpened }: { onClose: () => void; onOpened: (id: number) => void }) {
  const where = useQuery({ queryKey: ['cashier-session'], queryFn: () => contract<{ location_name?: string }>(`${API}/current`) })
  const [float, setFloat] = useState('')
  const [notes, setNotes] = useState('')
  const open = useMutation({
    mutationFn: () => contract<{ cashier_session: { cashier_session_id: number; session_number: string; opening_float_cents: number }; already_open?: boolean }>(
      `${API}/open`, 'POST', { opening_float_cents: paise(float), notes: notes.trim() || null }),
    onSuccess: (d) => {
      const s = d.cashier_session
      notifySuccess(d.already_open ? `Your cashier session ${s.session_number} is already open.` : `Cashier session ${s.session_number} opened with a float of ${money(s.opening_float_cents)}.`)
      onOpened(s.cashier_session_id)
    },
  })
  return (
    <SidePanel title="Open cashier session" size={480} onClose={onClose}>
      <Stack>
        {where.data?.location_name && <Facts items={[{ label: 'Location', value: where.data.location_name }]} />}
        <NumberInput label="Opening float (₹)" placeholder="0.00" min={0} decimalScale={2} hideControls value={float} onChange={(v) => setFloat(String(v))} />
        <TextInput label="Remarks" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        {open.isError && <Alert color="red">{open.error.message}</Alert>}
        <Group justify="flex-end"><Button loading={open.isPending} onClick={() => open.mutate()}>Open session</Button></Group>
      </Stack>
    </SidePanel>
  )
}

interface Closing { opening_balance_cents?: number; cash_cents?: number; card_cents?: number; upi_cents?: number; cheque_cents?: number; other_cents?: number;
  total_cents?: number; due_cents?: number; expected_cash_cents?: number; counted_cash_cents?: number | null; variance_cash_cents?: number | null }
interface Transfer { cashier_cash_transfer_id: number; created_at: string; transfer_reference: string | null; notes: string | null; created_by_name: string | null;
  amount_cents: number; status: string; confirmed_by_name: string | null; confirmed_at: string | null }
interface Adjustments { variance_at_close_cents: number; adjusted_cents: number; variance_now_cents: number; adjustments: { created_at: string; reason: string | null; amount_cents: number; created_by_name: string | null }[] }
interface SessionReply {
  cashier_session: { session_number: string; cashier_name: string | null; cashier_user_type: string | null; status: string; opened_at: string; closed_at: string | null;
    opening_float_cents: number; counted_cash_cents: number | null; expected_cash_cents: number | null; variance_cash_cents: number | null }
  closing: Closing
  cash_transfers: { transfers: Transfer[]; unconfirmed_count: number; transfer_out_cents: number }
  adjustments: Adjustments | null
}
interface Txn { created_at: string; document_number: string | null; transaction_type: string; payment_mode: string | null; transaction_reference: string | null;
  description: string | null; transaction_value_cents: number | null; tender_cents: number; user_name: string | null }
const DENOMS = [2000, 500, 200, 100, 50, 20, 10]
const signed = (cents: number) => `${cents > 0 ? '+' : ''}${money(cents)}`

export function CashierSession() {
  const { id } = useParams()
  const queryClient = useQueryClient()
  const session = useQuery({ queryKey: ['cashier-session', id], queryFn: () => contract<SessionReply>(`${API}/${id}`) })
  const [type, setType] = useState('')
  const txns = useQuery({ queryKey: ['cashier-session-txns', id, type], placeholderData: keepPreviousData,
    queryFn: () => contract<{ rows: Txn[]; transaction_types?: string[] }>(`${API}/${id}/transactions${type ? `?transaction_type=${type}` : ''}`) })
  const [panel, setPanel] = useState<'transfer' | 'close' | 'adjust' | null>(null)
  const confirm = useConfirm()
  const [reason, setReason] = useState('')
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['cashier-session', id] }), queryClient.invalidateQueries({ queryKey: ['cashier-session-txns', id] }),
    queryClient.invalidateQueries({ queryKey: ['cashier-sessions'] })])
  const act = useMutation({
    mutationFn: (job: { path: string; body: object; done: string }) => contract(`${API}/${id}/${job.path}`, 'POST', job.body),
    onSuccess: (_, job) => { notifySuccess(job.done); setReason(''); return refresh() },
    onError: notifyFailure,
  })
  // a transfer's Confirm or Cancel, asked first; its failure is shown in the dialog
  const transfer = useMutation({
    mutationFn: (job: { path: string; done: string }) => contract(`${API}/${id}/${job.path}`, 'POST', {}),
    onSuccess: (_, job) => { notifySuccess(job.done); return refresh() },
  })
  if (session.isPending) return <PageSkeleton />
  if (!session.data) return <Page header={<PageHeader title="Cashier session" />}><EmptyState title="Could not open this session." hint={session.error?.message} /></Page>
  const { cashier_session: s, closing, cash_transfers: transfers, adjustments } = session.data
  const locked = ['CLOSING', 'CLOSED', 'CANCELLED'].includes(s.status)
  const counted = closing.counted_cash_cents
  const variance = closing.variance_cash_cents ?? (counted != null ? Number(counted) - Number(closing.expected_cash_cents || 0) : null)

  const totals: [string, number | null | undefined, boolean?][] = [
    ['Opening balance', closing.opening_balance_cents], ['Cash', closing.cash_cents], ['Card', closing.card_cents], ['UPI', closing.upi_cents],
    ['Cheque / DD / bank transfer', closing.cheque_cents], ['Other modes', closing.other_cents], ['Total collected', closing.total_cents, true], ['Balance due', closing.due_cents],
    ['Expected cash', closing.expected_cash_cents, true], ['Counted cash', counted],
  ]
  const transferColumns: Column<Transfer>[] = [
    { header: 'Date', cell: (r) => dateTime(r.created_at) },
    { header: 'Transfer', cell: (r) => <div title={`${r.notes ?? ''}, by ${r.created_by_name ?? '--'}`}><Text size="sm">{r.transfer_reference || `Transfer ${r.cashier_cash_transfer_id}`}</Text>
      <Text size="xs" c="dimmed">{[r.notes, `by ${r.created_by_name || '--'}`].filter(Boolean).join(', ')}</Text></div> },
    { header: 'Amount', align: 'right', cell: (r) => money(r.amount_cents) },
    { header: 'Status', cell: (r) => <StatusBadge status={words(r.status)} /> },
    { header: 'Confirmed', cell: (r) => (r.confirmed_by_name ? `${r.confirmed_by_name}, ${dateTime(r.confirmed_at)}` : '--') },
    { header: 'Actions', align: 'right', cell: (r) => (
      <Group gap={6} wrap="nowrap" justify="flex-end">
        {r.status === 'UNCONFIRMED' && <Button size="xs" variant="light" onClick={() => confirm.ask({ action: 'Confirm', subject: r.transfer_reference || `Transfer ${r.cashier_cash_transfer_id}`,
          run: () => transfer.mutateAsync({ path: `transfers/${r.cashier_cash_transfer_id}/confirm`, done: 'Cash transfer confirmed.' }) })}>Confirm</Button>}
        {r.status === 'UNCONFIRMED' && <Button size="xs" variant="danger" onClick={() => confirm.ask({ action: 'Cancel', subject: r.transfer_reference || `Transfer ${r.cashier_cash_transfer_id}`, danger: true,
          note: `A cash transfer of ${money(r.amount_cents)}.`, run: () => transfer.mutateAsync({ path: `transfers/${r.cashier_cash_transfer_id}/cancel`, done: 'Cash transfer cancelled.' }) })}>Cancel</Button>}
        <Button size="xs" variant="default" component="a" target="_blank" href={`${API}/${id}/transfers/${r.cashier_cash_transfer_id}/print?view=page`}>Print</Button>
      </Group>
    ) },
  ]
  const txnColumns: Column<Txn>[] = [
    { header: 'Date and time', cell: (r) => dateTime(r.created_at) },
    { header: 'Document no.', cell: (r) => r.document_number || '--' },
    { header: 'Transaction type', cell: (r) => typeWord(r.transaction_type) },
    { header: 'Payment mode', cell: (r) => words(r.payment_mode) || '--' },
    { header: 'Reference', cell: (r) => r.transaction_reference || '--' },
    { header: 'Patient / particulars', cell: (r) => r.description || '--' },
    { header: 'Bill amount', align: 'right', cell: (r) => (r.transaction_value_cents == null ? '--' : money(r.transaction_value_cents)) },
    { header: 'Amount received', align: 'right', cell: (r) => <Text size="sm" fw={700} c={r.tender_cents < 0 ? 'red.8' : undefined}>{money(r.tender_cents)}</Text> },
    { header: 'User', cell: (r) => r.user_name || '--' },
  ]
  const types = txns.data?.transaction_types ?? []

  return (
    <Page header={
      <PageHeader title={`Cashier session ${s.session_number}`} badge={<StatusBadge status={words(s.status)} />} actions={<>
        <Button variant="default" leftSection={<IconArrowLeft size={16} />} component={Link} to="/accounts/cashier-sessions">Cashier sessions</Button>
        <Button variant="default" leftSection={<IconPrinter size={16} />} component="a" target="_blank" href={`${API}/${id}/print?view=page`}>Print</Button>
        {!locked && <Button variant="default" onClick={() => setPanel('transfer')}>New cash transfer</Button>}
        {!locked && <Button onClick={() => setPanel('close')}>Close session</Button>}
      </>}>
        <Facts items={[{ label: 'Cashier', value: `${s.cashier_name ?? '--'}${s.cashier_user_type ? ` (${words(s.cashier_user_type).toLowerCase()})` : ''}` },
          { label: 'Opened', value: dateTime(s.opened_at) }, ...(s.closed_at ? [{ label: 'Closed', value: dateTime(s.closed_at) }] : []),
          { label: 'Opening float', value: money(s.opening_float_cents) }]} />
      </PageHeader>
    }>
      <Stack gap="md">
        {s.status === 'CLOSING' && (
          <Group align="end">
            {/* counted with a variance: recount, or approve it with a reason */}
            <Facts items={[{ label: 'Counted', value: money(s.counted_cash_cents) }, { label: 'Expected', value: money(s.expected_cash_cents) },
              { label: 'Variance', value: <Text span fw={700} c="red.8">{money(s.variance_cash_cents)}</Text> }]} />
            <Button variant="default" onClick={() => setPanel('close')}>Recount</Button>
            <TextInput label="Variance approval reason" placeholder="Variance approval reason" w={360} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
            <SaveButton problem={reason.trim() ? null : 'Enter the reason for approving the variance.'} loading={act.isPending} onClick={() => act.mutate({ path: 'approve', body: { reason: reason.trim() }, done: 'Variance approved. The session is closed.' })}>Approve variance and close</SaveButton>
          </Group>
        )}
        <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="md">
          <Paper withBorder p="md">
            <Title order={2} fz={16} mb="xs">Closing totals</Title>
            <Table highlightOnHover={false} verticalSpacing={4}>
              <Table.Tbody>
                {totals.map(([label, value, strong]) => (
                  <Table.Tr key={label}><Table.Td>{strong ? <b>{label}</b> : label}</Table.Td><Table.Td ta="right" fw={strong ? 700 : 400}>{value == null ? '--' : money(value)}</Table.Td></Table.Tr>
                ))}
                <Table.Tr><Table.Td><b>Variance at close</b></Table.Td><Table.Td ta="right" fw={700} c={variance ? 'red.8' : undefined}>{variance == null ? '--' : money(variance)}</Table.Td></Table.Tr>
              </Table.Tbody>
            </Table>
          </Paper>
          <Stack gap="xs" style={{ gridColumn: 'span 2' }}>
            <Group justify="space-between"><Title order={2} fz={16}>Cash transfers</Title>
              <Facts items={[{ label: 'Unconfirmed', value: transfers.unconfirmed_count }, { label: 'Transferred out', value: money(transfers.transfer_out_cents) }]} /></Group>
            <div><DataTable columns={transferColumns} rows={transfers.transfers} rowKey={(r) => r.cashier_cash_transfer_id} empty={<EmptyState title="No cash transfers found." />} /></div>
            {s.status === 'CLOSED' && adjustments && (
              <>
                <Group justify="space-between"><Title order={2} fz={16}>Adjustments</Title><Button size="xs" variant="default" onClick={() => setPanel('adjust')}>New adjustment</Button></Group>
                <Facts items={[{ label: 'Variance at close', value: money(adjustments.variance_at_close_cents) }, { label: 'Adjusted', value: signed(adjustments.adjusted_cents) },
                  { label: 'Variance now', value: money(adjustments.variance_now_cents) }]} />
                <div><DataTable rows={adjustments.adjustments} rowKey={(a) => a.created_at + a.amount_cents} empty={<EmptyState title="No adjustments found." />} columns={[
                  { header: 'Date', cell: (a) => dateTime(a.created_at) }, { header: 'Reason', cell: (a) => a.reason || '--' },
                  { header: 'Amount', align: 'right', cell: (a) => <Text size="sm" fw={700}>{signed(a.amount_cents)}</Text> }, { header: 'Created by', cell: (a) => a.created_by_name || '--' }]} /></div>
              </>
            )}
          </Stack>
        </SimpleGrid>
        <Group justify="space-between">
          <Group><Title order={2} fz={16}>Transactions</Title>
            <SegmentedControl size="xs" value={type} onChange={setType} data={[{ value: '', label: 'All' }, ...types.map((ty) => ({ value: ty, label: typeWord(ty) }))]} /></Group>
          <Button size="xs" variant="default" leftSection={<IconDownload size={14} />} component="a" href={`${API}/${id}/transactions?format=CSV${type ? `&transaction_type=${type}` : ''}`}>Export CSV</Button>
        </Group>
        <div><DataTable columns={txnColumns} rows={txns.data?.rows ?? []} rowKey={(r) => `${r.created_at}-${r.document_number}-${r.tender_cents}`} loading={txns.isFetching}
          empty={<EmptyState title={`No ${type ? `${typeWord(type).toLowerCase()} ` : ''}transactions found.`} />} /></div>
      </Stack>
      {panel === 'transfer' && <TransferForm expected={Number(closing.expected_cash_cents || 0)} sessionId={id!} onClose={() => setPanel(null)} onSaved={refresh} />}
      {panel === 'close' && <CloseSheet expected={Number(closing.expected_cash_cents || 0)} status={s.status} sessionId={id!} onClose={() => setPanel(null)} onSaved={refresh} />}
      {panel === 'adjust' && adjustments && <AdjustmentForm varianceNow={adjustments.variance_now_cents} sessionId={id!} onClose={() => setPanel(null)} onSaved={refresh} />}
      {confirm.dialog}
    </Page>
  )
}

interface FormProps { sessionId: string; onClose: () => void; onSaved: () => Promise<unknown> }

function TransferForm(props: FormProps & { expected: number }) {
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const save = useMutation({
    mutationFn: () => contract(`${API}/${props.sessionId}/cash-transfer`, 'POST', {
      amount_cents: paise(amount), expected_cash_cents: props.expected, transfer_reference: reference.trim() || null, notes: notes.trim() || null }),
    onSuccess: async () => { notifySuccess('Cash transfer saved as unconfirmed.'); await props.onSaved(); props.onClose() },
    onError: () => props.onSaved(),
  })
  return (
    <SidePanel title="New cash transfer" size={480} onClose={props.onClose}>
      <Stack>
        <NumberInput label="Amount (₹)" placeholder="0.00" min={0} decimalScale={2} hideControls value={amount} onChange={(v) => setAmount(String(v))} />
        <TextInput label="Transfer reference" value={reference} onChange={(e) => setReference(e.currentTarget.value)} />
        <TextInput label="Remarks" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        {save.isError && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end">
          <SaveButton problem={paise(amount) > 0 ? null : 'Transfer amount must be greater than zero.'} loading={save.isPending} onClick={() => save.mutate()}>Save</SaveButton>
        </Group>
      </Stack>
    </SidePanel>
  )
}

/** Counting the drawer to close the shift: notes by denomination plus coins, against the expected cash. */
function CloseSheet(props: FormProps & { expected: number; status: string }) {
  const [counts, setCounts] = useState<Record<number, string>>({})
  const [coins, setCoins] = useState('')
  const [notes, setNotes] = useState('')
  const counted = DENOMS.reduce((sum, d) => sum + d * 100 * Number(counts[d] || 0), 0) + paise(coins)
  const variance = counted - props.expected
  const save = useMutation({
    mutationFn: () => contract<{ status_now: string; variance_cash_cents?: number }>(`${API}/${props.sessionId}/close`, 'POST', {
      counted_cash_cents: counted, from_status: props.status || 'OPEN', notes: notes.trim() || null }),
    onSuccess: async (d) => {
      const v = money(d.variance_cash_cents ?? 0)
      if (d.status_now === 'CLOSED') notifySuccess(`Session closed. Variance ${v}.`)
      else notifyFailure(new Error(`Counted ${money(counted)}, variance ${v}. Recount, or approve the variance with a reason.`))
      await props.onSaved()
      props.onClose()
    },
  })
  return (
    <SidePanel title="Close session" size={560} onClose={props.onClose}>
      <Stack>
        <Facts items={[{ label: 'Expected cash', value: money(props.expected) }, { label: 'Counted', value: money(counted) },
          { label: 'Variance', value: <Text span fw={700} c={variance ? 'red.8' : undefined}>{money(variance)}</Text> }]} />
        <Text size="sm">{variance === 0 ? 'No variance.' : variance > 0 ? 'Over the expected cash.' : 'Short of the expected cash.'}</Text>
        <Table withTableBorder highlightOnHover={false}>
          <Table.Thead bg="gray.0"><Table.Tr><Table.Th>Denomination</Table.Th><Table.Th w={120} ta="right">Count</Table.Th><Table.Th ta="right">Value</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {DENOMS.map((d) => (
              <Table.Tr key={d}>
                <Table.Td>₹{d}</Table.Td>
                <Table.Td><NumberInput aria-label={`Notes of ₹${d}`} size="xs" min={0} allowDecimal={false} hideControls value={counts[d] ?? ''} onChange={(v) => setCounts({ ...counts, [d]: String(v) })} styles={{ input: { textAlign: 'right' } }} /></Table.Td>
                <Table.Td ta="right">{money(d * 100 * Number(counts[d] || 0))}</Table.Td>
              </Table.Tr>
            ))}
            <Table.Tr>
              <Table.Td>Coins (₹)</Table.Td>
              <Table.Td><NumberInput aria-label="Coins" size="xs" min={0} decimalScale={2} hideControls value={coins} onChange={(v) => setCoins(String(v))} styles={{ input: { textAlign: 'right' } }} /></Table.Td>
              <Table.Td ta="right">--</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
        <TextInput label="Remarks" placeholder="Enter remarks (optional)" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        {save.isError && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end"><Button loading={save.isPending} onClick={() => save.mutate()}>Close session</Button></Group>
      </Stack>
    </SidePanel>
  )
}

/** A correction after the close: an explicit entry with a reason, never an edit of the count. */
function AdjustmentForm(props: FormProps & { varianceNow: number }) {
  const [amount, setAmount] = useState<string | number>('')
  const [reason, setReason] = useState('')
  const save = useMutation({
    mutationFn: () => contract<{ variance_now_cents: number }>(`${API}/${props.sessionId}/adjustments`, 'POST', {
      amount_cents: paise(amount), reason: reason.trim(), variance_now_cents: props.varianceNow }),
    onSuccess: async (d) => { notifySuccess(`Adjustment saved. Variance now ${money(d.variance_now_cents)}.`); await props.onSaved(); props.onClose() },
  })
  const problem = !paise(amount) ? 'Enter an amount other than zero.' : !reason.trim() ? 'Enter the reason.' : null
  return (
    <SidePanel title="Cashier session adjustment" size={480} onClose={props.onClose}>
      <Stack>
        <NumberInput label="Amount (₹, + or −)" placeholder="0.00" decimalScale={2} hideControls value={amount} onChange={setAmount} />
        <TextInput label="Reason" placeholder="Enter reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        {save.isError && <Alert color="red">{save.error.message}</Alert>}
        <Group justify="flex-end"><SaveButton problem={problem}  loading={save.isPending} onClick={() => save.mutate()}>Save</SaveButton></Group>
      </Stack>
    </SidePanel>
  )
}
