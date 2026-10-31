// Pure decisions for amending a confirmed order. No database access, so these can be unit tested without PostgreSQL.
//
// Rule (step-11b): when a garment line's category changes and every task on the order is still unstarted,
// the line's live (Pending or Scheduled) tasks are cancelled and new ones are generated from the workflow that
// the new category selects. Name, measurement and design changes never regenerate tasks.

export function normaliseCategory(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function sameCategory(a, b) {
  return normaliseCategory(a) === normaliseCategory(b);
}

/**
 * The workflow a garment category selects: the first active workflow that lists the category, else the default.
 * `workflows` must already be ordered default-first, as the planner query returns them.
 */
export function pickWorkflow(workflows, category) {
  const wanted = normaliseCategory(category);
  const defaultWorkflow = workflows.find((workflow) => workflow.IsDefault);
  const listed = wanted
    ? workflows.find((workflow) => (workflow.GarmentCategories ?? []).some((name) => normaliseCategory(name) === wanted))
    : undefined;
  return listed ?? defaultWorkflow;
}

/**
 * Decide what happens to one garment line whose category changed.
 *   liveTaskCount        Pending or Scheduled tasks on the line
 *   hasManualTask        a task with no workflow stage (added by hand), so its origin cannot be judged
 *   existingWorkflowIds  workflows the line's tasks came from
 *   newWorkflowId        the workflow the new category selects, or null
 * Returns { action: 'regenerate' | 'keep', reason }.
 */
export function planLineRegeneration({ categoryChanged, liveTaskCount, hasManualTask, existingWorkflowIds, newWorkflowId }) {
  if (!categoryChanged) return { action: 'keep', reason: 'category_unchanged' };
  if (liveTaskCount === 0) return { action: 'keep', reason: 'no_live_tasks' };
  if (hasManualTask) return { action: 'keep', reason: 'manual_tasks' };
  if (!newWorkflowId) return { action: 'keep', reason: 'no_workflow_for_category' };
  const origins = [...new Set(existingWorkflowIds)];
  if (origins.length === 1 && origins[0] === newWorkflowId) return { action: 'keep', reason: 'same_workflow' };
  return { action: 'regenerate', reason: 'workflow_changed' };
}
