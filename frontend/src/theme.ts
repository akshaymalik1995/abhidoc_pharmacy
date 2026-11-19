import {
  Badge, Button, createTheme, defaultVariantColorsResolver, Paper, Table, type ButtonVariant, type CSSVariablesResolver,
  type MantineColorsTuple,
} from '@mantine/core'

// Every action in the app is one of three buttons, and each has a border or a fill:
//   filled  - the main action of a page, form or dialog
//   default - any other action (white with a border)
//   danger  - an action that drops or sends back something (white, red border, red words)
// The borderless "subtle" style is not used for actions; only real links are text.
declare module '@mantine/core' {
  export interface ButtonProps {
    variant?: ButtonVariant | 'danger'
  }
}

// The one place the look of every screen is decided. Screens never set colours or fonts.

/** Bottle green: the dark glass of a dispensary bottle. */
const bottle: MantineColorsTuple = [
  '#EEF4F1', '#DCE8E2', '#B8D0C5', '#92B8A7', '#70A38E',
  '#56937B', '#2F6F5A', '#24594A', '#1B463A', '#12332A',
]
/** Amber: the other dispensary bottle. Used only for things that need attention. */
const amber: MantineColorsTuple = [
  '#FBF4E6', '#F5E6C8', '#EBCD92', '#E0B35B', '#D79E33',
  '#C98A1C', '#B7791F', '#946016', '#754B12', '#57370C',
]

/**
 * Secondary text (labels, column names, second lines in cells) and placeholders, for the whole app.
 * The library's own "dimmed" grey is too pale to read: these pass the 4.5 to 1 contrast rule on
 * white and on the page background. Pale grey is left for disabled controls only.
 */
export const cssVariables: CSSVariablesResolver = () => ({
  variables: {},
  light: { '--mantine-color-dimmed': '#48524D', '--mantine-color-placeholder': '#69736E' },
  dark: {},
})

export const theme = createTheme({
  colors: { bottle, amber },
  primaryColor: 'bottle',
  cursorType: 'pointer', // the hand over checkboxes, selects and every other control, not only buttons
  focusRing: 'auto', // a clear ring on keyboard focus, the same on every control
  variantColorResolver: (input) => {
    if (input.variant === 'danger') {
      return {
        background: 'var(--mantine-color-white)',
        hover: 'var(--mantine-color-red-1)',
        color: 'var(--mantine-color-red-7)',
        border: '1px solid var(--mantine-color-red-4)',
      }
    }
    const colors = defaultVariantColorsResolver(input)
    // a bordered button's hover is too faint to notice by default: tint it and darken its edge
    if (input.variant === 'default') return { ...colors, hover: 'var(--mantine-color-bottle-0)', border: '1px solid var(--mantine-color-gray-5)' }
    return colors
  },
  primaryShade: 6,
  fontFamily: '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
  headings: { fontFamily: '"IBM Plex Sans", system-ui, sans-serif', fontWeight: '600' },
  defaultRadius: 'sm',
  components: {
    Badge: Badge.extend({ defaultProps: { variant: 'light', radius: 'sm', tt: 'none', fw: 500 } }),
    Button: Button.extend({ defaultProps: { fw: 500 } }),
    Paper: Paper.extend({ defaultProps: { radius: 'md' } }),
    Table: Table.extend({
      defaultProps: { verticalSpacing: 6, horizontalSpacing: 'xs', highlightOnHover: true },
      styles: {
        table: { fontVariantNumeric: 'tabular-nums' },
        th: { fontWeight: 500, fontSize: 'var(--mantine-font-size-xs)', color: 'var(--mantine-color-dimmed)', whiteSpace: 'nowrap' },
      },
    }),
  },
})
