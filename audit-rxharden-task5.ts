import * as fs from 'fs';
import * as path from 'path';

const hubRoot = path.join(process.cwd(), 'hub');
const routePath = path.join(hubRoot, 'app', 'api', 'chat', 'route.ts');
const zodPath = path.join(hubRoot, 'lib', 'zod-schemas.ts');

const routeContent = fs.readFileSync(routePath, 'utf-8');
const zodContent = fs.readFileSync(zodPath, 'utf-8');

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`✅ PASS: ${name}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

console.log('═══════════════════════════════════════════════════════');
console.log('  RxHarden Task 5 — Pre-Cog Empirical Audit');
console.log('═══════════════════════════════════════════════════════\n');

// ── Phase 1: Structural Checks ──
console.log('── Phase 1: Structural Integrity ──\n');

check(
  'effectiveUseCase computed before search routing',
  routeContent.indexOf('const effectiveUseCase = activeSkill') < routeContent.indexOf('// ── Intelligent Search Routing ──'),
  'effectiveUseCase must be computed before search routing'
);

check(
  'searchContextParts is an array (not let string)',
  routeContent.includes('const searchContextParts: string[] = []'),
  'Should use array collection pattern to avoid race condition'
);

check(
  'searchPromises returns string | null',
  routeContent.includes('Promise<string | null>[]'),
  'Search promises should return string | null, not void'
);

check(
  'searchContext assembled from array join',
  routeContent.includes("const searchContext = searchContextParts.join('')"),
  'searchContext should be assembled by joining array'
);

check(
  'No searchContext += mutation pattern remains',
  !routeContent.includes("searchContext +="),
  'Race condition pattern should be completely eliminated'
);

// ── Phase 2: Routing Logic ──
console.log('\n── Phase 2: Routing Logic Correctness ──\n');

check(
  'shouldRunVertex uses effectiveUseCase',
  routeContent.includes("effectiveUseCase === 'deep_dive' || effectiveUseCase === 'interview'"),
  'Vertex routing must use effectiveUseCase, not useCase'
);

check(
  'shouldRunPgVector uses effectiveUseCase',
  routeContent.includes("effectiveUseCase === 'recall' || effectiveUseCase === 'deep_dive' || effectiveUseCase === 'interview'"),
  'PgVector routing must use effectiveUseCase'
);

check(
  'interview useCase triggers Vertex search',
  /shouldRunVertex.*interview/.test(routeContent),
  'interview mode needs Vertex AI context for smart questions'
);

check(
  'interview useCase triggers pgvector search',
  /shouldRunPgVector.*interview/.test(routeContent),
  'interview mode needs pgvector context'
);

check(
  'recall useCase does NOT trigger Vertex search',
  (() => {
    // Extract the shouldRunVertex assignment line
    const vertexLine = routeContent.match(/const shouldRunVertex = (.+)/)?.[1] ?? '';
    return !vertexLine.includes("'recall'");
  })(),
  'recall should only fire pgvector, not Vertex'
);

// ── Phase 3: Observability ──
console.log('\n── Phase 3: Observability & Logging ──\n');

check(
  'Search routing decision is logged',
  routeContent.includes("log.info({ effectiveUseCase, shouldRunVertex, shouldRunPgVector, explicitInternalReq }, 'Search routing decision')"),
  'Must log the routing decision for production debugging'
);

check(
  'Vertex skip is logged',
  routeContent.includes("'Vertex AI search skipped by routing policy'"),
  'Must log when Vertex is intentionally skipped'
);

check(
  'pgvector skip is logged',
  routeContent.includes("'pgvector search skipped by routing policy'"),
  'Must log when pgvector is intentionally skipped'
);

check(
  'Misleading pgvector log is fixed',
  !routeContent.includes('Semantic chunks discarded due to low relevance threshold'),
  'Old misleading log message should be replaced'
);

check(
  'Corrected pgvector log exists',
  routeContent.includes('Few chunks met relevance threshold'),
  'New log message should say "few chunks met threshold"'
);

// ── Phase 4: Zod Schema ──
console.log('\n── Phase 4: Zod Schema Validation ──\n');

check(
  'useCase is z.enum() in ChatRequestSchema',
  zodContent.includes("z.enum(['recall', 'deep_dive', 'execute', 'interview'])"),
  'useCase must be constrained to valid values to prevent typo-routing bugs'
);

check(
  'useCase is NOT z.string() anymore',
  !zodContent.match(/useCase:\s*z\.string\(\)/),
  'z.string() is too permissive for useCase'
);

// ── Phase 5: Duplicate effectiveUseCase ──
console.log('\n── Phase 5: No Duplicate effectiveUseCase ──\n');

const effectiveUseCaseMatches = routeContent.match(/const effectiveUseCase/g);
check(
  'effectiveUseCase is defined exactly once',
  effectiveUseCaseMatches?.length === 1,
  `Found ${effectiveUseCaseMatches?.length ?? 0} definitions (expected 1)`
);

check(
  'streamGeminiChat uses effectiveUseCase',
  routeContent.includes('streamGeminiChat(messages, systemPrompt, effectiveUseCase)'),
  'Model selection must use effectiveUseCase'
);

// ── Summary ──
console.log('\n═══════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═══════════════════════════════════════════════════════');

if (failed > 0) {
  console.error('\n🔴 AUDIT FAILED — fixes required before deployment');
  process.exit(1);
} else {
  console.log('\n🟢 AUDIT PASSED — all Pre-Cog findings resolved, ready for deployment');
  process.exit(0);
}
