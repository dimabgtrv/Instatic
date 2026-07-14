/** Headless Visual Component contract inspection for MCP reconciliation. */
import { Type } from '@core/utils/typeboxHelpers'
import { collectSlotOutletNames, safePropOverrides } from '@core/visualComponents'
import type { AiTool, ToolContext } from '../../runtime/types'
import { getDraftSiteDocument } from '../../../repositories/publish'

const InspectVisualComponentInput = Type.Object({
  componentId: Type.String({ minLength: 1 }),
  instanceOffset: Type.Optional(Type.Integer({ minimum: 0 })),
  instanceLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
}, { additionalProperties: false })

const ListExplorerInput = Type.Object({
  section: Type.Union([Type.Literal('components'), Type.Literal('templates')]),
}, { additionalProperties: false })

function slotInstances(
  node: { children: string[] },
  nodes: Record<string, { id: string; moduleId: string; props: Record<string, unknown> }>,
): Array<{ slotName: string; nodeId: string }> {
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

export const componentMcpTools: AiTool[] = [
  {
    name: 'site_inspect_visual_component',
    description:
      'Read a Visual Component contract by id: stable parameters, property bindings, slot outlets, nested component references, Explorer placement, and every page/component instance with its overrides. Headless — no open editor needed. Use before reconciling or updating a component.',
    scope: 'site',
    execution: 'server',
    inputSchema: InspectVisualComponentInput,
    requiredCapabilities: ['site.read'],
    handler: async (input, ctx: ToolContext) => {
      const { componentId, instanceOffset = 0, instanceLimit = 100 } = input as {
        componentId: string
        instanceOffset?: number
        instanceLimit?: number
      }
      const site = await getDraftSiteDocument(ctx.db)
      if (!site) return { ok: false, error: 'No site found.' }
      const component = site.visualComponents.find((candidate) => candidate.id === componentId)
      if (!component) return { ok: false, error: `Visual Component not found: ${componentId}` }

      const bindings = Object.values(component.tree.nodes).flatMap((node) =>
        Object.entries(node.propBindings ?? {}).map(([propKey, binding]) => ({
          nodeId: node.id,
          moduleId: node.moduleId,
          propKey,
          paramId: binding.paramId,
        })),
      )
      const slotOutlets = Object.values(component.tree.nodes)
        .filter((node) => node.moduleId === 'base.slot-outlet')
        .map((node) => ({
          nodeId: node.id,
          slotName: typeof node.props.slotName === 'string' && node.props.slotName
            ? node.props.slotName
            : 'children',
        }))
      const nestedComponents = Object.values(component.tree.nodes)
        .filter((node) => node.moduleId === 'base.visual-component-ref')
        .map((node) => ({
          nodeId: node.id,
          componentId: typeof node.props.componentId === 'string' ? node.props.componentId : null,
          overrides: safePropOverrides(node.props),
        }))
      const nodes = Object.values(component.tree.nodes).map((node) => ({
        nodeId: node.id,
        moduleId: node.moduleId,
        parentId: node.parentId ?? null,
        label: node.label ?? null,
        props: node.props,
      }))

      const instances: Array<Record<string, unknown>> = []
      for (const page of site.pages) {
        for (const node of Object.values(page.nodes)) {
          if (node.moduleId !== 'base.visual-component-ref' || node.props.componentId !== componentId) continue
          instances.push({
            document: { type: page.template ? 'template' : 'page', id: page.id },
            title: page.title,
            nodeId: node.id,
            overrides: safePropOverrides(node.props),
            slots: slotInstances(node, page.nodes),
          })
        }
      }
      for (const host of site.visualComponents) {
        for (const node of Object.values(host.tree.nodes)) {
          if (node.moduleId !== 'base.visual-component-ref' || node.props.componentId !== componentId) continue
          instances.push({
            document: { type: 'visualComponent', id: host.id },
            title: host.name,
            nodeId: node.id,
            overrides: safePropOverrides(node.props),
            slots: slotInstances(node, host.tree.nodes),
          })
        }
      }

      const placement = site.explorer.components.items.find((item) => item.id === componentId)
      const folder = placement?.parentFolderId
        ? site.explorer.components.folders.find((candidate) => candidate.id === placement.parentFolderId)
        : undefined

      return {
        component: {
          id: component.id,
          name: component.name,
          rootNodeId: component.tree.rootNodeId,
          params: component.params,
          bindings,
          slotNames: collectSlotOutletNames(component.tree),
          slotOutlets,
          nestedComponents,
          nodes,
          classIds: component.classIds,
          nodeCount: Object.keys(component.tree.nodes).length,
          explorer: {
            folderId: folder?.id ?? null,
            folderName: folder?.name ?? null,
            order: placement?.order ?? null,
          },
        },
        instances: instances.slice(instanceOffset, instanceOffset + instanceLimit),
        instancePage: {
          offset: instanceOffset,
          limit: instanceLimit,
          total: instances.length,
          nextOffset: instanceOffset + instanceLimit < instances.length
            ? instanceOffset + instanceLimit
            : null,
        },
        instanceCount: instances.length,
      }
    },
  },
  {
    name: 'site_list_explorer',
    description:
      'List Components or Templates Explorer folders and item placement, including empty folders. Headless — no open editor needed. Use returned folder ids with component creation and site_move_explorer_item.',
    scope: 'site',
    execution: 'server',
    inputSchema: ListExplorerInput,
    requiredCapabilities: ['site.read'],
    handler: async (input, ctx: ToolContext) => {
      const { section } = input as { section: 'components' | 'templates' }
      const site = await getDraftSiteDocument(ctx.db)
      if (!site) return { ok: false, error: 'No site found.' }
      const organization = site.explorer[section]
      const names = section === 'components'
        ? new Map(site.visualComponents.map((component) => [component.id, component.name]))
        : new Map(site.pages.filter((page) => page.template).map((page) => [page.id, page.title]))
      return {
        section,
        folders: organization.folders,
        items: organization.items.map((item) => ({
          ...item,
          name: names.get(item.id) ?? item.id,
          folderId: item.parentFolderId ?? null,
        })),
      }
    },
  },
]
