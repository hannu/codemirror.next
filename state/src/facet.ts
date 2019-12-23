import {Transaction} from "./transaction"
import {EditorState} from "./state"

let nextID = 0

export function computedFacet<T>(facet: Facet<T, any>, depends: readonly Slot[],
                                 get: (state: EditorState) => T): Extension {
  let data = FacetData.get(facet)
  if (data.isStatic) throw new Error("Can't compute a static facet")
  return new FacetProvider<T>(depends, data, Provider.Single, get)
}

export function computedFacetN<T>(facet: Facet<T, any>, depends: readonly Slot[],
                                  get: (state: EditorState) => readonly T[]): Extension {
  let data = FacetData.get(facet)
  if (data.isStatic) throw new Error("Can't compute a static facet")
  return new FacetProvider<T>(depends, data, Provider.Multi, get)
}

export type FacetConfig<Input, Output> = {
  combine?: (value: readonly Input[]) => Output,
  compare?: (a: Output, b: Output) => boolean,
  compareInput?: (a: Input, b: Input) => boolean,
  static?: boolean
}

export function defineFacet<Input, Output = readonly Input[]>(config: FacetConfig<Input, Output> = {}): Facet<Input, Output> {
  let data = new FacetData<Input, Output>(config.combine || ((a: any) => a) as any,
                                          config.compareInput || ((a, b) => a === b),
                                          config.compare || (!config.combine ? sameArray as any : (a, b) => a === b),
                                          !!config.static)
  let facet = function(value: Input) {
    return new FacetProvider<Input>([], data, Provider.Static, value)
  }
  ;(facet as any)._data = data
  return facet
}

export type Facet<Input, Output> = (value: Input) => Extension

export class FacetData<Input, Output> {
  readonly id = nextID++
  readonly default: Output

  constructor(
    readonly combine: (values: readonly Input[]) => Output,
    readonly compareInput: (a: Input, b: Input) => boolean,
    readonly compare: (a: Output, b: Output) => boolean,
    readonly isStatic: boolean
  ) {
    this.default = combine([])
  }

  static get<Input, Output>(f: Facet<Input, Output>): FacetData<Input, Output> {
    let value = (f as any)._data
    if (!value) throw new Error("No facet data for function " + f)
    return value
  }
}

function sameArray<T>(a: readonly T[], b: readonly T[]) {
  return a == b || a.length == b.length && a.every((e, i) => e === b[i])
}

type Slot = Facet<any, any> | StateField<any> | "doc" | "selection"

/// Marks a value as an [`Extension`](#state.Extension).
declare const isExtension: unique symbol

const enum Provider { Static, Single, Multi }

class FacetProvider<Input> {
  readonly id = nextID++

  constructor(readonly dependencies: readonly Slot[],
              readonly facet: FacetData<Input, any>,
              readonly type: Provider,
              readonly value: ((state: EditorState) => Input) | ((state: EditorState) => readonly Input[]) | Input) {}

  dynamicSlot(addresses: {[id: number]: number}) {
    let getter: (state: EditorState) => any = this.value as any
    let compare = this.facet.compareInput
    let idx = addresses[this.id] >> 1
    let depDoc = false, depSel = false, depAddrs: number[] = []
    for (let dep of this.dependencies) {
      if (dep == "doc") depDoc = true
      else if (dep == "selection") depSel = true
      else {
        let id = dep instanceof StateField ? dep.id : FacetData.get(dep).id
        if ((addresses[id] & 1) == 0) depAddrs.push(addresses[id])
      }
    }

    return (state: EditorState, tr: Transaction | null) => {
      if (!tr || tr.reconfigured) {
        state.values[idx] = getter(state)
        return SlotStatus.Changed
      } else {
        let newVal
        let depChanged = (depDoc && tr!.docChanged) || (depSel && (tr!.docChanged || tr!.selectionSet)) || 
          depAddrs.some(addr => (ensureAddr(state, addr) & SlotStatus.Changed) > 0)
        if (!depChanged || compare(newVal = getter(state), tr!.startState.values[idx])) return 0
        state.values[idx] = newVal
        return SlotStatus.Changed
      }
    }
  }

  [isExtension]!: true
}

