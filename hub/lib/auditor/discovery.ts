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
 */
function findRouteFiles(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) {
    return results;
  }
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      results = results.concat(findRouteFiles(filePath));
    } else if (stat.isFile() && file === 'route.ts') {
      results.push(filePath);
    }
  }
  return results;
}

/**
 * Extracts columns content matching curly braces.
 */
function getColumnsBlock(text: string, startIndex: number): string {
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

        // Extract HTTP methods
        const methods: ApiRoute['method'][] = [];
        const methodRegex = /export\s+(async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/g;
        let methodMatch;
        while ((methodMatch = methodRegex.exec(content)) !== null) {
          methods.push(methodMatch[2] as ApiRoute['method']);
        }

        // Determine authType
        let authType: ApiRoute['authType'] = 'none';
        if (
          content.includes('gateToken') ||
          content.includes('verifyGateToken') ||
          content.includes('apiKey')
        ) {
          authType = 'apikey';
        } else if (
          content.includes('getServerSession') ||
          content.includes('getToken')
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
      const cleanContent = content.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');

      const pgTableRegex = /pgTable\(\s*['"]([^'"]+)['"]/g;
      let match;
      while ((match = pgTableRegex.exec(cleanContent)) !== null) {
        const tableName = match[1];
        const startIndex = match.index + match[0].length;
        const columnsContent = getColumnsBlock(cleanContent, startIndex);

        const columns: DbColumn[] = [];
        // Match: propName: colType('col_name'
        const columnRegex = /(\w+)\s*:\s*(\w+)\(\s*['"]([^'"]+)['"]/g;
        let columnMatch;
        while ((columnMatch = columnRegex.exec(columnsContent)) !== null) {
          const columnName = columnMatch[3];
          const columnType = columnMatch[2];
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
