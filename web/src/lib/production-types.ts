/** Mirrors the manager and worker production-task DTOs returned by the API. */
export interface TaskSummary {
  id: string;
  orderId: string;
  orderNumber: string;
  orderGarmentId: string;
  garmentName: string;
  stageName: string;
  stageOrder: number;
  title: string;
  quantity: number;
  status: 'Pending' | 'Scheduled' | 'InProgress' | 'Paused' | 'Blocked' | 'Completed' | 'Cancelled' | string;
  priority: 'Low' | 'Normal' | 'High' | 'Urgent' | string;
  deadlineUtc: string | null;
  isOverdue: boolean;
  assigneeMembershipId: string | null;
  assigneeName: string | null;
  requiredSkill: string | null;
  estimatedMinutes: number | null;
  needsEstimate: boolean;
  unmetDependencies: number;
  isEligible: boolean;
  isConditional: boolean;
  blockedType: string | null;
  blockedReason: string | null;
  version: number;
}

export interface TaskEvent {
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorUserId: string | null;
  note: string | null;
  atUtc: string;
}

export interface TaskDetail {
  task: TaskSummary;
  instructions: string | null;
  requiredChecks: string[];
  completedChecks: string[];
  requiredMaterials: { name: string; quantity: number; unit: string }[];
  completionNotes: string | null;
  plannedStartUtc: string | null;
  plannedEndUtc: string | null;
  actualStartUtc: string | null;
  completedAtUtc: string | null;
  dependsOn: { taskId: string; title: string; status: string }[];
  garment: { name: string; category: string | null; quantity: number; fabric: string | null; colour: string | null; styleInstructions: string | null; alterationNotes: string | null; measurementSnapshot: unknown | null };
  customerName: string | null;
  events: TaskEvent[];
}

export interface WorkerOption { membershipId: string; displayName: string; isActive: boolean; skills: string[]; openTasks: number }
