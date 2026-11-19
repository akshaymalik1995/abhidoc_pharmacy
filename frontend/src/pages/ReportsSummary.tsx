/** Reports Summary: six short lists that say where the pharmacy stands (what sells, what sits, what expires, what stock is
 * worth, who owes and is owed, what was lost), each with its first five rows and a link to the full report. DocAssist
 * works these figures out; they are read through it. */
import { Anchor, Button, Group, Paper, SegmentedControl, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { contract } from '../api'
import {
  day, Facts, money, Page, PageHeader, plain, SkeletonRows,
} from '../ui'

const SHOWN = 5
type Cells = ReactNode[]

/** One block: a title, its figures, the first five rows, and the count with a link to the full report. */
function Block(props: { title: string; facts?: { label: string; value: ReactNode }[]; head: string[]; right?: number[]; rows: Cells[] | undefined;
  loading: boolean; failed: boolean; none: string; report?: string; days?: string }) {
  const rows = props.rows ?? []
  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Group justify="space-between"><Title order={2} fz={16}>{props.title}</Title>{props.facts && <Facts items={props.facts} />}</Group>
        {/* a table never runs past its own box: if it cannot fit, it scrolls inside it */}
        <Table.ScrollContainer minWidth={0} type="native">
        <Table highlightOnHover={false} verticalSpacing={4}>
          <Table.Thead><Table.Tr>{props.head.map((h, i) => <Table.Th key={h} ta={props.right?.includes(i) ? 'right' : undefined}>{h}</Table.Th>)}</Table.Tr></Table.Thead>
          <Table.Tbody>
            {rows.slice(0, SHOWN).map((cells, r) => <Table.Tr key={r}>{cells.map((c, i) => <Table.Td key={i} ta={props.right?.includes(i) ? 'right' : undefined}>{c}</Table.Td>)}</Table.Tr>)}
            {!rows.length && (props.loading ? <SkeletonRows rows={5} cols={props.head.length} />
              : <Table.Tr><Table.Td colSpan={props.head.length}><Text size="sm">{props.failed ? 'Could not load. Try again.' : props.none}</Text></Table.Td></Table.Tr>)}
          </Table.Tbody>
        </Table>
        </Table.ScrollContainer>
        {rows.length > 0 && (
          <Group justify="space-between">
            <Facts items={[{ label: 'Shown', value: `${Math.min(SHOWN, rows.length)} of ${rows.length}` }]} />
            {props.report && <Anchor component={Link} to={`/reports/reports?report=${props.report}&days=${props.days ?? '30'}`} size="sm">View report</Anchor>}
          </Group>
        )}
      </Stack>
    </Paper>
  )
}

const useMis = <T,>(path: string) => useQuery({ queryKey: ['mis', path], queryFn: () => contract<T>(`/pharmacy/api/mis/${path}`) })

const product = (name: string) => <Anchor component={Link} to={`/stock/overall-stocks?q=${encodeURIComponent(name)}`} size="sm">{name}</Anchor>

