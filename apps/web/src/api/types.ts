/**
 * Document types mirroring the backend Pydantic models (bpt/document/model.py,
 * bpt/library/symbols.py). Written by hand because the generated OpenAPI types mark
 * fields with defaults as optional, while the backend always sends them.
 */

export type Point = [number, number]
export type Rotation = 0 | 90 | 180 | 270

export interface ModelRef {
  kind: 'builtin'
  model: string | null
  params: Record<string, string>
  /** Subcircuit model: symbol pins in the order of its pins ("=VCC" ties one to a net). */
  pins?: string[] | null
  variant?: string | null // one of the symbol's variants
}

export interface Instance {
  id: string
  ref: string
  symbol: string
  model: ModelRef
  at: Point
  rot: Rotation
  mirror: boolean
  look?: string | null // drawing of the symbol; null = as the IEC / ANSI setting asks
  ratings?: Record<string, string> // rated values of an ideal part (stress analysis)
  texts?: Partial<Record<TextField, TextPlace>> // reference / value moved or turned by hand
}

export type TextField = 'ref' | 'value'
/** A part's text put by hand: offset from the part's origin (sheet axes), 90 = read upwards. */
export interface TextPlace {
  at: Point
  rot: 0 | 90
}

/** One rating checked against a run (GET /projects/{id}/runs/{run}/stress). */
export interface StressItem {
  ref: string
  instance_id: string
  sheet: string
  quantity: 'voltage' | 'current' | 'isat' | 'power' | 'temperature'
  value: number
  rating: number
  limit: number // the rating with the project's margin
  unit: string
  usage: number // percent of the rating
  status: 'ok' | 'margin' | 'over'
  message: string
}

export interface StressReport {
  items: StressItem[]
  notes: string[]
}

/** Stress analysis margins (FR-SIM-7): percent of each rating a design may use. */
export interface StressRules {
  voltage: number
  current: number
  power: number
  temperature: number // kelvins below Tj max
  ambient: number // °C
}

export interface Wire {
  id: string
  points: Point[]
  bus?: boolean // drawn thick; members connect through labels of their names
}

export interface Junction {
  id: string
  at: Point
}

export type LabelKind = 'local' | 'global' | 'port' // port: hierarchical label (block pin)

export interface Label {
  id: string
  kind: LabelKind
  text: string
  at: Point
  rot: Rotation
}

export interface Directive {
  id: string
  text: string
  at: Point
}

export type PortSide = 'left' | 'right' | 'top' | 'bottom'

export interface Sheet {
  id: string
  name: string
  instances: Instance[]
  wires: Wire[]
  junctions: Junction[]
  labels: Label[]
  directives: Directive[]
  parameters?: Record<string, string> // defaults of the sheet as a block
  port_sides?: Record<string, PortSide> // block pins: side per port
  port_order?: string[]
  symbol?: SymbolDef | null // drawn block symbol (pin numbers = port names); null = automatic box
  component?: ComponentInfo | null // top sheet of a placed library component
  owner?: string | null // the component id on all its sheets: hidden and read-only
  form?: TemplateFieldDef[] // the sheet drawn as a template: the form of its parameters
}

export interface TemplateFieldDef {
  key: string
  label: string
  unit: string
  default: string
  description: string
  required: boolean
  minimum?: string // lowest value the form accepts ("" = any)
  maximum?: string
  group?: string // heading the form shows it under
  help?: string // more for the parameter's card
}

export type ComponentKind =
  | 'resistor'
  | 'capacitor'
  | 'inductor'
  | 'transformer'
  | 'diode'
  | 'transistor'
  | 'ic'
  | 'module'
  | 'other'

/** What makes a block a real part (FR-CMP). */
export interface ComponentInfo {
  id: string // cmp:<library>/<name>
  name: string
  kind: ComponentKind
  description: string
  metadata: Record<string, string>
  ratings: Record<string, string>
  version: number
  updated: string
  changes: string
  template?: TemplateRef | null // the equivalent-circuit template and its form values
  characteristics?: Characteristic[] // source points (datasheet, measurement)
}

/** Points of a characteristic: |Z|(f), phase(f), ESR(f), C(V), L(I). */
export interface Characteristic {
  name: string
  x_unit?: string
  y_unit?: string
  points: [number, number][]
  source?: string
  weights?: number[] // per point in a fit (empty: all 1; 0 = shown, not fitted)
  scale?: 'log' | 'lin' // errors relative to each point, or to the largest value
}

