/** One bill: what was sold, what was paid, and its audit trail. Collect payment saves through DocAssist. */
import { Button, Paper, Stack, Text, Title } from '@mantine/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import { contract } from '../api'
import { DataTable, day, EmptyState, Facts, money, notifyFailure, notifySuccess, Page, PageHeader, PageSkeleton, plain, StatusBadge, type Column } from '../ui'
import { words } from './PurchaseList'
import { dateTime, PaymentPanel, printBill, useBill, type Bill } from './SaleShared'

type Line = Bill['lines'][number]
type Tender = Bill['tenders'][number]
interface AuditRow { audit_event_id: number; timestamp: string; action_words: string | null; action: string | null; actor: string | null; status_before: string | null; status_after: string | null; summary: string | null }

const RETURN_HANDLING: Record<string, string> = {
  AUTO: 'Automatic: cash, then patient advance, then balance due', CASH: 'Cash', ADVANCE: 'Patient advance', BALANCE: 'Reduce balance due',
}

const LINE_COLUMNS: Column<Line>[] = [
  { header: '#', cell: (l) => l.line_number },
  { header: 'Product', cell: (l) => <><Text size="sm" fw={500}>{l.description}</Text>{(l.packing || l.prescribed) && <Text size="xs" c="dimmed">{[l.packing, l.prescribed && 'Prescribed'].filter(Boolean).join(', ')}</Text>}</> },
  { header: 'Batch', cell: (l) => l.batch_number || '--' },
  { header: 'Expiry', cell: (l) => day(l.expiry_date) },
  { header: 'Qty', align: 'right', cell: (l) => <>{plain(l.quantity)}{Number(l.returned_quantity) > 0 && <Text size="xs" c="dimmed">returned {plain(l.returned_quantity)}</Text>}</> },
  { header: 'Rate', align: 'right', cell: (l) => money(l.unit_price_cents) },
  { header: 'Discount', align: 'right', cell: (l) => money(l.discount_amount_cents) },
  { header: 'Tax', align: 'right', cell: (l) => money(l.tax_amount_cents) },
  { header: 'Net', align: 'right', cell: (l) => money(l.net_amount_cents) },
  { header: 'Status', cell: (l) => <StatusBadge status={words(l.line_status)} /> },
]

