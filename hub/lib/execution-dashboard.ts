/* ══════════════════════════════════════════════════════════════════════════
   EXECUTION DASHBOARD — normalization + attention derivation

   Backs the right panel's Pulse header and Attention strip (Phase 1 of the
   right-panel architecture, docs/architecture/RIGHT_PANEL_ARCHITECTURE_*.md).

   Paperclip's `GET /api/companies/{id}/dashboard` returns a compact health
   snapshot (agent counts, task counts, month spend vs budget, pending
   approvals, budget incidents). Field presence varies across Paperclip
   versions, so everything normalizes to zero-filled numbers here — the UI
   never touches the wire shape.
   ══════════════════════════════════════════════════════════════════════════ */

export interface ExecutionDashboard {
  companyId: string
  agents: { active: number; running: number; paused: number; error: number }
  tasks: { open: number; inProgress: number; blocked: number; done: number }
  costs: {
    monthSpendCents: number
    monthBudgetCents: number
    monthUtilizationPercent: number
  }
  pendingApprovals: number
  budgets: {
    activeIncidents: number
    pendingApprovals: number
    pausedAgents: number
    pausedProjects: number
  }
}

/**
 * One actionable signal for the Attention strip. `prompt` is a read-style
 * chat injection (intent-free recall path) — Phase 1 adds NO new write paths,
 * so every attention chip resolves through the assistant.
 */
export interface AttentionItem {
  key: 'blocked' | 'agent_errors' | 'approvals' | 'budget'
  label: string
  count: number
  prompt: string
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function section(raw: unknown, key: string): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const inner = (raw as Record<string, unknown>)[key]
    if (inner && typeof inner === 'object') return inner as Record<string, unknown>
  }
  return {}
}

/** Zero-fill a raw Paperclip dashboard payload into the Hub's internal shape. */
export function normalizeDashboard(raw: unknown, companyId: string): ExecutionDashboard {
  const agents = section(raw, 'agents')
  const tasks = section(raw, 'tasks')
  const costs = section(raw, 'costs')
  const budgets = section(raw, 'budgets')
  const top = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  return {
    companyId: typeof top.companyId === 'string' ? top.companyId : companyId,
    agents: {
      active: num(agents.active),
      running: num(agents.running),
      paused: num(agents.paused),
      error: num(agents.error),
    },
    tasks: {
      open: num(tasks.open),
      inProgress: num(tasks.inProgress),
      blocked: num(tasks.blocked),
      done: num(tasks.done),
    },
    costs: {
      monthSpendCents: num(costs.monthSpendCents),
      monthBudgetCents: num(costs.monthBudgetCents),
      monthUtilizationPercent: num(costs.monthUtilizationPercent),
    },
    pendingApprovals: num(top.pendingApprovals),
    budgets: {
      activeIncidents: num(budgets.activeIncidents),
      pendingApprovals: num(budgets.pendingApprovals),
      pausedAgents: num(budgets.pausedAgents),
      pausedProjects: num(budgets.pausedProjects),
    },
  }
}

/**
 * Derive the Attention strip contents. Only non-zero signals surface, ordered
 * most-urgent first (agent errors → blocked work → approvals → budget).
 */
export function deriveAttention(dash: ExecutionDashboard): AttentionItem[] {
  const items: AttentionItem[] = []

  if (dash.agents.error > 0) {
    items.push({
      key: 'agent_errors',
      label: dash.agents.error === 1 ? 'agent error' : 'agent errors',
      count: dash.agents.error,
      prompt: 'Which agents are in an error state right now, and what failed in their last runs?',
    })
  }
  if (dash.tasks.blocked > 0) {
    items.push({
      key: 'blocked',
      label: 'blocked',
      count: dash.tasks.blocked,
      prompt: 'Which issues are currently blocked, and what is blocking each of them?',
    })
  }
  if (dash.pendingApprovals > 0) {
    items.push({
      key: 'approvals',
      label: dash.pendingApprovals === 1 ? 'approval pending' : 'approvals pending',
      count: dash.pendingApprovals,
      prompt: 'What approvals are waiting on me right now? Summarize each one.',
    })
  }
  const budgetSignals =
    dash.budgets.activeIncidents + dash.budgets.pausedAgents + dash.budgets.pausedProjects
  if (budgetSignals > 0) {
    items.push({
      key: 'budget',
      label: budgetSignals === 1 ? 'budget incident' : 'budget incidents',
      count: budgetSignals,
      prompt: 'What budget incidents are active, and which agents or projects are paused because of them?',
    })
  }

  return items
}

/** "$184.50" style display for cent amounts; whole dollars when even. */
export function formatCents(cents: number): string {
  const dollars = cents / 100
  return dollars % 1 === 0 ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`
}
