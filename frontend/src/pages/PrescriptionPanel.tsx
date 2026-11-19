/** Loading a prescription into a bill: find it among the OP or IP prescriptions, review its medicines, choose which
 * to load and how many. Prescriptions live in DocAssist's record store, so the list and the load go through DocAssist. */
import { Alert, Button, Checkbox, Group, NumberInput, Radio, Select, Stack, Table, Tabs, Text, TextInput } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { Fragment, useState } from 'react'

import { api } from '../api'
import {
  money, plain, SidePanel, SkeletonRows, StatusBadge,
} from '../ui'

interface Medicine { medication_name: string; dosage?: string; frequency?: string; duration?: string; item_name?: string | null; generic_name?: string | null;
  hsn_code?: string | null; available: boolean; available_quantity: number | string; selling_price_cents?: number | null; unit_mrp_cents?: number | null }
interface Prescription { record_id: string; prescription_id?: number | null; prescription_number?: string | null; ordered_at?: string | null; visit_number?: string | null;
  visit_type?: string | null; ward_bed?: string | null; patient_name?: string | null; patient_id?: number | null; mrn?: string | null; contact_number?: string | null;
  doctor_name?: string | null; medicine_count?: number; available_medicine_count?: number; status?: string | null; medications?: Medicine[] }
interface ListReply { rows: Prescription[]; tab_counts?: { OP?: number; IP?: number }; warning?: string | null; note?: string | null }
export interface LoadedLine { pharmacy_item_id: number; item_name: string; generic_name?: string | null; medication_name?: string | null; quantity?: string | number;
  unit_price_cents?: number | null; unit_mrp_cents?: number | null; tax_percent?: string | number | null; hsn_code?: string | null; packing?: string | null;
  source_prescription_id: number | string; source_prescription_item_id: number | string; available_quantity?: number | string; prescription_number?: string | null }
export interface LoadedPrescription {
  prescription: { visit_type?: string | null; visit_id?: number | null; admission_id?: number | null; visit_number?: string | null; visit_status?: string | null;
    doctor_id?: number | null; patient_id?: number | null; mrn?: string | null; patient_name?: string | null; contact_number?: string | null; doctor_name?: string | null }
  reference: { prescription_id: number; prescription_number?: string | null }
  lines: LoadedLine[]
  skipped?: unknown[]
  not_loaded_note?: string | null
}

const PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['last_7_days', 'Last 7 days'], ['last_30_days', 'Last 30 days'], ['this_month', 'This month'], ['all', 'All time'], ['custom', 'Custom range']]
const SEARCH_BY = [['all', 'All'], ['visit', 'Visit no.'], ['mrn', 'MRN'], ['name', 'Patient or doctor name'], ['phone', 'Phone'], ['reference', 'Prescription no.']]
const STATUSES = [['', 'All'], ['Active', 'Active'], ['Completed', 'Completed'], ['Past', 'Expired'], ['Discontinued', 'Discontinued']]
const choices = (pairs: string[][]) => pairs.map(([value, label]) => ({ value, label }))

