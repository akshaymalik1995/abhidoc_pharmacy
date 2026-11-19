/** Sales Register: the counter's ten newest sale documents with what each allows. Estimates: the same list for every
 * estimate of one state. Confirm, convert, cancel and approve save through DocAssist. */
import { Button, SegmentedControl, Text } from '@mantine/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { api, ApiError, contract } from '../api'
import type { components } from '../api-types'
import {
  type Column, ConfirmDialog, DataTable, day, EmptyState, Facts, FilterBar, money, notifyFailure, notifySuccess, Page, PageHeader, type RowAction, RowActions, StatusBadge, useConfirm,
} from '../ui'
import { words } from './PurchaseList'
import { printBill, type Bill } from './SaleShared'

type Register = components['schemas']['SalesRegister']
type Row = Register['rows'][number]
type Ask = { row: Row; kind: 'cancel' | 'convert'; message?: string }

const SHOWS = [{ value: 'ESTIMATES_PENDING', label: 'Pending' }, { value: 'ESTIMATES_CONVERTED', label: 'Converted' },
  { value: 'ESTIMATES_CANCELLED', label: 'Cancelled' }, { value: 'ESTIMATES_ALL', label: 'All' }]

/** An open estimate waits: the stored "confirmed" would read as done. */
const state = (r: Row) => (r.sales_type === 'ESTIMATE' && r.status === 'CONFIRMED' ? 'Pending'
  : r.sales_type === 'ESTIMATE' && r.status === 'DRAFT' ? 'Pending (draft)' : words(r.status))