function dynamicFacetSlot<Input, Output>(
  addresses: {[id: number]: number},
  facet: FacetData<Input, Output>,
  providers: readonly FacetProvider<Input>[]
) {
  let providerAddrs = providers.map(p => addresses[p.id])
  let providerTypes = providers.map(p => p.type)
  let dynamic = providerAddrs.filter(p => !(p & 1))
  let idx = addresses[facet.id] >> 1

  return (state: EditorState, tr: Transaction | null) => {
    let oldAddr = !tr ? null : tr.reconfigured ? tr.startState.config.address[facet.id] : idx << 1
    let changed = oldAddr == null
    for (let dynAddr of dynamic) {
      if (ensureAddr(state, dynAddr) & SlotStatus.Changed) changed = true
    }
    if (!changed) return 0
    let values: Input[] = []
    for (let i = 0; i < providerAddrs.length; i++) {
      let value = getAddr(state, providerAddrs[i])
      if (providerTypes[i] == Provider.Multi) for (let val of value) values.push(val)
      else values.push(value)
    }
    let newVal = facet.combine(values)
    if (oldAddr != null && facet.compare(newVal, getAddr(tr!.startState, oldAddr))) return 0
    state.values[idx] = newVal
    return SlotStatus.Changed
  }
}

/// Parameters passed when creating a
/// [`StateField`](#state.StateField^define). The `Value` type
/// parameter refers to the content of the field. Since it will be
/// stored in (immutable) state objects, it should be an immutable
/// value itself.
export type StateFieldSpec<Value> = {
  /// Creates the initial value for the field when a state is created.
  create: (state: EditorState) => Value,

  /// Compute a new value from the field's previous value and a
  /// [transaction](#state.Transaction).
  update: (value: Value, transaction: Transaction, newState: EditorState) => Value,

  /// Compare two values of the field, returning `true` when they are
  /// the same. This is used to avoid recomputing facets that depend
  /// on the field when its value did not change.
  compare?: (a: Value, b: Value) => boolean,
}

/// Fields can store additional information in an editor state, and
/// keep it in sync with the rest of the state.
export class StateField<Value> {
  private constructor(
    /// @internal
    readonly id: number,
    private createF: (state: EditorState) => Value,
    private updateF: (value: Value, tr: Transaction, state: EditorState) => Value,
    private compareF: (a: Value, b: Value) => boolean,
    /// @internal
    readonly facets: readonly Extension[]
  ) {}

  /// Define a state field.
  static define<Value>(config: StateFieldSpec<Value>): StateField<Value> {
    return new StateField<Value>(nextID++, config.create, config.update, config.compare || ((a, b) => a === b), [])
  }

  provide(facet: Facet<Value, any>): StateField<Value>
  provide<T>(facet: Facet<T, any>, get: (value: Value) => T, prec?: Precedence): StateField<Value>
  provide<T>(facet: Facet<T, any>, get?: (value: Value) => T, prec?: Precedence) {
    let provider = computedFacet(facet, [this], get ? state => get(state.field(this)) : state => state.field(this) as any)
    return new StateField(this.id, this.createF, this.updateF, this.compareF, this.facets.concat(maybePrec(prec, provider)))
  }

  provideN<T>(facet: Facet<T, any>, get: (value: Value) => readonly T[], prec?: Precedence): StateField<Value> {
    let provider = computedFacetN(facet, [this], state => get(state.field(this)))
    return new StateField(this.id, this.createF, this.updateF, this.compareF, this.facets.concat(maybePrec(prec, provider)))
  }

  slot(addresses: {[id: number]: number}) {
    let idx = addresses[this.id] >> 1
    return (state: EditorState, tr: Transaction | null) => {
      let oldIdx = !tr ? null : tr.reconfigured ? tr.startState.config.address[this.id] >> 1 : idx
      if (oldIdx == null) {
        state.values[idx] = this.createF(state)
        return SlotStatus.Changed
      } else {
        let oldVal = tr!.startState.values[oldIdx], value = this.updateF(oldVal, tr!, state)
        if (this.compareF(oldVal, value)) return 0
        state.values[idx] = value
        return SlotStatus.Changed
      }
    }
  }

  [isExtension]!: true
}

export type Extension = {[isExtension]: true} | readonly Extension[]

type DynamicSlot = (state: EditorState, tr: Transaction | null) => number

export class Precedence {
  private constructor(
    // @internal
    readonly val: number
  ) {}

