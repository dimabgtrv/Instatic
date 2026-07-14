import { parseValue } from '@core/utils/typeboxHelpers'
import {
  aiToolError,
  aiToolOk,
  type AiToolOutput,
  CreateVisualComponentInputSchema,
  ComponentizeNodeInputSchema,
  UpsertComponentParamInputSchema,
  ExposeComponentParamInputSchema,
  BindComponentParamInputSchema,
  AddComponentSlotInputSchema,
  InsertComponentInstanceInputSchema,
  SetComponentInstanceOverridesInputSchema,
  CreateExplorerFolderInputSchema,
  MoveExplorerItemInputSchema,
  type CreateVisualComponentInput,
  type ComponentizeNodeInput,
  type UpsertComponentParamInput,
  type ExposeComponentParamInput,
  type BindComponentParamInput,
  type AddComponentSlotInput,
  type InsertComponentInstanceInput,
  type SetComponentInstanceOverridesInput,
  type CreateExplorerFolderInput,
  type MoveExplorerItemInput,
} from '@core/ai'
import { registry, type PropertyControl, type PropertySchema } from '@core/module-engine'
import type { BaseNode } from '@core/page-tree'
import { collectSlotOutletNames, type VCParam } from '@core/visualComponents'
import type { EditorStore } from '@site/store/types'
import {
  paramTypeForControl,
  paramTypesCompatibleWithControl,
} from '@site/property-controls/paramTypeCompat'
import {
  activeDocumentNodes,
  describeDocumentId,
  describeForeignNode,
} from './documentTools'
import { getAgentStoreApi } from './storeRef'

const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

function findNodeInActiveDoc(store: EditorStore, nodeId: string): BaseNode | undefined {
  return activeDocumentNodes(store)?.[nodeId]
}

function nodeNotInActiveDocError(store: EditorStore, nodeId: string): AiToolOutput {
  const documentIdError = describeDocumentId(store, nodeId)
  if (documentIdError) return aiToolError(documentIdError)
  const foreign = describeForeignNode(store, nodeId)
  return aiToolError(
    foreign
      ? `Node ${nodeId} lives in ${foreign} and could not be activated automatically.`
      : `Node not found: ${nodeId}`,
  )
}

function findPropertyControl(schema: PropertySchema, propKey: string): PropertyControl | null {
  for (const [key, control] of Object.entries(schema)) {
    if (control.type === 'group') {
      const nested = findPropertyControl(control.children, propKey)
      if (nested) return nested
      continue
    }
    if (key === propKey) return control
  }
  return null
}

function requireComponent(componentId: string) {
  const component = getStoreState().site?.visualComponents.find((candidate) => candidate.id === componentId)
  if (!component) throw new Error(`Visual Component not found: ${componentId}`)
  return component
}

function validateBindableProperty(componentId: string, nodeId: string, propKey: string) {
  const component = requireComponent(componentId)
  const node = component.tree.nodes[nodeId]
  if (!node) throw new Error(`Node ${nodeId} does not belong to Visual Component ${componentId}.`)
  const module = registry.get(node.moduleId)
  if (!module) throw new Error(`Module is not registered: ${node.moduleId}`)
  const control = findPropertyControl(module.schema, propKey)
  if (!control || control.type === 'group' || control.hidden) {
    throw new Error(`Property ${propKey} is not an exposable property of ${node.moduleId}.`)
  }
  const dynamicBindings = (node as unknown as { dynamicBindings?: Record<string, unknown> }).dynamicBindings
  if (dynamicBindings?.[propKey]) {
    throw new Error(`Property ${propKey} has a dynamic binding and cannot also use a component parameter.`)
  }
  return { component, node, module, control }
}

