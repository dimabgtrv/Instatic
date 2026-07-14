import { nanoid } from 'nanoid'
import type { SiteDocument } from '@core/page-tree'
import {
  moveExplorerItem,
  reconcileSiteExplorerInPlace,
} from '@core/page-tree'
import type { VCNode, VCParam, VisualComponent } from '@core/visualComponents'
import { validateComponentName, validateParamName } from '@core/visualComponents'
import type { EditorStore } from '@site/store/types'
import type { SiteSliceHelpers } from './site/types'
import {
  VisualComponentNameError,
  VisualComponentParamNameError,
} from './vcTreeOps'

type GetState = () => EditorStore
type MutateSite = SiteSliceHelpers['mutateSite']

export interface UpsertComponentParamActionInput {
  paramId?: string
  name?: string
  type?: Exclude<VCParam['type'], 'slot'>
  defaultValue?: unknown
  required?: boolean
  description?: string
  enumOptions?: string[]
}

export interface ExposeComponentParamActionInput {
  name: string
  type: Exclude<VCParam['type'], 'slot'>
  defaultValue: unknown
  required?: boolean
  description?: string
  enumOptions?: string[]
}

export function placeComponentInExplorer(
  site: SiteDocument,
  componentId: string,
  folderId?: string,
): void {
  reconcileSiteExplorerInPlace(site)
  if (folderId) {
    const nextIndex = site.explorer.components.items.filter(
      (item) => item.parentFolderId === folderId,
    ).length
    moveExplorerItem(site.explorer, 'components', componentId, folderId, nextIndex)
  }
  reconcileSiteExplorerInPlace(site)
}

export function createVisualComponentAction(
  get: GetState,
  mutateSite: MutateSite,
  name: string,
  folderId?: string,
): string {
  const { site } = get()
  if (!site) throw new Error('[visualComponentsSlice] Site document is not initialized')
  const validation = validateComponentName(name, site.visualComponents ?? [])
  if (!validation.ok) throw new VisualComponentNameError(validation.reason, validation.error)
  if (folderId && !site.explorer.components.folders.some((folder) => folder.id === folderId)) {
    throw new Error(`Component folder not found: ${folderId}`)
  }

  const id = nanoid()
  const rootNodeId = nanoid()
  const rootNode: VCNode = {
    id: rootNodeId,
    moduleId: 'base.body',
    props: {},
    children: [],
    breakpointOverrides: {},
    classIds: [],
    parentId: null,
  }
  const newVC: VisualComponent = {
    id,
    name: name.trim(),
    tree: { nodes: { [rootNodeId]: rootNode }, rootNodeId },
    params: [],
    classIds: [],
    createdAt: Date.now(),
  }
  mutateSite((draft) => {
    draft.visualComponents.push(newVC)
    placeComponentInExplorer(draft, id, folderId)
    return true
  })
  return id
}

function canonicalParamDefault(
  type: Exclude<VCParam['type'], 'slot'>,
  enumOptions?: string[],
): unknown {
  if (type === 'number') return 0
  if (type === 'boolean') return false
  if (type === 'enum') return enumOptions?.[0] ?? ''
  return ''
}

function validateTypedParamDefault(
  type: Exclude<VCParam['type'], 'slot'>,
  value: unknown,
  enumOptions?: string[],
): void {
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Number component parameters require a finite numeric default value.')
  }
  if (type === 'boolean' && typeof value !== 'boolean') {
    throw new Error('Boolean component parameters require a boolean default value.')
  }
  if (!['number', 'boolean'].includes(type) && typeof value !== 'string') {
    throw new Error(`${type} component parameters require a string default value.`)
  }
  if (type === 'enum' && (!enumOptions || enumOptions.length === 0)) {
    throw new Error('Enum component parameters require at least one option.')
  }
  if (type === 'enum' && !enumOptions?.includes(value as string)) {
    throw new Error('Enum component parameter default must be one of its options.')
  }
}

