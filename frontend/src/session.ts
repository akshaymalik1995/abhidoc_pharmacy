import { useLocalStorage } from '@mantine/hooks'
import { useQuery } from '@tanstack/react-query'

import { api } from './api'
import type { components } from './api-types'

type Me = components['schemas']['Me']

/** Who is logged in. Asked once and kept. */
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me'), staleTime: Infinity })
}

/**
 * The stock location the user is working at, chosen in the top bar and remembered on this
 * computer. New documents are made at this location.
 */
export function useWorkLocation() {
  const me = useMe()
  const [stored, setStored] = useLocalStorage<string | null>({ key: 'pharmacy-work-location', defaultValue: null })
  const locations = me.data?.locations ?? []
  // a remembered location that no longer exists falls back to the first (a pharmacy counter)
  const locationId = locations.some((l) => l.value === stored) ? stored : (locations[0]?.value ?? null)
  return { locationId, locations, setLocationId: setStored }
}