function validateOverrideValue(param: VCParam, value: unknown): string | null {
  if (param.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : 'a finite number'
  if (param.type === 'boolean') return typeof value === 'boolean' ? null : 'a boolean'
  if (param.type === 'slot') return 'slot content, not a scalar override'
  if (typeof value !== 'string') return 'a string'
  if (param.type === 'enum' && param.enumOptions && !param.enumOptions.includes(value)) {
    return `one of: ${param.enumOptions.join(', ')}`
  }
  return null
}

function validateOverrides(componentId: string, overrides: Record<string, unknown>): void {
  const component = requireComponent(componentId)
  for (const [paramId, value] of Object.entries(overrides)) {
    const param = component.params.find((candidate) => candidate.id === paramId)
    if (!param) throw new Error(`Component parameter not found: ${paramId}`)
    const expected = validateOverrideValue(param, value)
    if (expected) throw new Error(`Override for ${param.name} (${paramId}) must be ${expected}.`)
  }
}

function slotInstancesForNode(node: BaseNode, nodes: Record<string, BaseNode>) {
  return node.children.flatMap((nodeId) => {
    const child = nodes[nodeId]
    if (!child || child.moduleId !== 'base.slot-instance') return []
    return [{
      slotName: typeof child.props.slotName === 'string' && child.props.slotName
        ? child.props.slotName
        : 'children',
      nodeId: child.id,
    }]
  })
}

function runCreateVisualComponent(input: CreateVisualComponentInput): AiToolOutput {
  const store = getStoreState()
  const componentId = store.createVisualComponent(input.name, input.folderId)
  const component = requireComponent(componentId)
  store.setActiveDocument({ kind: 'visualComponent', vcId: componentId })
  return aiToolOk({ componentId, rootNodeId: component.tree.rootNodeId, folderId: input.folderId ?? null })
}

function runComponentizeNode(input: ComponentizeNodeInput): AiToolOutput {
  const store = getStoreState()
  const pageNodes = activeDocumentNodes(store)
  if (!pageNodes?.[input.nodeId]) return nodeNotInActiveDocError(store, input.nodeId)
  const stack = [input.nodeId]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const nodeId = stack.pop()!
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    const node = pageNodes[nodeId]
    if (!node) continue
    const dynamicBindings = (node as BaseNode & { dynamicBindings?: Record<string, unknown> }).dynamicBindings
    if (dynamicBindings && Object.keys(dynamicBindings).length > 0) {
      return aiToolError(
        `Cannot componentize this subtree: node ${nodeId} has CMS dynamic bindings that Visual Components cannot preserve.`,
      )
    }
    stack.push(...node.children)
  }
  const componentId = store.convertNodeToComponent(input.nodeId, input.name, input.folderId)
  const component = requireComponent(componentId)
  let refNodeId: string | null = null
  for (const page of getStoreState().site?.pages ?? []) {
    const ref = Object.values(page.nodes).find(
      (node) => node.moduleId === 'base.visual-component-ref' && node.props.componentId === componentId,
    )
    if (ref) {
      refNodeId = ref.id
      break
    }
  }
  return aiToolOk({ componentId, rootNodeId: component.tree.rootNodeId, refNodeId, folderId: input.folderId ?? null })
}

function runUpsertComponentParam(input: UpsertComponentParamInput): AiToolOutput {
  const component = requireComponent(input.componentId)
  if (!input.paramId && (!input.name || !input.type)) {
    return aiToolError('Creating a component parameter requires name and type.')
  }
  if (input.paramId && input.type) {
    const existing = component.params.find((param) => param.id === input.paramId)
    if (!existing) return aiToolError(`Component parameter not found: ${input.paramId}`)
    if (existing.type !== input.type) return aiToolError('Changing an existing parameter type is not supported.')
  }
  getStoreState().setActiveDocument({ kind: 'visualComponent', vcId: input.componentId })
  const paramId = getStoreState().upsertComponentParam(input.componentId, input)
  const param = requireComponent(input.componentId).params.find((candidate) => candidate.id === paramId)
  return aiToolOk({ componentId: input.componentId, param })
}

function runExposeComponentParam(input: ExposeComponentParamInput): AiToolOutput {
  const { node, module, control } = validateBindableProperty(input.componentId, input.nodeId, input.propKey)
  if (node.propBindings?.[input.propKey]) {
    return aiToolError(`Property ${input.propKey} is already bound to a component parameter.`)
  }
  const type = paramTypeForControl(control)
  if (type === 'slot') return aiToolError('Slots must be authored with site_add_component_slot.')
  const enumOptions = control.type === 'select'
    ? control.options.map((option) => option.value).filter((value): value is string => typeof value === 'string')
    : undefined
  const defaultValue = input.propKey in node.props ? node.props[input.propKey] : module.defaults[input.propKey]
  const paramId = getStoreState().exposeComponentParam(input.componentId, input.nodeId, input.propKey, {
    name: input.name,
    type,
    defaultValue,
    required: input.required,
    description: input.description,
    ...(enumOptions && enumOptions.length > 0 ? { enumOptions } : {}),
  })
  return aiToolOk({
    componentId: input.componentId,
    paramId,
    binding: { nodeId: input.nodeId, propKey: input.propKey, paramId },
    param: requireComponent(input.componentId).params.find((param) => param.id === paramId),
  })
}

function runBindComponentParam(input: BindComponentParamInput): AiToolOutput {
  const { component, control } = validateBindableProperty(input.componentId, input.nodeId, input.propKey)
  const param = component.params.find((candidate) => candidate.id === input.paramId)
  if (!param) return aiToolError(`Component parameter not found: ${input.paramId}`)
  if (param.type === 'slot' || !paramTypesCompatibleWithControl(control).includes(param.type)) {
    return aiToolError(`Parameter ${param.name} (${param.type}) is incompatible with property ${input.propKey}.`)
  }
  getStoreState().setNodePropBinding(input.nodeId, input.propKey, input.paramId)
  const binding = requireComponent(input.componentId).tree.nodes[input.nodeId]?.propBindings?.[input.propKey]
  return aiToolOk({ componentId: input.componentId, nodeId: input.nodeId, propKey: input.propKey, binding })
}