export interface TemplateRef {
  name: string
  values: Record<string, string>
}

export interface ModelCard {
  type: string
  params: Record<string, string>
  source?: string
  original?: string
}

/** A device model written as a subcircuit (manufacturer op-amp, MOSFET, ...). */
export interface SubcktModel {
  pins: string[]
  params: Record<string, string>
  body: string[]
  source?: string
  original?: string
  notes?: string[]
}

export interface Project {
  schema_version: number
  id: string
  name: string
  sheets: Sheet[]
  parameters: Record<string, string>
  models: Record<string, ModelCard>
  simulation: Simulation
  graphs: Graph[]
  symbols?: Record<string, SymbolDef> // copies of library symbols used in the project
  linked?: string[] // library symbols used by reference: their copies follow the library
  looks?: Record<string, Look[]> // copies of user drawings used here, by the symbol they are for
  default_looks?: Record<string, string> // drawing new parts of a symbol get in this project
  symbol_standard?: 'iec' | 'ansi' | null // null: as the program's setting
  subcircuits?: Record<string, SubcktModel> // subcircuit models
  stress?: StressRules // margins of the stress analysis
}

export type Orientation = 'left' | 'right' | 'up' | 'down'

export interface Pin {
  number: string
  name: string
  at: Point
  length: number
  orientation: Orientation
  type: string
  implicit_net?: string | null // hidden power pin: joins the global net of this name
}

export type Graphic =
  | { kind: 'polyline'; points: Point[]; fill: boolean }
  | { kind: 'rect'; start: Point; end: Point; fill: boolean }
  | { kind: 'circle'; center: Point; radius: number; fill: boolean }
  | { kind: 'arc'; start: Point; mid: Point; end: Point }
  | { kind: 'text'; at: Point; text: string; size: number }

export interface SymbolDef {
  id: string
  name: string
  description: string
  ref_prefix: string
  pins: Pin[]
  graphics: Graphic[]
  spice: { element: string; nodes: string[] } | null
  power_net: string | null
  default_params: Record<string, string>
  default_model: string | null
  category: string
  ref_at: Point | null
  value_at: Point | null
  value_param: string | null
  parasitics: Parasitic[]
  variants?: Variant[] // other ways to simulate the part; the first is the default
  looks?: Look[] // other drawings with the same pins (ANSI, electrolytic...)
  version?: number // library version (a project copy keeps the one it was copied at)
  updated?: string // date of that version
  changes?: string // what changed in it
  kind?: string | null // a component's kind
  group?: string | null // category path in the library (Capacitors/Ceramic); null = not simulated
  metadata?: Record<string, string> // a library part's data (manufacturer, dielectric, package...)
  ratings?: Record<string, string> // its rated values (voltage, current, power)
}

/** A library symbol the project keeps a copy of (GET /projects/{id}/library-parts). */
export interface LibraryPart {
  id: string
  name: string
  library: string
  version: number
  library_version: number | null // null: no longer in any library
  updated: string
  changes: string
  linked: boolean // follows the library instead of a plain copy
  used: number
}

export interface Look {
  name: string
  label: string
  standard: 'iec' | 'ansi' | null // drawn automatically when this standard is chosen
  signal?: string | null // drawn automatically for a source with this waveform (SIN, PULSE)
  default?: boolean // a user drawing new parts get in every project
  graphics: Graphic[]
}

export interface Variant {
  name: string
  label: string
  description: string
  faster?: boolean // a simplified model, offered when a run takes long
  spice: { element: string; nodes: string[] }
  default_model: string | null
  default_params: Record<string, string>
}

/** The symbol as simulated with one of its variants (unknown / none: as it is). */
export function withVariant(symbol: SymbolDef, name: string | null | undefined): SymbolDef {
  const variant = symbol.variants?.find((v) => v.name === name)
  if (!variant) return symbol
  return {
    ...symbol,
    spice: variant.spice,
    default_model: variant.default_model,
    default_params: variant.default_params,
  }
}

/** A non-ideal property of a part (extra R, L or C in series / parallel), stored as a param. */
export interface Parasitic {
  key: string
  label: string
  element: 'R' | 'L' | 'C'
  connection: 'series' | 'parallel'
  unit: string
  description: string
}