  static Fallback = new Precedence(3)
  static Default = new Precedence(2)
  static Extend = new Precedence(1)
  static Override = new Precedence(0)

  set(extension: Extension) {
    return new PrecExtension(extension, this.val)
  }
}

function maybePrec(prec: Precedence | undefined, ext: Extension) {
  return prec == null ? ext : prec.set(ext)
}

class PrecExtension {
  constructor(readonly e: Extension, readonly prec: number) {}
  [isExtension]!: true
}

export class Configuration {
  readonly statusTemplate: SlotStatus[] = []

  constructor(readonly dynamicSlots: DynamicSlot[],
              readonly address: {[id: number]: number},
              readonly staticValues: readonly any[]) {
    while (this.statusTemplate.length < staticValues.length)
      this.statusTemplate.push(SlotStatus.Uninitialized)
  }

  staticFacet<Output>(facet: Facet<any, Output>) {
    let data = FacetData.get(facet), addr = this.address[data.id]
    return addr == null ? data.default : this.staticValues[addr >> 1]
  }

  // Passing EditorState as argument to avoid cyclic dependency
  static resolve(extension: Extension, oldState?: EditorState) {
    let fields: StateField<any>[] = []
    let facets: {[id: number]: FacetProvider<any>[]} = Object.create(null)
    for (let ext of flatten(extension)) {
      if (ext instanceof StateField) fields.push(ext)
      else (facets[ext.facet.id] || (facets[ext.facet.id] = [])).push(ext)
    }

    let address: {[id: number]: number} = Object.create(null)
    let staticValues: any[] = []
    let dynamicSlots: ((address: {[id: number]: number}) => DynamicSlot)[] = []
    for (let field of fields) {
      address[field.id] = dynamicSlots.length << 1
      dynamicSlots.push(a => field.slot(a))
    }
    for (let id in facets) {
      let providers = facets[id], facet = providers[0].facet
      if (providers.every(p => p.type == Provider.Static)) {
        address[facet.id] = (staticValues.length << 1) | 1
        let value = facet.combine(providers.map(p => p.value))
        let oldAddr = oldState ? oldState.config.address[facet.id] : null
        if (oldAddr != null) {
          let oldVal = getAddr(oldState!, oldAddr)
          if (facet.compare(value, oldVal)) value = oldVal
        }
        staticValues.push(value)
      } else {
        for (let p of providers) {
          if (p.type == Provider.Static) {
            address[p.id] = (staticValues.length << 1) | 1
            staticValues.push(p.value)
          } else {
            address[p.id] = dynamicSlots.length << 1
            dynamicSlots.push(a => p.dynamicSlot(a))
          }
        }
        address[facet.id] = dynamicSlots.length << 1
        dynamicSlots.push(a => dynamicFacetSlot(a, facet, providers))
      }
    }

    return new Configuration(dynamicSlots.map(f => f(address)), address, staticValues)
  }
}

function flatten(extension: Extension) {
  let result: (FacetProvider<any> | StateField<any>)[][] = [[], [], [], []]
  let seen = new Set<Extension>()
  ;(function inner(ext, prec: number) {
    if (seen.has(ext)) return
    seen.add(ext)
    if (Array.isArray(ext)) {
      for (let e of ext) inner(e, prec)
    } else if (ext instanceof PrecExtension) {
      inner(ext.e, ext.prec)
    } else {
      result[prec].push(ext as any)
      if (ext instanceof StateField) inner(ext.facets, prec)
    }
  })(extension, Precedence.Default.val)
  return result.reduce((a, b) => a.concat(b))
}

export const enum SlotStatus {
  Uninitialized = 0,
  Changed = 1,
  Computed = 2,
  Computing = 4
}

export function ensureAddr(state: EditorState, addr: number) {
  if (addr & 1) return SlotStatus.Computed
  let idx = addr >> 1
  let status = state.status[idx]
  if (status == SlotStatus.Computing) throw new Error("Cyclic dependency between fields and/or facets")
  if (status & SlotStatus.Computed) return status
  state.status[idx] = SlotStatus.Computing
  let changed = state.config.dynamicSlots[idx](state, state.applying)
  return state.status[idx] = SlotStatus.Computed | changed
}

export function getAddr(state: EditorState, addr: number) {
  return addr & 1 ? state.config.staticValues[addr >> 1] : state.values[addr >> 1]
}