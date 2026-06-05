/**
 * Graph Builder Tool for Paperclip Agents
 * 
 * This module provides the tools that allow AI agents to actively 
 * build the Obsidian-like knowledge graph by linking entities together.
 */

import { db } from '../lib/db';
import { entityLinks } from '../lib/schema';

export type EntityType = 'kpi' | 'agent_memory' | 'hub_user' | 'event_log';

export interface CreateLinkParams {
  tenantId: string;
  sourceType: EntityType;
  sourceId: string;
  targetType: EntityType;
  targetId: string;
  label?: string;
}

/**
 * Creates a bidirectional edge between two entities in the knowledge graph.
 */
export async function createEntityLink(params: CreateLinkParams) {
  try {
    const [link] = await db.insert(entityLinks).values({
      tenantId: params.tenantId,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      targetType: params.targetType,
      targetId: params.targetId,
      label: params.label,
    }).returning();
    
    return { success: true, link };
  } catch (error) {
    console.error('Failed to create entity link:', error);
    return { success: false, error: (error as Error).message };
  }
}
