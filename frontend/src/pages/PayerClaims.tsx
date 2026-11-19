/** Payer Claims: every insurance claim packet, with the status the payer's portal last showed. Claims belong to the
 * hospital's insurance desk in DocAssist; this screen reads them and records a portal status through it. */
import { Alert, Button, Group, NumberInput, Select, Stack, Text, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconSearch } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { contract, DOCASSIST_URL } from '../api'
import { DataTable, day, EmptyState, Facts, FilterBar, money, notifySuccess, Page, PageHeader, SidePanel, StatusBadge, type Column } from '../ui'
import { dateTime } from './SaleShared'

interface Packet { claim_case_id: number; admission_id: number; payer_name: string | null; insurer_name: string | null; tpa_name: string | null;
  external_claim_number: string | null; external_reference_number: string | null; patient_name: string | null; mrn: string | null; ward_name: string | null;
  bed_number: string | null; admission_datetime: string | null; claimed_amount_cents: number; approved_amount_cents: number; co_pay_cents: number;
  deductible_cents: number; non_payable_cents: number; claim_status: string; stale?: boolean; last_checked_at: string | null; external_portal: string | null; claim_notes: string | null }
const STATUSES = [['DRAFT_PENDING', 'Draft pending'], ['QUERIES_PENDING', 'Queries pending'], ['AWAITING_DISCHARGE', 'Awaiting discharge'], ['APPROVAL_PENDING', 'Approval pending'],
  ['PRE_AUTH_APPROVED', 'Pre-auth approved'], ['PROCESSING', 'Processing'], ['SETTLED', 'Settled'], ['SHORTFALL', 'Shortfall'], ['REJECTED', 'Rejected'], ['CLOSED', 'Closed'], ['CANCELLED', 'Cancelled']]
const statusWord = (code: string) => STATUSES.find(([c]) => c === code)?.[1] ?? code
const FINAL = ['SETTLED', 'REJECTED', 'CLOSED', 'CANCELLED']

