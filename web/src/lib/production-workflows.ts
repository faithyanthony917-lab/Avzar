export type WorkflowStageInput = {
  key: string;
  name: string;
  instructions?: string | null;
  requiredSkill?: string | null;
  defaultMinutes?: number | null;
  isConditional?: boolean;
  requiresApproval?: boolean;
  completionChecks?: string[];
  dependsOn?: string[];
};

export function parseWorkflowStages(input: string): WorkflowStageInput[] {
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { throw new Error('Stages must be valid JSON.'); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 30) {
    throw new Error('Stages must be a JSON array containing 1–30 stages.');
  }
  for (const [index, stage] of parsed.entries()) {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) throw new Error(`Stage ${index + 1} must be an object.`);
    const value = stage as Record<string, unknown>;
    if (typeof value.key !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(value.key)) throw new Error(`Stage ${index + 1} needs a valid lowercase key.`);
    if (typeof value.name !== 'string' || value.name.trim().length < 2 || value.name.trim().length > 80) throw new Error(`Stage ${index + 1} needs a name between 2 and 80 characters.`);
    if (value.completionChecks !== undefined && (!Array.isArray(value.completionChecks) || value.completionChecks.some((check) => typeof check !== 'string'))) throw new Error(`Stage ${index + 1} completionChecks must be an array of strings.`);
    if (value.dependsOn !== undefined && (!Array.isArray(value.dependsOn) || value.dependsOn.some((key) => typeof key !== 'string'))) throw new Error(`Stage ${index + 1} dependsOn must be an array of stage keys.`);
  }
  return parsed as WorkflowStageInput[];
}

export function plannedActualDifference(plannedMinutes: number, actualMinutes: number): number {
  if (!Number.isInteger(plannedMinutes) || plannedMinutes < 1 || !Number.isInteger(actualMinutes) || actualMinutes < 1) {
    throw new Error('Planned and actual minutes must be positive whole numbers.');
  }
  return actualMinutes - plannedMinutes;
}

export function workerRequestOptions(status: string, estimatedMinutes: number | null): Array<'Assistance' | 'Reassignment' | 'Discrepancy'> {
  const options: Array<'Assistance' | 'Reassignment' | 'Discrepancy'> = [];
  if (!['Completed', 'Cancelled'].includes(status)) options.push('Assistance', 'Reassignment');
  if (['InProgress', 'Paused', 'Completed'].includes(status) && estimatedMinutes !== null && estimatedMinutes > 0) options.push('Discrepancy');
  return options;
}
