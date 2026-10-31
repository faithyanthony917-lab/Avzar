/**
 * Mirrors the JSON built by backend-node/src/auth/customerRoutes.js:
 *  - templateDto            (customerRoutes.js:211-226)  -> MeasurementTemplate
 *  - GET/POST measurements  (customerRoutes.js:498-516, 567-571) and POST revisions (:731-735) -> MeasurementSet
 *  - GET history            (:748-755)                   -> MeasurementRevision
 *  - GET compare            (:785-797)                   -> MeasurementDiffRow
 */
export const MEASUREMENT_UNITS = ['cm', 'mm', 'in', 'kg', 'lb'] as const;
export type MeasurementUnit = (typeof MEASUREMENT_UNITS)[number];

export interface MeasurementTemplateField {
  key: string;
  label: string;
  unit: MeasurementUnit;
  minValue: number | null;
  maxValue: number | null;
  isRequired: boolean;
  sortOrder: number;
}

export interface MeasurementTemplate {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  fields: MeasurementTemplateField[];
}

/** One recorded value, snapshotted with its label and unit at the time it was saved. */
export interface MeasurementValue {
  key: string;
  label: string;
  unit: MeasurementUnit;
  value: number;
}

export interface MeasurementSet {
  id: string;
  customerId: string;
  templateId: string;
  templateName: string;
  label: string;
  currentRevision: number;
  values: MeasurementValue[];
  updatedAtUtc: string;
}

export interface MeasurementRevision {
  revisionNumber: number;
  values: MeasurementValue[];
  notes: string | null;
  /** The API returns only the author's user id, not a name. */
  recordedByUserId: string | null;
  recordedAtUtc: string;
}

/** from or to is null when the field exists in only one of the two revisions; delta is then null too. */
export interface MeasurementDiffRow {
  key: string;
  label: string;
  unit: MeasurementUnit;
  from: number | null;
  to: number | null;
  delta: number | null;
}

/** Body of POST /api/customers/:id/measurements. */
export interface NewMeasurementSetBody { templateId: string; label: string; values: Record<string, number>; notes?: string }
/** Body of POST /api/measurement-sets/:id/revisions. */
export interface NewRevisionBody { values: Record<string, number>; notes?: string }