export function SaleBill() {
  const { id } = useParams()
  const [search, setSearch] = useSearchParams()
  const queryClient = useQueryClient()
  const found = useBill(id)
  const bill = found.data
  const audit = useQuery({
    queryKey: ['bill-audit', bill?.sales_number],
    enabled: Boolean(bill?.sales_number),
    queryFn: () => contract<{ rows: AuditRow[] }>(`/pharmacy/api/mis/audit-log?${new URLSearchParams({
      source_module: 'PHARMACY', entity_type: 'SALES_DOCUMENT', source_document: bill!.sales_number ?? '', limit: '50' })}`),
  })
  const billed = bill && ['SALE', 'QUICK_SALE'].includes(bill.sales_type) && ['CONFIRMED', 'PAID'].includes(bill.status)
  const canPay = Boolean(billed && bill.balance > 0 && bill.permissions.pay)
  const [paying, setPaying] = useState(false)
  // opened from a list's Collect payment: the panel opens with the bill
  const payOpen = paying || (search.get('pay') === '1' && canPay)
  const closePay = () => { setPaying(false); if (search.has('pay')) setSearch({}, { replace: true }) }

  if (found.isPending) return <PageSkeleton />
  if (!bill) return <Page header={<PageHeader title="Bill" />}><EmptyState title="Could not open this bill." hint={found.error?.message} /></Page>

  const labels = Object.fromEntries(bill.payment_modes.map((m) => [m.code, m.label]))
  const info = bill.return_info
  const tenderColumns: Column<Tender>[] = [
    { header: 'Payment mode', cell: (t) => labels[t.payment_mode] || words(t.payment_mode) },
    { header: 'Amount', align: 'right', cell: (t) => money(t.amount_cents) },
    { header: 'Change returned', align: 'right', cell: (t) => (t.return_amount_cents > 0 ? money(t.return_amount_cents) : '--') },
    { header: 'Reference no.', cell: (t) => t.transaction_reference || '--' },
    { header: 'Authorized by', cell: (t) => t.authorized_by_name || '--' },
    { header: 'Reason', cell: (t) => t.authorization_reason || '--' },
    { header: 'Remarks', cell: (t) => t.remarks || '--' },
  ]
  const auditColumns: Column<AuditRow>[] = [
    { header: 'Date and time', cell: (r) => dateTime(r.timestamp) },
    { header: 'Action', cell: (r) => r.action_words || words(r.action) },
    { header: 'User', cell: (r) => r.actor || '--' },
    { header: 'Status change', cell: (r) => `${words(r.status_before) || '--'} to ${words(r.status_after) || '--'}` },
    { header: 'Summary', cell: (r) => r.summary || '' },
  ]
  const refunds = info ? [
    ...info.refunds.map((f) => ({ label: f.account_type === 'CUSTOMER_ADVANCE' ? 'To patient advance' : `Refunded by ${labels[f.payment_mode ?? ''] || words(f.payment_mode) || 'cash'}`,
      value: `${money(f.net_amount_cents)} (${f.account_number})` })),
    ...(info.balance_cut_cents > 0 ? [{ label: 'Balance due reduced by', value: money(info.balance_cut_cents) }] : []),
  ] : []

  return (
    <Page header={
      <PageHeader
        title={`Bill ${bill.sales_number ?? ''}`}
        badge={<StatusBadge status={words(bill.status)} />}
        actions={<>
          {billed && <Button variant="default" component={Link} to={`/sales/deliveries?sale=${bill.sales_document_id}`}>Delivery</Button>}
          {bill.permissions.print && <Button variant="default" onClick={() => printBill(bill).catch(notifyFailure)}>Print</Button>}
          {canPay && <Button onClick={() => setPaying(true)}>Collect payment</Button>}
        </>}
      >
        <Facts items={[{ label: 'Rounded', value: money(bill.rounded) }, { label: 'Paid', value: money(bill.paid) },
          { label: 'Balance due', value: <Text span fw={700} c={bill.balance > 0 ? 'red.8' : undefined}>{money(bill.balance)}</Text> }]} />
      </PageHeader>
    }>
      {/* the page scrolls as one; each table keeps the height of its rows */}
      <Stack gap="md">
        <Paper withBorder p="md">
          <Facts items={[
            { label: 'Bill date', value: `${day(bill.document_date)}, ${dateTime(bill.billed_at || bill.created_at)}` },
            { label: 'Patient', value: [bill.patient_name || '--', bill.gender].filter(Boolean).join(', ') },
            { label: 'MRN', value: bill.mrn || '--' },
            { label: 'Visit', value: [bill.visit_number || words(bill.visit_type) || '--', bill.visit_status && words(bill.visit_status)].filter(Boolean).join(', ') },
            { label: 'Billed by', value: bill.billed_by_name || '--' },
            { label: 'Location', value: bill.location_name || '--' },
            ...bill.customer.map((c) => ({ label: c.label, value: c.value })),
            ...(info ? [{ label: 'Reason', value: info.reasons.join('; ') || '--' }, { label: 'Received by', value: info.received_by_name || '--' },
              { label: 'Refund mode', value: RETURN_HANDLING[info.refund_handling ?? ''] || info.refund_handling || '--' }] : []),
          ]} />
        </Paper>
        <Paper withBorder p="md">
          <Facts items={[{ label: 'Gross', value: money(bill.gross) }, { label: 'Discount', value: money(bill.discount) }, { label: 'Tax', value: money(bill.tax) },
            { label: 'Rounded', value: money(bill.rounded) }, { label: 'Paid', value: money(bill.paid) }, { label: 'Balance due', value: money(bill.balance) }]} />
        </Paper>
        <div><DataTable columns={LINE_COLUMNS} rows={bill.lines} rowKey={(l) => l.sales_item_id} empty={<EmptyState title="No products found." />} /></div>
        <Title order={2} fz={16}>{info ? 'Refund' : 'Payments'}</Title>
        {info ? <Facts items={info.waiting_for_approval ? [{ label: 'Refund', value: 'Pending approval' }] : refunds.length ? refunds : [{ label: 'Refunded', value: '--' }]} />
          : bill.tenders.length ? <div><DataTable columns={tenderColumns} rows={bill.tenders} rowKey={(t) => `${t.line_number}-${t.payment_mode}`} empty={null} /></div>
            : <Text size="sm">{bill.paid > 0 ? `Paid ${money(bill.paid)}. No payment details found.` : 'No payments found.'}</Text>}
        <Title order={2} fz={16}>Audit log</Title>
        <div><DataTable columns={auditColumns} rows={audit.data?.rows ?? []} rowKey={(r) => r.audit_event_id} loading={audit.isFetching}
          empty={<EmptyState title={audit.isError ? 'Could not load the audit log.' : 'No audit entries found.'} />} /></div>
      </Stack>
      {payOpen && (
        <PaymentPanel
          subject={bill.sales_number ?? ''} billCents={bill.rounded} balanceCents={bill.balance} modes={bill.payment_modes}
          devices={bill.print_devices} saveLabel="Collect payment" onClose={closePay}
          onSave={async (payload, withPrint) => {
            const reply = await contract<{ balance_amount_cents?: number; paid_now_cents?: number }>(`/pharmacy/api/sales/${bill.sales_document_id}/pay`, 'POST', payload)
            notifySuccess(`Payment saved on ${bill.sales_number}: collected ${money(reply.paid_now_cents ?? 0)}, balance due ${money(reply.balance_amount_cents ?? 0)}.`)
            await Promise.all([queryClient.invalidateQueries({ queryKey: ['bill', String(bill.sales_document_id)] }), queryClient.invalidateQueries({ queryKey: ['bill-audit'] }),
              queryClient.invalidateQueries({ queryKey: ['sales-history'] })])
            if (withPrint) {
              const fresh = queryClient.getQueryData<Bill>(['bill', String(bill.sales_document_id)])
              if (fresh) await printBill(fresh)
            }
            return reply
          }}
        />
      )}
    </Page>
  )
}

