import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseCategory, pickWorkflow, planLineRegeneration, sameCategory } from '../src/auth/orderAmendmentPlan.js';

const standard = { Id: 'w-standard', IsDefault: true, GarmentCategories: [] };
const kaftan = { Id: 'w-kaftan', IsDefault: false, GarmentCategories: ['Kaftan', 'Senator'] };
const workflows = [standard, kaftan];

describe('category comparison', () => {
  it('ignores case, spacing and null', () => {
    assert.equal(normaliseCategory('  Kaftan '), 'kaftan');
    assert.equal(normaliseCategory(null), '');
    assert.ok(sameCategory('Kaftan', ' kaftan'));
    assert.ok(sameCategory(null, ''));
    assert.ok(!sameCategory('Kaftan', 'Agbada'));
    assert.ok(!sameCategory(null, 'Agbada'));
  });
});

describe('pickWorkflow', () => {
  it('chooses the workflow that lists the category, case-insensitively', () => {
    assert.equal(pickWorkflow(workflows, 'senator').Id, 'w-kaftan');
  });
  it('falls back to the default for an unlisted or missing category', () => {
    assert.equal(pickWorkflow(workflows, 'Agbada').Id, 'w-standard');
    assert.equal(pickWorkflow(workflows, null).Id, 'w-standard');
  });
  it('returns undefined when nothing matches and there is no default', () => {
    assert.equal(pickWorkflow([kaftan], 'Agbada'), undefined);
    assert.equal(pickWorkflow([], 'Agbada'), undefined);
  });
});

describe('planLineRegeneration', () => {
  const base = { categoryChanged: true, liveTaskCount: 4, hasManualTask: false, existingWorkflowIds: ['w-standard'], newWorkflowId: 'w-kaftan' };
  it('regenerates when the category selects a different workflow', () => {
    assert.deepEqual(planLineRegeneration(base), { action: 'regenerate', reason: 'workflow_changed' });
  });
  it('keeps tasks when the category did not change', () => {
    assert.equal(planLineRegeneration({ ...base, categoryChanged: false }).reason, 'category_unchanged');
  });
  it('keeps tasks when the new category maps to the same workflow', () => {
    assert.deepEqual(planLineRegeneration({ ...base, newWorkflowId: 'w-standard' }), { action: 'keep', reason: 'same_workflow' });
  });
  it('does not resurrect a line whose tasks were all cancelled', () => {
    assert.deepEqual(planLineRegeneration({ ...base, liveTaskCount: 0 }), { action: 'keep', reason: 'no_live_tasks' });
  });
  it('keeps hand-added tasks, whose origin is unknown', () => {
    assert.equal(planLineRegeneration({ ...base, hasManualTask: true }).reason, 'manual_tasks');
  });
  it('never cancels tasks when the new category has no workflow to replace them', () => {
    assert.deepEqual(planLineRegeneration({ ...base, newWorkflowId: null }), { action: 'keep', reason: 'no_workflow_for_category' });
  });
  it('regenerates when tasks came from several workflows', () => {
    assert.equal(planLineRegeneration({ ...base, existingWorkflowIds: ['w-standard', 'w-other'], newWorkflowId: 'w-standard' }).action, 'regenerate');
  });
});
