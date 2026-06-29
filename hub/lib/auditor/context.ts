import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger';

const log = createLogger('auditor/context');

export interface SystemConstraint {
  id: string;
  sourceFile: string;
  category: 'security' | 'architecture' | 'database' | 'ux';
  intent: string;      // The detailed expectation/requirement
  severity: 'critical' | 'major' | 'minor';
}

const DEFAULT_VAULT_PATH = 'C:/AntigravityHQ/chats/hub-paperclip';

// Cache configuration
let cachedConstraints: SystemConstraint[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache TTL

/**
 * Normalizes and cleans the decision string.
 */
function cleanDecisionText(text: string): string {
  return text
    .replace(/^[-*\s]+/, '') // Remove bullet characters and spaces
    .replace(/^\s*\*\*.*?\*\*:\s*/, '') // Remove lead-in bold headers (e.g., "**Security**: intent" -> "intent")
    .trim();
}

/**
 * Classifies a decision text into a category.
 */
function classifyCategory(text: string): 'security' | 'architecture' | 'database' | 'ux' {
  const lower = text.toLowerCase();
  
  if (
    lower.includes('auth') ||
    lower.includes('security') ||
    lower.includes('permission') ||
    lower.includes('token') ||
    lower.includes('encryption') ||
    lower.includes('credentials') ||
    lower.includes('isolation') ||
    lower.includes('vulnerability') ||
    lower.includes('session') ||
    lower.includes('roles') ||
    lower.includes('policy') ||
    lower.includes('leak')
  ) {
    return 'security';
  }
  
  if (
    lower.includes('database') ||
    lower.includes('postgres') ||
    lower.includes('pg') ||
    lower.includes('drizzle') ||
    lower.includes('sql') ||
    lower.includes('cache') ||
    lower.includes('redis') ||
    lower.includes('schema') ||
    lower.includes('migration') ||
    lower.includes('query')
  ) {
    return 'database';
  }
  
  if (
    lower.includes('ux') ||
    lower.includes('ui') ||
    lower.includes('css') ||
    lower.includes('style') ||
    lower.includes('design') ||
    lower.includes('layout') ||
    lower.includes('color') ||
    lower.includes('font') ||
    lower.includes('theme') ||
    lower.includes('responsive') ||
    lower.includes('mobile') ||
    lower.includes('component')
  ) {
    return 'ux';
  }
  
  return 'architecture';
}

/**
 * Classifies a decision text into a severity level.
 */
function classifySeverity(text: string, category: string): 'critical' | 'major' | 'minor' {
  const lower = text.toLowerCase();
  
  if (category === 'security') {
    return 'critical';
  }
  
  if (
    lower.includes('must') ||
    lower.includes('critical') ||
    lower.includes('required') ||
    lower.includes('breaking') ||
    lower.includes('error') ||
    lower.includes('zero-tolerance')
  ) {
    return 'critical';
  }
  
  if (
    lower.includes('should') ||
    lower.includes('recommended') ||
    lower.includes('major') ||
    lower.includes('important')
  ) {
    return 'major';
  }
  
  return 'minor';
}

/**
 * Parses individual Obsidian Markdown file content and returns its structured SystemConstraints.
 */
export function parseMarkdownConstraints(content: string, filename: string): SystemConstraint[] {
  const constraints: SystemConstraint[] = [];
  
  // Find "Key Decisions" section
  // Matches "## Key Decisions" or "### Key Decisions" and captures everything until the next header (##/###) or end of file
  const keyDecisionsRegex = /##+\s*Key\s+Decisions\s*([\s\S]*?)(?:^##+|\n---|$)/i;
  const match = keyDecisionsRegex.exec(content);
  
  if (!match) {
    return [];
  }
  
  const sectionContent = match[1];
  const lines = sectionContent.split('\n');
  let index = 0;
  
  for (const line of lines) {
    const trimmed = line.trim();
    // Match bullet points starting with - or *
    if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
      const intent = cleanDecisionText(trimmed);
      if (!intent) continue;
      
      index++;
      const category = classifyCategory(intent);
      const severity = classifySeverity(intent, category);
      
      // Generate unique constraint ID
      const baseName = filename.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9]/g, '-');
      const id = `sc-${baseName}-${index}`;
      
      constraints.push({
        id,
        sourceFile: filename,
        category,
        intent,
        severity,
      });
    }
  }
  
  return constraints;
}

/**
 * Loads all constraints from the central Obsidian vault.
 * Uses a lightweight in-memory cache to prevent excessive disk read overhead.
 */
export async function loadAllConstraints(
  vaultPath: string = DEFAULT_VAULT_PATH,
  forceRefresh: boolean = false
): Promise<SystemConstraint[]> {
  const now = Date.now();
  if (cachedConstraints && !forceRefresh && now - cacheTimestamp < CACHE_TTL_MS) {
    log.info('Returning cached constraints');
    return cachedConstraints;
  }
  
  try {
    log.info({ vaultPath }, 'Loading constraints from Obsidian vault');
    
    // Check if path exists
    try {
      await fs.access(vaultPath);
    } catch {
      log.warn({ vaultPath }, 'Obsidian vault path is not accessible. Returning empty list.');
      return [];
    }
    
    const files = await fs.readdir(vaultPath);
    const mdFiles = files.filter(f => f.endsWith('.md') && f !== '_INDEX.md');
    
    const allConstraints: SystemConstraint[] = [];
    
    for (const file of mdFiles) {
      const filePath = path.join(vaultPath, file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const fileConstraints = parseMarkdownConstraints(content, file);
        allConstraints.push(...fileConstraints);
      } catch (err) {
        log.error({ err, file }, 'Failed to read/parse vault file');
      }
    }
    
    cachedConstraints = allConstraints;
    cacheTimestamp = now;
    
    log.info({ count: allConstraints.length }, 'Successfully loaded constraints from vault');
    return allConstraints;
  } catch (err) {
    log.error({ err }, 'Error listing vault directory');
    return [];
  }
}

/**
 * Filters constraints based on a keyword or phrase query.
 */
export function queryConstraintsLocal(constraints: SystemConstraint[], query: string): SystemConstraint[] {
  if (!query) return constraints;
  
  const lowerQuery = query.toLowerCase();
  return constraints.filter(c => {
    return (
      c.intent.toLowerCase().includes(lowerQuery) ||
      c.category.toLowerCase().includes(lowerQuery) ||
      c.sourceFile.toLowerCase().includes(lowerQuery) ||
      c.severity.toLowerCase().includes(lowerQuery)
    );
  });
}
