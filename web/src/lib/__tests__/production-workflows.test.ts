import { describe, expect, it } from 'vitest';
import { parseWorkflowStages, plannedActualDifference, workerRequestOptions } from '../production-workflows';

describe('production workflow and worker-request helpers', () => {
  it('accepts a valid stage definition and rejects malformed JSON', () => {
    expect(parseWorkflowStages('[{"key":"sewing","name":"Sewing","completionChecks":["Seams inspected"]}]')).toHaveLength(1);
    expect(() => parseWorkflowStages('{not json')).toThrow('valid JSON');
    expect(() => parseWorkflowStages('[]')).toThrow('1–30 stages');
    expect(() => parseWorkflowStages('[{"key":"Bad Key","name":"Sewing"}]')).toThrow('valid lowercase key');
  });

  it('calculates actual minus planned minutes and rejects invalid durations', () => {
    expect(plannedActualDifference(60, 95)).toBe(35);
    expect(plannedActualDifference(90, 45)).toBe(-45);
    expect(() => plannedActualDifference(0, 10)).toThrow('positive whole numbers');
  });

  it('limits worker request types to valid task states and available estimates', () => {
    expect(workerRequestOptions('Pending', 60)).toEqual(['Assistance', 'Reassignment']);
    expect(workerRequestOptions('Completed', 60)).toEqual(['Discrepancy']);
    expect(workerRequestOptions('Completed', null)).toEqual([]);
    expect(workerRequestOptions('Cancelled', 60)).toEqual([]);
  });
});
