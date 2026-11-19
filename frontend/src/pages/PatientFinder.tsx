/** Finding a patient, the same way on Receipt Entry, Patient Bills and Patient Advance. The patient chosen is kept in
 * the address, so moving between those three screens keeps the same patient. */
import { Button, Group, Paper, SegmentedControl, Text, TextInput } from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { api } from '../api'
import { Facts, money, notifyFailure } from '../ui'

export type Lookup = Record<string, string>
const KEYS = ['patient_id', 'mrn', 'visit_number', 'sales_document_id', 'q']

/** The patient named in the address (?patient_id= | ?mrn= | ?visit_number= | ?sales_document_id= | ?q=), and a way to name another. */
export function usePatientAddress(): [Lookup | null, (lookup: Lookup) => void] {
  const [address, setAddress] = useSearchParams()
  const key = KEYS.find((k) => address.get(k))
  return [key ? { [key]: address.get(key)! } : null, (lookup) => setAddress(lookup)]
}

interface Match { name: string; mrn?: string; phone?: string; bill_count: number; visit_number?: string; owed_cents: number; matched_by_fallback?: boolean; patient_id?: number }

/** Visit no., MRN, or name and phone; a name finds a list of patients to choose from. */
export function PatientFinder({ onPick }: { onPick: (lookup: Lookup) => void }) {
  const [by, setBy] = useState('visit_number')
  const [q, setQ] = useState('')
  const [matches, setMatches] = useState<Match[] | null>(null)
  async function search() {
    const text = q.trim()
    if (text.length < 2) return
    setMatches(null)
    if (by !== 'q') return onPick({ [by]: text })
    try { setMatches((await api<{ patients: Match[] }>(`/pharmacy/api/patients/search?q=${encodeURIComponent(text)}`)).patients) }
    catch (e) { notifyFailure(e as Error) }
  }
  return (
    <>
      <Group align="end">
        <SegmentedControl value={by} onChange={(v) => { setBy(v); setQ(''); setMatches(null) }}
          data={[{ value: 'visit_number', label: 'Visit no.' }, { value: 'mrn', label: 'MRN' }, { value: 'q', label: 'Name or phone' }]} />
        <TextInput aria-label="Find patient" placeholder={{ visit_number: 'Visit no.', mrn: 'MRN', q: 'Name or phone' }[by]} w={260} value={q}
          onChange={(e) => setQ(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search() } }} />
        <Button variant="default" leftSection={<IconSearch size={16} />} onClick={search}>Search</Button>
      </Group>
      {matches && (
        <Paper withBorder p="sm">
          {!matches.length && <Text size="sm">No patients found.</Text>}
          {matches.map((m, i) => (
            <Group key={i} justify="space-between" py={4}>
              <div><Text size="sm" fw={500}>{m.name}</Text><Facts compact items={[...(m.mrn ? [{ label: 'MRN', value: m.mrn }] : []), ...(m.phone ? [{ label: 'Phone', value: m.phone }] : []),
                { label: 'Bills', value: m.bill_count }, ...(m.visit_number ? [{ label: 'Visit no.', value: m.visit_number }] : []),
                ...(m.matched_by_fallback ? [{ label: 'Matched by', value: 'name and phone' }] : [])]} /></div>
              <Group><Facts items={[{ label: 'Balance due', value: money(m.owed_cents) }]} />
                <Button size="xs" variant="default" onClick={() => { setMatches(null); onPick(m.patient_id ? { patient_id: String(m.patient_id) } : m.mrn ? { mrn: m.mrn } : { q: m.name }) }}>Choose</Button></Group>
            </Group>
          ))}
        </Paper>
      )}
    </>
  )
}

const SCREENS = [['bills', 'Bills', '/accounts/patient-bills'], ['advance', 'Advance', '/accounts/patient-advance'], ['receipt', 'Take payment', '/accounts/receipt-entry']] as const

/** The same patient on the other two patient screens. */
export function PatientLinks({ lookup, here }: { lookup: Lookup | null; here: (typeof SCREENS)[number][0] }) {
  if (!lookup) return null
  return (
    <>
      {SCREENS.filter(([key]) => key !== here).map(([key, label, path]) => (
        <Button key={key} variant="default" component={Link} to={`${path}?${new URLSearchParams(lookup)}`}>{label}</Button>
      ))}
    </>
  )
}
