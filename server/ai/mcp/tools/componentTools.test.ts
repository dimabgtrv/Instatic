import { beforeEach, describe, expect, it } from 'bun:test'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import type { DbClient } from '../../../db/client'
import type { ToolContext } from '../../runtime/types'
import { mcpToolsForCapabilities } from '../registry'

const ROOT = {
  id: 'vc-root',
  moduleId: 'base.body',
  props: {},
  breakpointOverrides: {},
  classIds: [],
  children: ['vc-button', 'vc-slot'],
}
const BUTTON = {
  id: 'vc-button',
  moduleId: 'base.button',
  props: { label: 'Default' },
  propBindings: { label: { paramId: 'label-param' } },
  breakpointOverrides: {},
  classIds: [],
  children: [],
}
const SLOT = {
  id: 'vc-slot',
  moduleId: 'base.slot-outlet',
  props: { slotName: 'after' },
  breakpointOverrides: {},
  classIds: [],
  children: [],
}

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into site (id, name, settings_json)
    values ('default', 'Test', ${{
      cmsSiteSchemaVersion: 1,
      site: {
        explorer: {
          components: {
            folders: [
              { id: 'folder-boxy', name: 'Boxy', order: 0 },
              { id: 'folder-empty', name: 'Empty', order: 1 },
            ],
            items: [{ id: 'button-vc', parentFolderId: 'folder-boxy', order: 0 }],
          },
        },
      },
    }})
  `
  const componentCells = JSON.stringify({
    name: 'Button',
    slug: 'button',
    body: {
      rootNodeId: 'vc-root',
      nodes: { 'vc-root': ROOT, 'vc-button': BUTTON, 'vc-slot': SLOT },
    },
    params: [{
      id: 'label-param',
      name: 'Label',
      type: 'string',
      defaultValue: 'Default',
      required: false,
    }],
    classIds: [],
  })
  await db`
    insert into data_rows (id, table_id, cells_json, slug, status)
    values ('button-vc', 'components', ${componentCells}, 'button', 'draft')
  `
  const pageCells = JSON.stringify({
    title: 'Home',
    slug: 'index',
    body: {
      rootNodeId: 'page-root',
      nodes: {
        'page-root': {
          id: 'page-root',
          moduleId: 'base.body',
          props: {},
          breakpointOverrides: {},
          classIds: [],
          children: ['button-ref'],
        },
        'button-ref': {
          id: 'button-ref',
          moduleId: 'base.visual-component-ref',
          props: { componentId: 'button-vc', propOverrides: { 'label-param': 'Buy' } },
          breakpointOverrides: {},
          classIds: [],
          children: ['button-ref-slot-after'],
        },
        'button-ref-slot-after': {
          id: 'button-ref-slot-after',
          moduleId: 'base.slot-instance',
          props: { slotName: 'after' },
          breakpointOverrides: {},
          classIds: [],
          children: [],
        },
      },
    },
  })
  await db`
    insert into data_rows (id, table_id, cells_json, slug, status)
    values ('home', 'pages', ${pageCells}, 'index', 'draft')
  `
  return db
}

function context(db: DbClient): ToolContext {
  return {
    db,
    userId: 'u1',
    capabilities: ['site.read'],
    scope: 'site',
    conversationId: 'mcp:test',
    snapshot: null,
    signal: new AbortController().signal,
  }
}

describe('MCP Visual Component headless reads', () => {
  let db: DbClient
  beforeEach(async () => {
    db = await freshDb()
  })

  it('returns stable params, bindings, and instance overrides without an editor bridge', async () => {
    const tool = mcpToolsForCapabilities(['site.read']).find(
      (candidate) => candidate.name === 'site_inspect_visual_component',
    )
    if (!tool?.handler) throw new Error('Expected headless component inspector')
    const result = await tool.handler({ componentId: 'button-vc' }, context(db)) as {
      component: {
        params: Array<{ id: string }>
        bindings: Array<{ paramId: string }>
        nodes: Array<{ nodeId: string; moduleId: string }>
      }
      instances: Array<{
        nodeId: string
        overrides: Record<string, unknown>
        slots: Array<{ slotName: string; nodeId: string }>
      }>
      instancePage: { offset: number; limit: number; total: number; nextOffset: number | null }
      instanceCount: number
    }
    expect(result.component.params[0]?.id).toBe('label-param')
    expect(result.component.bindings[0]?.paramId).toBe('label-param')
    expect(result.component.nodes.some((node) => node.nodeId === 'vc-slot')).toBe(true)
    expect(result.instanceCount).toBe(1)
    expect(result.instances[0]?.nodeId).toBe('button-ref')
    expect(result.instances[0]?.overrides['label-param']).toBe('Buy')
    expect(result.instances[0]?.slots).toEqual([
      { slotName: 'after', nodeId: 'button-ref-slot-after' },
    ])
    expect(result.instancePage).toEqual({ offset: 0, limit: 100, total: 1, nextOffset: null })
  })

  it('paginates instances and lists Explorer placement including empty folders', async () => {
    const inspect = mcpToolsForCapabilities(['site.read']).find(
      (candidate) => candidate.name === 'site_inspect_visual_component',
    )
    const listExplorer = mcpToolsForCapabilities(['site.read']).find(
      (candidate) => candidate.name === 'site_list_explorer',
    )
    if (!inspect?.handler || !listExplorer?.handler) throw new Error('Expected headless component tools')

    const page = await inspect.handler(
      { componentId: 'button-vc', instanceOffset: 1, instanceLimit: 1 },
      context(db),
    ) as { instances: unknown[]; instancePage: { nextOffset: number | null; total: number } }
    expect(page.instances).toHaveLength(0)
    expect(page.instancePage).toEqual({ offset: 1, limit: 1, total: 1, nextOffset: null })

    const explorer = await listExplorer.handler({ section: 'components' }, context(db)) as {
      folders: Array<{ id: string }>
      items: Array<{ id: string; folderId: string | null; name: string }>
    }
    expect(explorer.folders.map((folder) => folder.id)).toContain('folder-empty')
    expect(explorer.items).toContainEqual(expect.objectContaining({
      id: 'button-vc',
      folderId: 'folder-boxy',
      name: 'Button',
    }))
  })

  it('exposes structured tokens headlessly instead of using a null chat snapshot', async () => {
    const tool = mcpToolsForCapabilities(['site.read']).find(
      (candidate) => candidate.name === 'site_list_tokens',
    )
    if (!tool?.handler) throw new Error('Expected headless token tool')
    expect(tool.execution).toBe('server')
    const result = await tool.handler({}, context(db)) as { tokens: Record<string, unknown[]> }
    expect(Array.isArray(result.tokens.colors)).toBe(true)
    expect(Array.isArray(result.tokens.typography)).toBe(true)
    expect(Array.isArray(result.tokens.spacing)).toBe(true)
    expect(Array.isArray(result.tokens.fonts)).toBe(true)
  })
})
