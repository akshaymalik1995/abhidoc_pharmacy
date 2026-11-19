import { ActionIcon, AppShell, Avatar, Box, Burger, Group, NavLink, ScrollArea, Select, Text, Tooltip } from '@mantine/core'
import { useDisclosure, useLocalStorage } from '@mantine/hooks'
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconMapPin, IconPrescription } from '@tabler/icons-react'
import { Link, Outlet, useLocation } from 'react-router-dom'

import { holds, NAV, trail, type NavItem } from './nav'
import { useMe, useWorkLocation } from './session'
import { EmptyState, PageHeader } from './ui'

function NavEntry({ item, path, onPick }: { item: NavItem; path: string; onPick: () => void }) {
  const Icon = item.icon
  const icon = Icon && <Icon size={18} stroke={1.6} />
  if (item.path) {
    return (
      <NavLink
        component={Link}
        to={item.path}
        label={item.label}
        leftSection={icon}
        active={holds(item, path)}
        variant="filled"
        c={item.built || holds(item, path) ? undefined : 'dimmed'}
        onClick={onPick}
      />
    )
  }
  return (
    <NavLink label={item.label} leftSection={icon} defaultOpened={holds(item, path)} childrenOffset={icon ? 28 : 12} fw={500}>
      {item.children?.map((child) => <NavEntry key={child.label} item={child} path={path} onPick={onPick} />)}
    </NavLink>
  )
}

export function Shell() {
  const { pathname } = useLocation()
  const [menuOpen, menu] = useDisclosure(false) // small screens: the menu slides over the page
  // wide screens: the menu can be put away to give tables the full width, and stays that way
  const [menuShown, setMenuShown] = useLocalStorage({ key: 'pharmacy-menu-shown', defaultValue: true })
  const MenuIcon = menuShown ? IconLayoutSidebarLeftCollapse : IconLayoutSidebarLeftExpand
  const me = useMe()
  const work = useWorkLocation()
  const initials = (me.data?.name ?? '').split(' ').map((word) => word[0]).slice(0, 2).join('')

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 264, breakpoint: 'sm', collapsed: { mobile: !menuOpen, desktop: !menuShown } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={menuOpen} onClick={menu.toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
            <Tooltip label={menuShown ? 'Hide menu' : 'Show menu'}>
              <ActionIcon variant="default" visibleFrom="sm" aria-label={menuShown ? 'Hide menu' : 'Show menu'}
                aria-expanded={menuShown} onClick={() => setMenuShown(!menuShown)}>
                <MenuIcon size={20} stroke={1.6} />
              </ActionIcon>
            </Tooltip>
            <IconPrescription size={24} color="var(--mantine-color-bottle-6)" />
            <Text fw={600}>Pharmacy</Text>
            {me.data?.hospital && <Text c="dimmed" size="sm" visibleFrom="sm">{me.data.hospital}</Text>}
          </Group>
          {me.data && (
            <Group gap="md" wrap="nowrap">
              <Select
                aria-label="Working location"
                leftSection={<IconMapPin size={16} />}
                data={work.locations}
                value={work.locationId}
                onChange={(value) => value && work.setLocationId(value)}
                allowDeselect={false}
                searchable
                size="xs"
                w={220}
                visibleFrom="sm"
              />
              <Avatar color="bottle" radius="xl" size="sm">{initials}</Avatar>
              <Text size="sm" visibleFrom="xs">{me.data.name}</Text>
            </Group>
          )}
        </Group>
      </AppShell.Header>

      <AppShell.Navbar bg="bottle.0">
        <AppShell.Section grow component={ScrollArea} p="xs">
          {NAV.map((item) => <NavEntry key={item.label} item={item} path={pathname} onPick={menu.close} />)}
        </AppShell.Section>
      </AppShell.Navbar>

      {/* exactly one window tall: a screen scrolls its own data, never the whole page */}
      <AppShell.Main bg="gray.0" h="100dvh" style={{ overflow: 'hidden' }}>
        <Box h="100%">
          <Outlet />
        </Box>
      </AppShell.Main>
    </AppShell>
  )
}

/** Any screen of the menu that has not been moved here yet. */
export function NotBuilt() {
  const { pathname } = useLocation()
  const here = trail(pathname)
  const screen = here.at(-1)
  return (
    <>
      <PageHeader title={screen?.label ?? 'Page not found'} />
      <EmptyState
        title={screen ? 'Not built yet' : 'There is no screen at this address.'}
        hint={screen ? `${here.map((item) => item.label).join(' / ')} is still in DocAssist.` : undefined}
      />
    </>
  )
}