export interface ProjectInfo {
  id: string
  name: string
  path: string | null
  revision: number
  dirty: boolean
  can_undo: boolean
  can_redo: boolean
}

/** Recovery copy of a project with unsaved changes, left by a crash or a backend restart. */
export interface RecoveryInfo {
  id: string
  name: string
  path: string | null
  saved_at: number // unix seconds
  revision: number
}

/** Copy of the project to go back to; "agent" ones are taken before an AI agent's changes. */
export interface SnapshotInfo {
  id: string
  label: string
  origin: 'agent' | 'user'
  created: number // unix seconds
  revision: number
}

export interface ErcIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  refs: string[]
}

/** Objects that can be selected and moved on a sheet. */
export type SheetObjectKind = 'instances' | 'wires' | 'junctions' | 'labels' | 'directives'

// -- commands (bpt/document/commands.py) ----------------------------------------------------

export type Command =
  | {
      type: 'add_objects'
      sheet: string
      instances?: Instance[]
      wires?: Wire[]
      junctions?: Junction[]
      labels?: Label[]
      directives?: Directive[]
    }
  | { type: 'remove_objects'; sheet: string; ids: string[] }
  | { type: 'move_objects'; sheet: string; ids: string[]; dx: number; dy: number }
  | {
      type: 'update_instance'
      sheet: string
      id: string
      ref?: string
      symbol?: string
      at?: Point
      rot?: Rotation
      mirror?: boolean
      look?: string // "" = as the IEC / ANSI setting asks
      ratings?: Record<string, string> // replaced as a whole
      texts?: Partial<Record<TextField, TextPlace>> // replaced as a whole ({} = automatic)
    }
  | { type: 'set_stress_rules'; rules: StressRules }
  | {
      type: 'set_params'
      sheet: string
      id: string
      params: Record<string, string | null>
      model?: string | null
      pins?: string[] | null
      variant?: string | null
    }
  | { type: 'set_wire_points'; sheet: string; id: string; points: Point[] }
  | {
      type: 'update_label'
      sheet: string
      id: string
      text?: string
      kind?: LabelKind
      at?: Point
      rot?: Rotation
    }
  | { type: 'update_directive'; sheet: string; id: string; text?: string; at?: Point }
  | { type: 'set_symbol'; id: string; symbol: SymbolDef | null }
  | { type: 'set_model'; name: string; card: ModelCard | null }
  | { type: 'set_subcircuit'; name: string; subckt: SubcktModel | null }
  | { type: 'set_port_layout'; sheet: string; sides: Record<string, PortSide>; order: string[] }
  | { type: 'set_sheet_form'; sheet: string; form: TemplateFieldDef[] }
  | { type: 'set_default_look'; symbol: string; look: string | null }
  | { type: 'set_symbol_standard'; standard: 'iec' | 'ansi' | null }
  | { type: 'set_parameter'; name: string; value: string | null; sheet?: string | null }
  | { type: 'set_simulation'; simulation: Simulation }
  | { type: 'set_graph'; name: string; graph: Graph | null }
  | { type: 'add_sheet'; sheet: Sheet; index?: number | null }
  | { type: 'remove_sheet'; name: string }
  | { type: 'rename_sheet'; name: string; new_name: string }
  | { type: 'set_sheet_symbol'; sheet: string; symbol: SymbolDef | null }
  | { type: 'set_symbol_link'; id: string; linked: boolean }
  | { type: 'set_project_look'; symbol: string; name: string; look: Look | null }
  | { type: 'detach_component'; owner: string }
  | { type: 'restore_project'; label?: string; project: Project }
  | { type: 'transaction'; label?: string; commands: Command[] }

// -- analysis graphs (node.md) -------------------------------------------------------------

export interface GraphNode {
  id: string
  type: string
  version?: number // of its type's parameters when it was made
  title?: string // the user's name for it ("" = the type's)
  bypass?: boolean // switched off: its input passed on, else its branch skipped
  pos: [number, number]
  size: [number, number] | null
  params: Record<string, string | number | boolean>
  param_inputs?: string[] // parameters turned into scalar input sockets (widget -> input)
}

export interface GraphGroup {
  id: string
  title: string
  color: string
  rect: [number, number, number, number] // x, y, width, height
}