function runAddComponentSlot(input: AddComponentSlotInput): AiToolOutput {
  const component = requireComponent(input.componentId)
  const parent = component.tree.nodes[input.parentNodeId]
  if (!parent) return aiToolError(`Parent node ${input.parentNodeId} does not belong to Visual Component ${input.componentId}.`)
  const module = registry.get(parent.moduleId)
  if (parent.id !== component.tree.rootNodeId && module?.canHaveChildren !== true) {
    return aiToolError(`Node ${input.parentNodeId} does not accept children.`)
  }
  const slotName = input.slotName.trim()
  if (!slotName) return aiToolError('Slot name cannot be empty.')
  if (collectSlotOutletNames(component.tree).includes(slotName)) {
    return aiToolError(`Slot name already exists in this component: ${slotName}`)
  }
  const store = getStoreState()
  store.setActiveDocument({ kind: 'visualComponent', vcId: input.componentId })
  const slotNodeId = store.insertNode('base.slot-outlet', { slotName }, input.parentNodeId, input.index)
  if (!slotNodeId) return aiToolError('The slot outlet could not be inserted.')
  return aiToolOk({ componentId: input.componentId, slotNodeId, slotName })
}

function runInsertComponentInstance(input: InsertComponentInstanceInput): AiToolOutput {
  requireComponent(input.componentId)
  const overrides = input.overrides ?? {}
  validateOverrides(input.componentId, overrides)
  const refNodeId = getStoreState().insertComponentRef(input.parentId, input.componentId, input.index, overrides)
  if (!refNodeId) return aiToolError('Component instance insertion was blocked (invalid parent or component cycle).')
  const ref = findNodeInActiveDoc(getStoreState(), refNodeId)
  const nodes = activeDocumentNodes(getStoreState()) ?? {}
  return aiToolOk({
    refNodeId,
    componentId: input.componentId,
    overrides: ref?.props.propOverrides ?? {},
    slots: ref ? slotInstancesForNode(ref, nodes) : [],
  })
}

function runSetComponentInstanceOverrides(input: SetComponentInstanceOverridesInput): AiToolOutput {
  const ref = findNodeInActiveDoc(getStoreState(), input.nodeId)
  if (!ref || ref.moduleId !== 'base.visual-component-ref') {
    return nodeNotInActiveDocError(getStoreState(), input.nodeId)
  }
  const componentId = ref.props.componentId
  if (typeof componentId !== 'string' || !componentId) return aiToolError('Component instance has no valid componentId.')
  validateOverrides(componentId, input.overrides)
  getStoreState().setComponentInstanceOverrides(input.nodeId, input.overrides)
  const updated = findNodeInActiveDoc(getStoreState(), input.nodeId)
  return aiToolOk({ nodeId: input.nodeId, componentId, overrides: updated?.props.propOverrides ?? {} })
}

function runCreateExplorerFolder(input: CreateExplorerFolderInput): AiToolOutput {
  const folderId = getStoreState().createExplorerFolder(input.section, input.name)
  const folder = getStoreState().site?.explorer[input.section].folders.find((candidate) => candidate.id === folderId)
  return aiToolOk({ section: input.section, folder })
}

function runMoveExplorerItem(input: MoveExplorerItemInput): AiToolOutput {
  const store = getStoreState()
  const section = store.site?.explorer[input.section]
  if (!section?.items.some((item) => item.id === input.itemId)) return aiToolError(`Explorer item not found: ${input.itemId}`)
  if (input.folderId && !section.folders.some((folder) => folder.id === input.folderId)) {
    return aiToolError(`Explorer folder not found: ${input.folderId}`)
  }
  const targetFolderId = input.folderId ?? null
  const index = input.index ?? section.items.filter(
    (item) => (item.parentFolderId ?? null) === targetFolderId,
  ).length
  store.moveExplorerItem(input.section, input.itemId, targetFolderId, index)
  const placement = getStoreState().site?.explorer[input.section].items.find((item) => item.id === input.itemId)
  return aiToolOk({ section: input.section, placement })
}

export function runVisualComponentTool(name: string, rawInput: unknown): AiToolOutput | undefined {
  switch (name) {
    case 'site_create_visual_component':
      return runCreateVisualComponent(parseValue(CreateVisualComponentInputSchema, rawInput))
    case 'site_componentize_node':
      return runComponentizeNode(parseValue(ComponentizeNodeInputSchema, rawInput))
    case 'site_upsert_component_param':
      return runUpsertComponentParam(parseValue(UpsertComponentParamInputSchema, rawInput))
    case 'site_expose_component_param':
      return runExposeComponentParam(parseValue(ExposeComponentParamInputSchema, rawInput))
    case 'site_bind_component_param':
      return runBindComponentParam(parseValue(BindComponentParamInputSchema, rawInput))
    case 'site_add_component_slot':
      return runAddComponentSlot(parseValue(AddComponentSlotInputSchema, rawInput))
    case 'site_insert_component_instance':
      return runInsertComponentInstance(parseValue(InsertComponentInstanceInputSchema, rawInput))
    case 'site_set_component_instance_overrides':
      return runSetComponentInstanceOverrides(parseValue(SetComponentInstanceOverridesInputSchema, rawInput))
    case 'site_create_explorer_folder':
      return runCreateExplorerFolder(parseValue(CreateExplorerFolderInputSchema, rawInput))
    case 'site_move_explorer_item':
      return runMoveExplorerItem(parseValue(MoveExplorerItemInputSchema, rawInput))
    default:
      return undefined
  }
}
