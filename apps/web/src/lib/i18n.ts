/**
 * Minimal i18n: every UI string goes through t(key). English only for now (D13);
 * add a dictionary per language later without touching components.
 */

const en = {
  'app.title': 'BiasPoint',
  'workspace.schematic': 'Schematic',
  'workspace.simulate': 'Simulate',
  'workspace.analysis': 'Analysis',
  'panel.library': 'Library',
  'panel.properties': 'Properties',
  'panel.problems': 'Problems',
  'panel.console': 'Console',
  'panel.schematic': 'Schematic',
  'menu.file': 'File',
  'menu.edit': 'Edit',
  'menu.view': 'View',
  'menu.help': 'Help',
  'status.connected': 'Backend connected',
  'status.disconnected': 'Backend offline',
  'library.search': 'Search parts…',
  'properties.none': 'Nothing selected',
  'properties.multiple': '{count} objects selected',
  'problems.none': 'No problems',
  'console.placeholder': 'SPICE line (R1 in out 1k), or: undo, redo, fit, help',
} as const

export type MessageKey = keyof typeof en

export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  return en[key].replace(/\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? ''))
}