export function PayerClaims() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [q] = useDebouncedValue(search.trim(), 300)
  const [editing, setEditing] = useState<Packet | null>(null)
  const params = new URLSearchParams(Object.entries({ claim_status: status ?? '', search: q.length >= 2 ? q : '' }).filter(([, v]) => v))
  const list = useQuery({ queryKey: ['claim-packets', params.toString()], placeholderData: keepPreviousData,
    queryFn: () => contract<{ packets: Packet[]; stale_count?: number; stale_days?: number }>(`/accounts/api/claim-packets?${params}`) })
  const rows = list.data?.packets ?? []
  const columns: Column<Packet>[] = [
    { header: 'Claim no.', cell: (p) => <><Text size="sm" fw={500}>{p.external_claim_number || '--'}</Text>{p.external_reference_number && <Text size="xs" c="dimmed">ref {p.external_reference_number}</Text>}</> },
    { header: 'Payer', cell: (p) => <><Text size="sm">{p.payer_name || '--'}</Text><Text size="xs" c="dimmed">{p.insurer_name || p.tpa_name || '--'}</Text></> },
    { header: 'Patient', cell: (p) => <><Text size="sm">{p.patient_name || '--'}</Text><Text size="xs" c="dimmed">{[p.mrn, p.ward_name, p.bed_number].filter(Boolean).join(', ') || '--'}</Text></> },
    { header: 'Admitted', cell: (p) => day(p.admission_datetime?.slice(0, 10)) },
    { header: 'Claimed', align: 'right', cell: (p) => money(p.claimed_amount_cents) },
    { header: 'Approved', align: 'right', cell: (p) => money(p.approved_amount_cents) },
    { header: 'Co-pay / deductible', align: 'right', cell: (p) => <><Text size="sm">{money(p.co_pay_cents)}</Text><Text size="xs" c="dimmed">{money(p.deductible_cents)}</Text></> },
    { header: 'Non-payable', align: 'right', cell: (p) => money(p.non_payable_cents) },
    { header: 'Status', cell: (p) => <><StatusBadge status={statusWord(p.claim_status)} />{p.stale && <Text size="xs" c="dimmed">not checked lately</Text>}</> },
    { header: 'Last checked', cell: (p) => <><Text size="sm">{p.last_checked_at ? dateTime(p.last_checked_at) : 'Never'}</Text><Text size="xs" c="dimmed">{p.external_portal || '--'}</Text></> },
    { header: 'Actions', align: 'right', cell: (p) => (FINAL.includes(p.claim_status) ? null : <Button size="xs" variant="default" onClick={() => setEditing(p)}>Portal status</Button>) },
  ]
  return (
    <Page header={<>
      <PageHeader title="Payer claims" actions={<>
        <Button variant="default" component="a" href={`${DOCASSIST_URL}/insurance/claims`} target="_blank" rel="noopener">Claims Explorer</Button>
        <Button variant="default" onClick={() => queryClient.invalidateQueries({ queryKey: ['claim-packets'] })}>Refresh</Button>
      </>}>
        <Facts items={[{ label: 'Claim packets', value: rows.length }, ...(Number(list.data?.stale_count) ? [{ label: `Not checked in ${list.data?.stale_days}+ days`, value: list.data?.stale_count }] : [])]} />
      </PageHeader>
      <FilterBar>
        <Group align="end">
          <Select aria-label="Claim status" placeholder="All statuses" clearable w={200} value={status} onChange={setStatus} data={STATUSES.map(([value, label]) => ({ value, label }))} />
          <TextInput aria-label="Search" placeholder="Claim no., policy, MRN or patient" leftSection={<IconSearch size={16} />} w={300} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
        </Group>
      </FilterBar>
    </>}>
      <DataTable columns={columns} rows={rows} rowKey={(p) => p.claim_case_id} loading={list.isFetching} view={params.toString()}
        empty={<EmptyState title={list.isError ? 'Could not load.' : 'No claim packets found.'} hint={list.error?.message} />} />
      {editing && <PortalStatus packet={editing} onClose={() => setEditing(null)} onSaved={() => queryClient.invalidateQueries({ queryKey: ['claim-packets'] })} />}
    </Page>
  )
}

function PortalStatus({ packet, onClose, onSaved }: { packet: Packet; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [status, setStatus] = useState(packet.claim_status || 'DRAFT_PENDING')
  const [approved, setApproved] = useState(((Number(packet.approved_amount_cents) || 0) / 100).toFixed(2))
  const [reference, setReference] = useState(packet.external_reference_number ?? '')
  const [notes, setNotes] = useState(packet.claim_notes ?? '')
  const save = useMutation({
    mutationFn: () => contract(`/accounts/api/claim-packets/${packet.admission_id}/external-status`, 'POST', {
      claim_case_id: packet.claim_case_id, claim_status: status, approved_amount_cents: Math.round((Number(approved) || 0) * 100),
      external_reference_number: reference.trim() || null, claim_notes: notes.trim() || null }),
    onSuccess: async () => { notifySuccess('Portal status recorded on the claim case.'); await onSaved(); onClose() },
  })
  return (
    <SidePanel title="Record portal status" subject={`${packet.external_claim_number || `Claim ${packet.claim_case_id}`}, ${packet.patient_name ?? ''}`} size={520} onClose={onClose}>
      <Stack>
        <Select label="Claim status" allowDeselect={false} value={status} onChange={(v) => setStatus(v ?? status)} data={STATUSES.map(([value, label]) => ({ value, label }))} />
        <NumberInput label="Approved amount (₹)" placeholder="0.00" min={0} decimalScale={2} hideControls value={approved} onChange={(v) => setApproved(String(v))} />
        <TextInput label="Payer reference no." placeholder="Acknowledgement or approval id" value={reference} onChange={(e) => setReference(e.currentTarget.value)} />
        <TextInput label="Notes" placeholder="Query or email reference" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        {save.isError && <Alert color="red">{save.error.message || 'Could not record the portal status.'}</Alert>}
        <Group justify="flex-end"><Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button></Group>
      </Stack>
    </SidePanel>
  )
}