export function SalesRegister({ estimates = false }: { estimates?: boolean }) {
  const queryClient = useQueryClient()
  const [show, setShow] = useState(estimates ? 'ESTIMATES_PENDING' : '')
  const [asking, setAsking] = useState<Ask | null>(null)
  const list = useQuery({ queryKey: ['sales-register', show], queryFn: () => api<Register>(`/api/sales/register${show ? `?show=${show}` : ''}`) })
  const may = list.data?.permissions
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['sales-register'] }), queryClient.invalidateQueries({ queryKey: ['sales-history'] })])
  const close = () => setAsking(null)

  const step = useMutation({
    mutationFn: (job: { row: Row; path: string; body?: object; done: string }) => contract(job.path, 'POST', job.body ?? {}),
    onSuccess: (_, job) => { notifySuccess(`${job.row.sales_number} ${job.done}.`); return refresh() },
  })
  const confirm = useConfirm()
  // one press, one bill: the bill keeps what was quoted; when it cannot (a rate or tax changed, or the quoted
  // batch is short) DocAssist saves nothing and asks whether to go on at today's figures
  const convert = useMutation({
    mutationFn: ({ row, acceptToday }: { row: Row; acceptToday: boolean }) =>
      api<{ sales_number?: string; drift?: { drift_cents?: number; quoted_net_cents?: number; converted_net_cents?: number } }>(
        `/pharmacy/api/sales/${row.sales_document_id}/convert`, 'POST', acceptToday ? { accept_today: true } : {}),
    onSuccess: (reply, { row }) => {
      const drift = reply.drift?.drift_cents ? ` at today's prices: estimate ${money(reply.drift.quoted_net_cents)}, bill ${money(reply.drift.converted_net_cents)}` : ''
      notifySuccess(`Estimate ${row.sales_number} converted to bill ${reply.sales_number ?? ''}${drift}.`)
      close()
      return refresh()
    },
    onError: (error, { row }) => {
      const body = error instanceof ApiError ? (error.body as { status?: string; message?: string } | null) : null
      if (error instanceof ApiError && error.status === 409 && body?.status === 'needs_decision') setAsking({ row, kind: 'convert', message: body.message })
      else notifyFailure(error)
    },
  })
  const print = async (row: Row) => { try { await printBill(await api<Bill>(`/api/sales/bills/${row.sales_document_id}`)) } catch (e) { notifyFailure(e as Error) } }

  function actions(r: Row): RowAction[] {
    const id = r.sales_document_id
    const returnable = ['SALE', 'QUICK_SALE'].includes(r.sales_type) && ['CONFIRMED', 'PAID'].includes(r.status)
    const confirmable = ['SALE', 'QUICK_SALE', 'PENDING_SALE'].includes(r.sales_type) && ['DRAFT', 'PENDING'].includes(r.status)
    const estimate = r.sales_type === 'ESTIMATE'
    return [
      { label: 'View', to: `/sales/bills/${id}` },
      confirmable && may?.confirm && { label: 'Confirm', kind: 'main', onClick: () => confirm.ask({ action: 'Confirm', subject: r.sales_number ?? '',
        run: () => step.mutateAsync({ row: r, path: `/pharmacy/api/sales/${id}/confirm`, body: { packed_by_name: null }, done: 'confirmed' }) }) },
      // a quote prints as a quote, never through the bill slip rules
      ((!estimate && ['CONFIRMED', 'PAID'].includes(r.status) && may?.print) || (estimate && ['DRAFT', 'CONFIRMED'].includes(r.status))) && { label: 'Print', onClick: () => print(r) },
      returnable && (r.balance ?? 0) > 0 && may?.pay && { label: 'Collect payment', to: `/sales/bills/${id}?pay=1` },
      returnable && Number(r.quantity_total) > Number(r.returned_quantity_total) && { label: 'Sale return', to: `/sales/sale-returns?sale=${id}` },
      returnable && { label: 'Delivery', to: `/sales/deliveries?sale=${id}` },
      estimate && r.status === 'CONFIRMED' && { label: 'Convert', kind: 'main', onClick: () => confirm.ask({ action: 'Convert', subject: r.sales_number ?? '', note: 'A bill is made from this estimate.',
        run: () => convert.mutateAsync({ row: r, acceptToday: false }).catch(() => undefined) }) },
      estimate && r.status === 'CONFIRMED' && { label: 'Cancel', kind: 'danger', onClick: () => confirm.ask({ action: 'Cancel', subject: r.sales_number ?? '', danger: true, reason: true,
        run: (reason) => step.mutateAsync({ row: r, path: `/pharmacy/api/sales/${id}/cancel`, body: { reason }, done: 'cancelled' }) }) },
      r.sales_type === 'SALE_RETURN' && r.status === 'PENDING' && may?.credit
        && { label: 'Approve', kind: 'main', onClick: () => confirm.ask({ action: 'Approve', subject: r.sales_number ?? '',
          run: () => step.mutateAsync({ row: r, path: `/pharmacy/api/sale-returns/${id}/approve`, done: 'approved' }) }) },
    ].filter(Boolean) as RowAction[]
  }

  const note = (r: Row) => [
    r.converted_sales_number && `Converted to ${r.converted_sales_number}`,
    r.estimate_number && `From estimate ${r.estimate_number}`,
    r.sales_type === 'ESTIMATE' && r.status === 'CANCELLED' && r.cancelled_at
      && `Cancelled ${day(r.cancelled_at.slice(0, 10))}${r.cancelled_by_name ? ` by ${r.cancelled_by_name}` : ''}${r.cancel_reason ? `: ${r.cancel_reason}` : ''}`,
  ].filter(Boolean).join(', ')
  // confirmed with money still to collect is waiting, not done: the colour says so, the word stays
  const owed = (r: Row) => ['SALE', 'QUICK_SALE'].includes(r.sales_type) && r.status === 'CONFIRMED' && (r.balance ?? 0) > 0
  const columns: Column<Row>[] = [
    { header: 'Document no.', cell: (r) => <Text size="sm" fw={500}>{r.sales_number || '--'}</Text> },
    { header: 'Date', cell: (r) => day(r.document_date) },
    // the MRN and the visit sit under the patient, so the row fits without scrolling sideways
    { header: 'Patient', cell: (r) => (
      <div title={[r.visit_type && words(r.visit_type), r.visit_status && words(r.visit_status)].filter(Boolean).join(', ')}>
        <Text size="sm">{r.patient_name || (r.patient_id ? `Patient ${r.patient_id}` : 'Walk-in')}</Text>
        <Text size="xs" c="dimmed">{[r.mrn, r.visit_number ? `visit ${r.visit_number}` : 'walk-in'].filter(Boolean).join(', ')}</Text>
      </div>
    ) },
    { header: 'Type', cell: (r) => words(r.sales_type) },
    { header: 'Status', cell: (r) => <StatusBadge status={owed(r) ? 'Pending' : state(r)} /> },
    { header: 'Rounded', align: 'right', cell: (r) => <Text size="sm" fw={600}>{money(r.rounded)}</Text> },
    { header: 'Paid', align: 'right', cell: (r) => money(r.paid) },
    { header: 'Balance due', align: 'right', cell: (r) => ((r.balance ?? 0) > 0 ? money(r.balance) : '--') },
    { header: 'Net', align: 'right', cell: (r) => (
      <div title={`Gross ${money(r.gross)}, discount ${money(r.discount)}, tax ${money(r.tax)}, quantity ${Number(r.quantity_total)}`}>
        <Text size="sm">{money(r.net)}</Text><Text size="xs" c="dimmed">{r.product_count} product{r.product_count === 1 ? '' : 's'}</Text>
      </div>
    ) },
    { header: 'Note', cell: (r) => note(r) || '--' },
    { header: 'Actions', align: 'right', cell: (r) => <RowActions name={r.sales_number ?? ''} actions={actions(r)} /> },
  ]
  const s = list.data?.summary
  const header = (
    <>
      <PageHeader title={estimates ? 'Estimates' : 'Sales register'}
        actions={<Button variant="default" component={Link} to="/sales/sales-history">Sales history</Button>}>
        {!estimates && <Facts items={[
          { label: 'Sales today', value: money(s?.today_sales_cents) }, { label: 'Tax value', value: money(s?.today_tax_cents) },
          { label: 'Balance due', value: money(s?.outstanding_cents) }, { label: 'Pending sales', value: s?.pending_sale_count ?? '--' },
          { label: 'Return requests', value: s?.return_request_count ?? '--' },
        ]} />}
      </PageHeader>
      {estimates && <FilterBar><SegmentedControl data={SHOWS} value={show} onChange={setShow} /></FilterBar>}
    </>
  )

  return (
    <Page header={header}>
      <DataTable columns={columns} rows={list.data?.rows ?? []} rowKey={(r) => r.sales_document_id} loading={list.isFetching} view={show}
        empty={list.isError ? <EmptyState title="Could not load the list." hint={list.error.message} /> : <EmptyState title={estimates ? 'No estimates found.' : 'No sales found.'} />} />
      {confirm.dialog}
      <ConfirmDialog
        opened={asking?.kind === 'convert'} title={`Convert ${asking?.row.sales_number ?? ''}?`} confirm="Go on at today's figures" keep="Stop" danger={false}
        loading={convert.isPending} onClose={close} onConfirm={() => asking && convert.mutate({ row: asking.row, acceptToday: true })}
      >
        {asking?.message}
      </ConfirmDialog>
    </Page>
  )
}