export interface GraphNote {
  id: string
  text: string
  pos: [number, number]
  size?: [number, number] | null
}

export interface GraphReroute {
  id: string
  pos: [number, number]
}

export interface GraphEdge {
  source: string
  output: string
  target: string
  input: string
}

export interface Graph {
  name: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  groups?: GraphGroup[]
  notes?: GraphNote[]
  reroutes?: GraphReroute[]
  subgraphs?: Record<string, unknown>
}

export type SocketType = 'circuit' | 'params' | 'run' | 'signal' | 'scalar' | 'value' | 'table'

export interface Socket {
  name: string
  type: SocketType
  label: string
  multi: boolean
  optional: boolean
}

export interface NodeParam {
  name: string
  kind: 'text' | 'quantity' | 'choice' | 'choices' | 'int' | 'bool' | 'expr'
  label: string
  default: string | number | boolean
  unit: string
  options: string[]
  placeholder: string
  advanced?: boolean // shown in the inspector only
}

export interface NodeTypeInfo {
  type: string
  title: string
  category: string
  description: string
  inputs: Socket[]
  outputs: Socket[]
  params: NodeParam[]
  view: '' | 'plot' | 'value' | 'table' | 'histogram' | 'spec' | 'equation'
  version?: number // of its parameters (a new node is made at it)
  /** One output per item of a "choices" parameter (comma-separated), after the first `skip`. */
  dynamic_outputs?: { param: string; type: SocketType; skip: number } | null
}

export type NodeStatus = 'running' | 'ok' | 'cached' | 'error' | 'blocked' | 'skipped'

export interface NodeState {
  status: NodeStatus
  error: string | null
  duration_s: number
  summary: string[]
  from_disk?: boolean // results of an earlier session (the disk cache)
}

export interface GraphResults {
  status: 'idle' | 'running' | 'done'
  nodes: Record<string, NodeState>
}

export interface PlotSeries {
  name: string
  family: string // sweep point ("R=2k") of a family member, '' otherwise
  x_name: string
  x_unit: string
  unit: string
  x: number[]
  min: number[] | null
  max: number[] | null
  re: number[] | null
  im: number[] | null
}

export interface ScalarInfo {
  name: string
  family: string
  value: number
  unit: string
  phase_deg: number | null
  socket?: string // the input it came in by
}

// -- simulation ----------------------------------------------------------------------------

export type AnalysisKind = 'op' | 'dc' | 'ac' | 'tran'

export interface Simulation {
  active: AnalysisKind
  cards: Record<string, string>
  temperature?: string // °C; "" = 27 °C
  options?: Record<string, string> // .options for every analysis started from Simulate
}

/** Several curves in one run (DC sweep with a second source): blocks of `length` points. */
export interface RunFamily {
  name: string // what the second sweep varies: "IB", "R2", "TEMP"
  unit: string
  values: number[]
  length: number
}

export interface SignalInfo {
  name: string
  unit: string
  complex: boolean
  file: string
}

export interface RunMeta {
  run_id: string
  created: string
  analysis: { kind: AnalysisKind } & Record<string, unknown>
  engine: string
  engine_version: string
  status: 'ok' | 'error' | 'cancelled'
  error: string | null
  duration_s: number
  scale: string | null
  points: number
  signals: SignalInfo[]
  family?: RunFamily | null
  log: string[]
  messages: LogMessage[]
}

export interface LogMessage {
  severity: 'error' | 'warning' | 'info'
  text: string
  refs: string[] // schematic parts the line mentions
  nets: string[]
  count: number
}

export interface JobInfo {
  job_id: string
  project_id: string
  status: 'queued' | 'running' | 'ok' | 'error' | 'cancelled'
  run_id: string | null
  progress: string
  error: string | null
  issues: ErcIssue[]
}

export interface SheetNets {
  wires: Record<string, string>
  labels: Record<string, string>
  pins: Record<string, string> // "<instance id>:<pin>" -> net
}

/** Plot data from /runs/{id}/query (JSON). Real series: min/max; complex: re/im. */
export interface QueryResult {
  x: number[]
  series: Record<
    string,
    {
      min?: number[]
      max?: number[]
      re?: number[]
      im?: number[]
      members?: { min: number[]; max: number[] }[] // a family run: one curve per member
    }
  >
  family?: RunFamily
}
