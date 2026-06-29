import fs from 'fs';
import path from 'path';

export interface ApiRoute {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';
  authType: 'none' | 'nextauth' | 'apikey';
}

export interface DbColumn {
  name: string;
  type: string;
}

export interface DbTable {
  name: string;
  columns: DbColumn[];
}

export interface ApplicationFootprint {
  apiRoutes: ApiRoute[];
  dbSchema: DbTable[];
}

/**
 * Recursively find all route.ts files in a directory.
 * Includes try-catch blocks to handle directory traversal errors gracefully.
 */
export function findRouteFiles(dir: string): string[] {
  let results: string[] = [];
  try {
    if (!fs.existsSync(dir)) {
      return results;
    }
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          results = results.concat(findRouteFiles(filePath));
        } else if (stat.isFile() && file === 'route.ts') {
          results.push(filePath);
        }
      } catch (e) {
        console.warn(`[discovery] Failed to stat file or directory ${filePath}:`, e);
      }
    }
  } catch (e) {
    console.warn(`[discovery] Failed to read directory ${dir}:`, e);
  }
  return results;
}

/**
 * Extracts columns content matching curly braces.
 */
export function getColumnsBlock(text: string, startIndex: number): string {
  let openBraces = 0;
  let blockStart = -1;
  for (let i = startIndex; i < text.length; i++) {
    if (text[i] === '{') {
      if (openBraces === 0) {
        blockStart = i + 1;
      }
      openBraces++;
    } else if (text[i] === '}') {
      openBraces--;
      if (openBraces === 0 && blockStart !== -1) {
        return text.substring(blockStart, i);
      }
    }
  }
  return '';
}

/**
 * Strips both single-line and multi-line comments from a string.
 */
export function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
}

/**
 * Extract HTTP methods from file content.
 * Supports:
 * - Direct function exports (e.g. export async function GET)
 * - Direct variable exports (e.g. export const GET = ...)
 * - Named re-exports (e.g. export { handler as GET, handler as POST } or export { GET })
 */
export function extractMethods(content: string): ApiRoute['method'][] {
  const methods: ApiRoute['method'][] = [];
  const candidates: ApiRoute['method'][] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];
  
  const cleanContent = stripComments(content);

  // 1. Direct function exports: export async function GET or export function GET
  const fnRegex = /\bexport\s+(async\s+)?function\s+(\w+)\b/g;
  let fnMatch;
  while ((fnMatch = fnRegex.exec(cleanContent)) !== null) {
    const name = fnMatch[2];
    if (candidates.includes(name as ApiRoute['method'])) {
      methods.push(name as ApiRoute['method']);
    }
  }

  // 2. Direct variable exports: export const GET = ...
  const varRegex = /\bexport\s+(const|let|var)\s+(\w+)\b/g;
  let varMatch;
  while ((varMatch = varRegex.exec(cleanContent)) !== null) {
    const name = varMatch[2];
    if (candidates.includes(name as ApiRoute['method'])) {
      methods.push(name as ApiRoute['method']);
    }
  }

  // 3. Named exports block: export { handler as GET } or export { GET }
  const exportBraceRegex = /\bexport\s*\{([^}]+)\}/g;
  let braceMatch;
  while ((braceMatch = exportBraceRegex.exec(cleanContent)) !== null) {
    const parts = braceMatch[1].split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      
      const asMatch = trimmed.match(/(?:^|\s+)as\s+(\w+)$/);
      if (asMatch) {
        const name = asMatch[1];
        if (candidates.includes(name as ApiRoute['method'])) {
          methods.push(name as ApiRoute['method']);
        }
      } else {
        const identifierMatch = trimmed.match(/^(\w+)$/);
        if (identifierMatch) {
          const name = identifierMatch[1];
          if (candidates.includes(name as ApiRoute['method'])) {
            methods.push(name as ApiRoute['method']);
          }
        }
      }
    }
  }

  return Array.from(new Set(methods));
}

/**
 * Runs static analysis to inventory all Next.js API endpoints and database tables.
 */
export function discoverApplicationFootprint(): ApplicationFootprint {
  const apiRoutes: ApiRoute[] = [];
  const dbSchema: DbTable[] = [];

  const rootDir = process.cwd();

  // --- 1. Scan API Routes ---
  const apiBaseDir = path.join(rootDir, 'app', 'api');
  if (fs.existsSync(apiBaseDir)) {
    const routeFiles = findRouteFiles(apiBaseDir);

    for (const filePath of routeFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const relativePath = path.relative(apiBaseDir, filePath);
        
        // Convert to path relative to /api
        const cleanPath = relativePath
          .replace(/\\/g, '/')
          .replace(/\/route\.ts$/, '')
          .replace(/^route\.ts$/, '');
        
        const apiPath = cleanPath ? `/api/${cleanPath}` : '/api';

        // Extract HTTP methods using robust parsing
        const methods = extractMethods(content);

        // Determine authType on stripped content
        const cleanContent = stripComments(content);
        let authType: ApiRoute['authType'] = 'none';
        if (
          cleanContent.includes('gateToken') ||
          cleanContent.includes('verifyGateToken') ||
          cleanContent.includes('apiKey')
        ) {
          authType = 'apikey';
        } else if (
          cleanContent.includes('getServerSession') ||
          cleanContent.includes('getToken')
        ) {
          authType = 'nextauth';
        }

        for (const method of methods) {
          apiRoutes.push({
            path: apiPath,
            method,
            authType,
          });
        }
      } catch (error) {
        console.warn(`[discovery] Failed to scan API route file ${filePath}:`, error);
      }
    }
  }

  // --- 2. Scan DB Schema ---
  const schemaFilePath = path.join(rootDir, 'lib', 'schema.ts');
  if (fs.existsSync(schemaFilePath)) {
    try {
      const content = fs.readFileSync(schemaFilePath, 'utf-8');
      
      // Strip comments to avoid matching commented-out table declarations
      const cleanContent = stripComments(content);

      const pgTableRegex = /pgTable\(\s*['"]([^'"]+)['"]/g;
      let match;
      while ((match = pgTableRegex.exec(cleanContent)) !== null) {
        const tableName = match[1];
        const startIndex = match.index + match[0].length;
        const columnsContent = getColumnsBlock(cleanContent, startIndex);

        const columns: DbColumn[] = [];
        // Match: propName: colType('col_name' or colType(lookahead closing brace)
        const columnRegex = /(\w+)\s*:\s*(\w+)\(\s*(?:['"]([^'"]+)['"]|(?=\s*\)))/g;
        let columnMatch;
        while ((columnMatch = columnRegex.exec(columnsContent)) !== null) {
          const propertyName = columnMatch[1];
          const columnType = columnMatch[2];
          const columnName = columnMatch[3] || propertyName; // Fallback to property name if undefined
          
          columns.push({
            name: columnName,
            type: columnType,
          });
        }

        dbSchema.push({
          name: tableName,
          columns,
        });
      }
    } catch (error) {
      console.warn(`[discovery] Failed to scan schema file ${schemaFilePath}:`, error);
    }
  }

  return {
    apiRoutes,
    dbSchema,
  };
}