/** holding: the prescription already loaded into this bill; another cannot be loaded on top of it. */
export function PrescriptionPanel(props: { holding: { id: string; label: string } | null; onClose: () => void; onLoaded: (loaded: LoadedPrescription) => void }) {
  const [tab, setTab] = useState('OP')
  const [filters, setFilters] = useState({ preset: 'last_30_days', date_from: '', date_to: '', search_type: 'all', q: '', status: '' })
  const [asked, setAsked] = useState(filters) // the search runs on Search, Enter, a preset or a tab, not on each letter
  const [picked, setPicked] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  // per prescription, per medicine (1-based): the quantity to load, or false when left out
  const [chosen, setChosen] = useState<Record<string, Record<number, string | false>>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const params = new URLSearchParams({ tab, limit: '50' })
  if (asked.preset === 'custom') { if (asked.date_from) params.set('date_from', asked.date_from); if (asked.date_to) params.set('date_to', asked.date_to) }
  else params.set('date_preset', asked.preset)
  if (asked.search_type !== 'all') params.set('search_type', asked.search_type)
  if (asked.q.trim()) params.set('q', asked.q.trim())
  if (asked.status) params.set('status', asked.status)
  const list = useQuery({ queryKey: ['prescriptions', params.toString()], queryFn: () => api<ListReply>(`/pharmacy/api/prescriptions?${params}`) })
  const rows = list.data?.rows ?? []
  const row = rows.find((r) => r.record_id === picked)
  const medsOf = (r: Prescription) => chosen[r.record_id] ?? Object.fromEntries((r.medications ?? []).map((m, i) => [i + 1, m.available ? '1' : false]))
  const count = (r: Prescription) => (chosen[r.record_id] ? Object.values(medsOf(r)).filter((q) => q !== false && Number(q) > 0).length : r.available_medicine_count ?? 0)
  const setMed = (r: Prescription, index: number, value: string | false) => setChosen({ ...chosen, [r.record_id]: { ...medsOf(r), [index]: value } })
  const search = (next = filters) => { setAsked(next); setPicked(null); setExpanded(null) }

  async function load() {
    if (!row) return setError('Select a prescription.')
    if (props.holding && props.holding.id !== String(row.prescription_id ?? '')) {
      return setError(`This bill already has prescription ${props.holding.label}. Save or cancel it before loading another.`)
    }
    const body: { prescription_id: number | null; record_id: string; items?: { medication_index: number; quantity: string }[] } = { prescription_id: row.prescription_id ?? null, record_id: row.record_id }
    if (chosen[row.record_id]) {
      body.items = Object.entries(medsOf(row)).filter(([, q]) => q !== false && Number(q) > 0).map(([i, q]) => ({ medication_index: Number(i), quantity: String(q) }))
      if (!body.items.length) return setError('Select at least one medicine.')
    }
    setLoading(true)
    setError(null)
    try {
      const reply = await api<LoadedPrescription & { loaded?: boolean; message?: string }>('/pharmacy/api/sales/load-prescription', 'POST', body)
      if (!reply.loaded) throw new Error(reply.message || 'Could not load. Try again.')
      props.onLoaded(reply)
    } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }

  return (
    <SidePanel title="Load prescription" size={1100} onClose={props.onClose} viewOnly>
      <Stack gap="md">
        <Tabs value={tab} onChange={(t) => { setTab(t ?? 'OP'); setPicked(null); setExpanded(null) }}>
          <Tabs.List>
            <Tabs.Tab value="OP">OP prescriptions ({list.data?.tab_counts?.OP ?? 0})</Tabs.Tab>
            <Tabs.Tab value="IP">IP prescriptions ({list.data?.tab_counts?.IP ?? 0})</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <Group align="end" wrap="wrap">
          <Select label="Date range" w={150} allowDeselect={false} data={choices(PRESETS)} value={filters.preset}
            onChange={(v) => { const next = { ...filters, preset: v ?? 'last_30_days' }; setFilters(next); if (v !== 'custom') search(next) }} />
          <TextInput label="From date" type="date" w={150} disabled={filters.preset !== 'custom'} value={filters.date_from} onChange={(e) => setFilters({ ...filters, date_from: e.currentTarget.value })} />
          <TextInput label="To date" type="date" w={150} disabled={filters.preset !== 'custom'} value={filters.date_to} onChange={(e) => setFilters({ ...filters, date_to: e.currentTarget.value })} />
          <Select label="Search by" w={170} allowDeselect={false} data={choices(SEARCH_BY)} value={filters.search_type} onChange={(v) => setFilters({ ...filters, search_type: v ?? 'all' })} />
          <TextInput label="Search" placeholder="Visit no., MRN, name, phone or prescription no." style={{ flex: 1 }} miw={200} value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.currentTarget.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search() } }} />
          <Select label="Status" w={140} allowDeselect={false} data={choices(STATUSES)} value={filters.status} onChange={(v) => setFilters({ ...filters, status: v ?? '' })} />
          <Button variant="default" onClick={() => search()}>Search</Button>
        </Group>
        {list.data?.warning && <Alert color="yellow">{list.data.warning}</Alert>}
        <Table withTableBorder highlightOnHover={false}>
          <Table.Thead bg="gray.0">
            <Table.Tr><Table.Th w={40} /><Table.Th>Date</Table.Th><Table.Th>Visit</Table.Th><Table.Th>Patient</Table.Th><Table.Th>Doctor</Table.Th>
              <Table.Th ta="right">Medicines</Table.Th><Table.Th ta="right">Available</Table.Th><Table.Th>Status</Table.Th><Table.Th /></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.isFetching && !rows.length && <SkeletonRows rows={5} cols={9} />}
            {list.isError && <Table.Tr><Table.Td colSpan={9}><Text size="sm">{list.error.message}</Text></Table.Td></Table.Tr>}
            {!list.isFetching && list.data && !rows.length && <Table.Tr><Table.Td colSpan={9}><Text size="sm">No {tab} prescriptions found. {list.data.note ?? ''}</Text></Table.Td></Table.Tr>}
            {rows.map((r) => (
              <Fragment key={r.record_id}>
                <Table.Tr>
                  <Table.Td><Radio aria-label="Select this prescription" checked={picked === r.record_id} onChange={() => setPicked(r.record_id)} /></Table.Td>
                  <Table.Td><Text size="sm">{r.ordered_at?.slice(0, 10) ?? '--'}</Text><Text size="xs" c="dimmed">{r.ordered_at?.slice(11, 16)}</Text></Table.Td>
                  <Table.Td>{r.visit_number ? <><Text size="sm">{r.visit_number}</Text><Text size="xs" c="dimmed">{[r.visit_type, r.ward_bed].filter(Boolean).join(', ')}</Text></> : '--'}</Table.Td>
                  <Table.Td><Text size="sm">{r.patient_name || `Patient ${r.patient_id ?? '--'}`}</Text><Text size="xs" c="dimmed">{[r.mrn, r.contact_number].filter(Boolean).join(', ')}</Text></Table.Td>
                  <Table.Td>{r.doctor_name || '--'}</Table.Td>
                  <Table.Td ta="right">{r.medicine_count ?? 0}</Table.Td>
                  <Table.Td ta="right">{r.available_medicine_count ?? 0}</Table.Td>
                  <Table.Td><StatusBadge status={r.status || '--'} /></Table.Td>
                  <Table.Td>
                    <Button variant="default" size="xs" onClick={() => { const open = expanded === r.record_id ? null : r.record_id; setExpanded(open); if (open && !picked) setPicked(open) }}>
                      {expanded === r.record_id ? 'Hide medicines' : 'View medicines'}
                    </Button>
                  </Table.Td>
                </Table.Tr>
                {expanded === r.record_id && (
                  <Table.Tr>
                    <Table.Td colSpan={9} bg="gray.0">
                      {!(r.medications ?? []).length ? <Text size="sm">No medicines found on this prescription.</Text> : (
                        <Table highlightOnHover={false}>
                          <Table.Thead><Table.Tr><Table.Th w={40} /><Table.Th>Prescribed medicine</Table.Th><Table.Th>Product</Table.Th><Table.Th ta="right">Stock</Table.Th>
                            <Table.Th ta="right">Rate</Table.Th><Table.Th ta="right">MRP</Table.Th><Table.Th w={100} ta="right">Qty</Table.Th></Table.Tr></Table.Thead>
                          <Table.Tbody>
                            {(r.medications ?? []).map((m, i) => {
                              const q = medsOf(r)[i + 1]
                              return (
                                <Table.Tr key={i} opacity={m.available ? 1 : 0.7}>
                                  <Table.Td><Checkbox aria-label={`Load ${m.medication_name}`} disabled={!m.available} checked={q !== false}
                                    onChange={(e) => setMed(r, i + 1, e.currentTarget.checked ? '1' : false)} /></Table.Td>
                                  <Table.Td><Text size="sm">{m.medication_name}</Text><Text size="xs" c="dimmed">{[m.dosage, m.frequency, m.duration].filter(Boolean).join(', ') || 'Take as directed'}</Text></Table.Td>
                                  <Table.Td><Text size="sm">{m.item_name || 'Not in the product list'}</Text><Text size="xs" c="dimmed">{[m.generic_name, m.hsn_code && `HSN ${m.hsn_code}`].filter(Boolean).join(', ')}</Text></Table.Td>
                                  <Table.Td ta="right">{plain(m.available_quantity)}</Table.Td>
                                  <Table.Td ta="right">{m.selling_price_cents == null ? '--' : money(m.selling_price_cents)}</Table.Td>
                                  <Table.Td ta="right">{m.unit_mrp_cents == null ? '--' : money(m.unit_mrp_cents)}</Table.Td>
                                  <Table.Td><NumberInput aria-label="Quantity" size="xs" min={0} hideControls disabled={q === false || !m.available} value={q === false ? '1' : q}
                                    onChange={(v) => setMed(r, i + 1, Number(v) > 0 ? String(v) : '1')} styles={{ input: { textAlign: 'right' } }} /></Table.Td>
                                </Table.Tr>
                              )
                            })}
                          </Table.Tbody>
                        </Table>
                      )}
                    </Table.Td>
                  </Table.Tr>
                )}
              </Fragment>
            ))}
          </Table.Tbody>
        </Table>
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="space-between" pos="sticky" bottom={0} bg="white" py="sm">
          <Text size="sm">{row ? `Selected ${row.prescription_number || 'prescription'}: ${count(row)} medicine(s) to load` : 'No prescription selected'}</Text>
          <Button disabled={!row} loading={loading} onClick={load}>Load selected</Button>
        </Group>
      </Stack>
    </SidePanel>
  )
}