export function upsertComponentParamAction(
  get: GetState,
  mutateSite: MutateSite,
  vcId: string,
  input: UpsertComponentParamActionInput,
): string {
  const vc = get().site?.visualComponents.find((candidate) => candidate.id === vcId)
  if (!vc) throw new Error(`Visual Component not found: ${vcId}`)
  const existing = input.paramId ? vc.params.find((param) => param.id === input.paramId) : undefined
  if (input.paramId && !existing) throw new Error(`Component parameter not found: ${input.paramId}`)
  if (!existing && (!input.name || !input.type)) throw new Error('Creating a component parameter requires name and type.')
  if (existing?.type === 'slot') throw new Error('Legacy slot parameters cannot be updated through this action.')
  if (existing && input.type && input.type !== existing.type) {
    throw new Error('Changing an existing component parameter type is not supported.')
  }

  const nextName = input.name ?? existing?.name ?? ''
  const nameValidation = validateParamName(nextName, vc.params, existing?.id)
  if (!nameValidation.ok) {
    throw new VisualComponentParamNameError(nameValidation.reason, nameValidation.error)
  }
  const nextType = (input.type ?? existing?.type) as Exclude<VCParam['type'], 'slot'>
  const nextEnumOptions = input.enumOptions ?? existing?.enumOptions
  const nextDefault = 'defaultValue' in input
    ? input.defaultValue
    : existing?.defaultValue ?? canonicalParamDefault(nextType, nextEnumOptions)
  validateTypedParamDefault(nextType, nextDefault, nextEnumOptions)

  const paramId = existing?.id ?? nanoid()
  mutateSite((site) => {
    const draftVc = site.visualComponents.find((candidate) => candidate.id === vcId)
    if (!draftVc) throw new Error(`Visual Component not found: ${vcId}`)
    const draftParam = draftVc.params.find((param) => param.id === paramId)
    if (!draftParam) {
      draftVc.params.push({
        id: paramId,
        name: nextName.trim(),
        type: nextType,
        defaultValue: nextDefault,
        required: input.required ?? false,
        ...(input.description ? { description: input.description } : {}),
        ...(nextType === 'enum' && nextEnumOptions ? { enumOptions: nextEnumOptions } : {}),
      })
      return true
    }

    let changed = false
    const patch = <K extends keyof VCParam>(key: K, value: VCParam[K]) => {
      if (!Object.is(draftParam[key], value)) {
        draftParam[key] = value
        changed = true
      }
    }
    patch('name', nextName.trim())
    if ('defaultValue' in input) patch('defaultValue', input.defaultValue)
    if ('required' in input) patch('required', input.required ?? false)
    if ('description' in input) patch('description', input.description || undefined)
    if ('enumOptions' in input && draftParam.type === 'enum') patch('enumOptions', input.enumOptions)
    return changed
  })
  return paramId
}

export function exposeComponentParamAction(
  get: GetState,
  mutateSite: MutateSite,
  vcId: string,
  nodeId: string,
  propKey: string,
  input: ExposeComponentParamActionInput,
): string {
  const vc = get().site?.visualComponents.find((candidate) => candidate.id === vcId)
  if (!vc) throw new Error(`Visual Component not found: ${vcId}`)
  if (!vc.tree.nodes[nodeId]) throw new Error(`Node ${nodeId} does not belong to Visual Component ${vcId}.`)
  const nameValidation = validateParamName(input.name, vc.params)
  if (!nameValidation.ok) {
    throw new VisualComponentParamNameError(nameValidation.reason, nameValidation.error)
  }
  validateTypedParamDefault(input.type, input.defaultValue, input.enumOptions)

  const paramId = nanoid()
  mutateSite((site) => {
    const draftVc = site.visualComponents.find((candidate) => candidate.id === vcId)
    const draftNode = draftVc?.tree.nodes[nodeId]
    if (!draftVc || !draftNode) throw new Error('Component changed before parameter exposure.')
    draftVc.params.push({
      id: paramId,
      name: input.name.trim(),
      type: input.type,
      defaultValue: input.defaultValue,
      required: input.required ?? false,
      ...(input.description ? { description: input.description } : {}),
      ...(input.type === 'enum' && input.enumOptions ? { enumOptions: input.enumOptions } : {}),
    })
    if (!draftNode.propBindings) draftNode.propBindings = {}
    draftNode.propBindings[propKey] = { paramId }
    return true
  })
  return paramId
}