export function ReportsSummary() {
  const [days, setDays] = useState('30')
  const movers = useMis<{ fast: { item_name: string; generic_name: string | null; sold_quantity: string; returned_quantity: string; net_quantity: string; has_reorder_level: number }[];
    slow: { item_name: string; quantity_on_hand: string; frozen_value_cents: number; last_sold_on: string | null }[]; slow_total_cents: number }>(`movers?days=${days}`)
  const expiring = useMis<{ batches: { item_name: string; batch_number: string | null; location_name: string | null; expiry_date: string; days_left: number; writeoff_pending: number;
    pending_writeoff_qty: string; pushable_quantity: string; value_cents: number; grn_purchase_document_id: number | null }[]; total_value_cents: number }>('expiring?days=90')
  const worth = useMis<{ locations: { location_name: string; item_count: number; cost_value_cents: number; mrp_value_cents: number; in_transit_cost_cents: number; damaged_cost_cents: number }[];
    total_cost_value_cents: number }>('stock-value')
  const debts = useMis<{ customers: { patient_name_snapshot: string | null; patient_id: number | null; sales_number: string; sales_document_id: number; age_days: number; balance_amount_cents: number }[];
    suppliers: { supplier_name: string | null; open_slips: number; oldest_age_days: number; outstanding_cents: number }[]; customers_total_cents: number; suppliers_total_cents: number }>('debts')
  const leaks = useMis<{ by_reason: { reason: string; quantity: string; loss_cents: number }[]; damaged_waiting: { item_name: string; damaged_quantity: string; value_cents: number }[];
    written_off_total_cents: number; damaged_waiting_total_cents: number }>(`leaks?days=${days}`)
  type Adv = { account_number: string; document_date: string; mrn: string | null; patient_id: number | null; net_amount_cents: number }
  const advances = useMis<{ topups: Adv[]; jar_refunds: Adv[]; returns: Adv[]; held_total_cents: number; topup_total_cents: number; return_total_cents: number }>(`advances?days=${days}`)
  const state = (q: { isPending: boolean; isError: boolean }) => ({ loading: q.isPending, failed: q.isError })

  return (
    <Page header={
      <PageHeader title="Summary" actions={<SegmentedControl value={days} onChange={setDays} data={[{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }]} />} />
    }>
      <SimpleGrid cols={{ base: 1, xl: 2 }} spacing="md">
        <Block title="Fast-moving products" head={['Product', 'Generic', 'Sold qty', 'Returned qty', 'Net qty', 'Reorder level']} right={[2, 3, 4]} {...state(movers)}
          none="No sales found." report="abc_analysis" days={days}
          rows={movers.data?.fast.map((r) => [product(r.item_name), r.generic_name || '--', plain(r.sold_quantity), plain(r.returned_quantity), <b key="n">{plain(r.net_quantity)}</b>, Number(r.has_reorder_level) ? 'Set' : '--'])} />
        <Block title="Non-moving products" facts={[{ label: 'Stock value', value: money(movers.data?.slow_total_cents) }]} head={['Product', 'Stock qty', 'Stock value', 'Last sale date']} right={[1, 2]}
          {...state(movers)} none="No non-moving products found." report="unsold_stock" days={days}
          rows={movers.data?.slow.map((r) => [product(r.item_name), plain(r.quantity_on_hand), money(r.frozen_value_cents), r.last_sold_on ? day(r.last_sold_on.slice(0, 10)) : 'Never'])} />
        <Block title="Near-expiry stock" facts={[{ label: 'Near-expiry value', value: money(expiring.data?.total_value_cents) }]}
          head={['Product', 'Expiry date', 'Days left', 'Stock qty', 'Value', 'Actions']} right={[2, 3, 4, 5]} {...state(expiring)} none="No near-expiry stock found." report="short_expiry_stock"
          rows={expiring.data?.batches.map((r) => [
            <div key="p">{product(r.item_name)}<Facts compact items={[{ label: 'Batch', value: r.batch_number || '--' }, { label: 'Location', value: r.location_name || '--' }]} /></div>,
            <Text key="e" size="sm" style={{ whiteSpace: 'nowrap' }}>{day(r.expiry_date?.slice(0, 10))}</Text>, r.days_left,
            <div key="q">{plain(r.pushable_quantity)}{Number(r.writeoff_pending) ? <Facts compact items={[{ label: 'Write-off pending', value: plain(r.pending_writeoff_qty) }]} /> : null}</div>,
            money(r.value_cents),
            r.grn_purchase_document_id ? <Button key="r" size="xs" variant="default" component={Link} to={`/purchase/goods-receipts?return=${r.grn_purchase_document_id}`}>Return</Button> : null])} />
        <Block title="Stock value" facts={[{ label: 'Total cost value', value: money(worth.data?.total_cost_value_cents) }]}
          head={['Location', 'Products', 'Cost value', 'MRP value', 'In transit', 'Damaged']} right={[1, 2, 3, 4, 5]} {...state(worth)} none="No stock found." report="closing_stock"
          rows={worth.data?.locations.map((r) => [r.location_name, r.item_count, money(r.cost_value_cents), money(r.mrp_value_cents), money(r.in_transit_cost_cents), money(r.damaged_cost_cents)])} />
        <Block title="Receivables and payables" facts={[{ label: 'Receivable', value: money(debts.data?.customers_total_cents) }, { label: 'Payable', value: money(debts.data?.suppliers_total_cents) }]}
          head={['Patient / supplier', 'Kind', 'Bill / goods receipts', 'Age (days)', 'Amount']} right={[3, 4]} {...state(debts)} none="No receivables or payables found." report="credit_outstanding"
          rows={debts.data && [
            ...debts.data.customers.map((r) => [r.patient_name_snapshot || `Patient ${r.patient_id ?? '--'}`, 'Receivable',
              <Anchor key="b" component={Link} to={`/sales/bills/${r.sales_document_id}`} size="sm">{r.sales_number}</Anchor>, r.age_days, money(r.balance_amount_cents)]),
            ...debts.data.suppliers.map((r) => [r.supplier_name || '--', 'Payable',
              <Anchor key="s" component={Link} to="/accounts/supplier-outstanding" size="sm">{r.open_slips} unpaid goods receipt{Number(r.open_slips) === 1 ? '' : 's'}</Anchor>, r.oldest_age_days, money(r.outstanding_cents)])]} />
        <Block title="Patient advances" facts={[{ label: 'Advance balance', value: money(advances.data?.held_total_cents) }, { label: 'Collected', value: money(advances.data?.topup_total_cents) },
          { label: 'Refunded', value: money(advances.data?.return_total_cents) }]} head={['Document no.', 'Date', 'Patient', 'Particulars', 'Amount']} right={[4]} {...state(advances)}
          none="No patient advances found." report="advance_register" days={days}
          rows={advances.data && [
            ...advances.data.topups.map((r) => [r, 'Advance collected'] as const), ...advances.data.jar_refunds.map((r) => [r, 'Bill refund to advance'] as const),
            ...advances.data.returns.map((r) => [r, 'Advance refunded'] as const),
          ].map(([r, what]) => [r.account_number, day(r.document_date?.slice(0, 10)), r.mrn || `Patient ${r.patient_id ?? '--'}`, what, money(r.net_amount_cents)])} />
        <Block title="Stock write-offs" facts={[{ label: 'Written off', value: money(leaks.data?.written_off_total_cents) }, { label: 'Pending', value: money(leaks.data?.damaged_waiting_total_cents) }]}
          head={['Reason / product', 'Status', 'Qty', 'Value', 'Remarks']} right={[2, 3]} {...state(leaks)} none="No stock write-offs found." report="write_offs" days={days}
          rows={leaks.data && [
            ...leaks.data.by_reason.map((r) => [r.reason, 'Written off', plain(r.quantity), money(r.loss_cents), '--']),
            ...leaks.data.damaged_waiting.map((r) => [product(r.item_name), 'Damaged, not written off', plain(r.damaged_quantity), money(r.value_cents), 'Pending'])]} />
      </SimpleGrid>
    </Page>
  )
}
