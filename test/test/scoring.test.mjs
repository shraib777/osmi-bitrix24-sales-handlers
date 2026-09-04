import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUpdateFields,
  calculateScoring,
  calculateScoringInputHash,
  ENUMS,
  FIELDS,
  scoringInputSnapshot,
  shouldSkipScoringUpdate
} from '../src/scoring.mjs';
import {
  buildEstimateUpdateFields,
  calculateEstimateInputHash,
  calculateEstimatePlan,
  ESTIMATE_ENUMS,
  ESTIMATE_FIELDS,
  ESTIMATE_FORMAT_RULES,
  shouldSkipEstimateUpdate
} from '../src/estimate.mjs';

function deal(values) {
  return {
    [FIELDS.direction]: ENUMS.direction.ai,
    [FIELDS.companyType]: ENUMS.companyType.enterprise,
    [FIELDS.budget]: ENUMS.budget.unknown,
    [FIELDS.lpr]: ENUMS.lpr.contact,
    [FIELDS.interest]: ENUMS.interest.yes,
    [FIELDS.request]: ENUMS.request.yes,
    ...values
  };
}

test('enterprise can be taken with unknown budget', () => {
  const result = calculateScoring(deal());
  assert.equal(result.recommendation, ENUMS.recommendation.take);
  assert.match(result.reason, /Рекомендуемое действие:/);
});

test('medium business requires confirmed budget from 3m', () => {
  const result = calculateScoring(deal({
    [FIELDS.companyType]: ENUMS.companyType.medium,
    [FIELDS.budget]: ENUMS.budget.unknown
  }));
  assert.equal(result.recommendation, ENUMS.recommendation.recon);
});

test('medium business can be taken with confirmed budget from 3m', () => {
  const result = calculateScoring(deal({
    [FIELDS.companyType]: ENUMS.companyType.medium,
    [FIELDS.budget]: ENUMS.budget.from3m
  }));
  assert.equal(result.recommendation, ENUMS.recommendation.take);
});

test('government can be taken with unknown budget', () => {
  const result = calculateScoring(deal({
    [FIELDS.companyType]: ENUMS.companyType.government,
    [FIELDS.budget]: ENUMS.budget.unknown
  }));
  assert.equal(result.recommendation, ENUMS.recommendation.take);
});

test('startup with unknown budget goes to recon', () => {
  const result = calculateScoring(deal({
    [FIELDS.companyType]: ENUMS.companyType.startup,
    [FIELDS.budget]: ENUMS.budget.unknown
  }));
  assert.equal(result.recommendation, ENUMS.recommendation.recon);
});

test('startup below 3m is rejected', () => {
  const result = calculateScoring(deal({
    [FIELDS.companyType]: ENUMS.companyType.startup,
    [FIELDS.budget]: ENUMS.budget.below3m
  }));
  assert.equal(result.recommendation, ENUMS.recommendation.reject);
});

test('medium business below 3m is rejected', () => {
  const result = calculateScoring(deal({
    [FIELDS.companyType]: ENUMS.companyType.medium,
    [FIELDS.budget]: ENUMS.budget.below3m
  }));
  assert.equal(result.recommendation, ENUMS.recommendation.reject);
});

test('small business is always rejected', () => {
  const result = calculateScoring(deal({
    [FIELDS.companyType]: ENUMS.companyType.small,
    [FIELDS.budget]: ENUMS.budget.from3m
  }));
  assert.equal(result.recommendation, ENUMS.recommendation.reject);
});

test('irrelevant direction is rejected', () => {
  const result = calculateScoring(deal({
    [FIELDS.direction]: ENUMS.direction.irrelevant
  }));
  assert.equal(result.recommendation, ENUMS.recommendation.reject);
});

test('unknown direction goes to recon', () => {
  const result = calculateScoring(deal({
    [FIELDS.direction]: ENUMS.direction.unknown
  }));
  assert.equal(result.recommendation, ENUMS.recommendation.recon);
});

test('no interest is rejected', () => {
  const result = calculateScoring(deal({
    [FIELDS.interest]: ENUMS.interest.no
  }));
  assert.equal(result.recommendation, ENUMS.recommendation.reject);
});

test('potential interest goes to recon', () => {
  const result = calculateScoring(deal({
    [FIELDS.interest]: ENUMS.interest.potential
  }));
  assert.equal(result.recommendation, ENUMS.recommendation.recon);
});

test('no path to decision maker is rejected', () => {
  const result = calculateScoring(deal({
    [FIELDS.lpr]: ENUMS.lpr.noPath
  }));
  assert.equal(result.recommendation, ENUMS.recommendation.reject);
});

test('unclear request goes to recon', () => {
  const result = calculateScoring(deal({
    [FIELDS.request]: ENUMS.request.no
  }));
  assert.equal(result.recommendation, ENUMS.recommendation.recon);
});

test('update payload contains only automatic scoring fields', () => {
  const result = calculateScoring(deal());
  const inputHash = calculateScoringInputHash(deal());
  const fields = buildUpdateFields(result, inputHash);

  assert.deepEqual(Object.keys(fields).sort(), [
    FIELDS.inputHash,
    FIELDS.reason,
    FIELDS.recommendation
  ].sort());
  assert.equal(Object.hasOwn(fields, FIELDS.decision), false);
  assert.equal(Object.hasOwn(fields, FIELDS.overrideReason), false);
});

test('scoring input snapshot contains only manager scoring inputs', () => {
  const currentDeal = deal({
    TITLE: 'Changed title',
    [FIELDS.recommendation]: ENUMS.recommendation.recon,
    [FIELDS.reason]: 'Old reason'
  });

  assert.deepEqual(scoringInputSnapshot(currentDeal), {
    direction: ENUMS.direction.ai,
    companyType: ENUMS.companyType.enterprise,
    budget: ENUMS.budget.unknown,
    lpr: ENUMS.lpr.contact,
    interest: ENUMS.interest.yes,
    request: ENUMS.request.yes
  });
});

test('scoring input hash changes only when scoring inputs change', () => {
  const base = deal({ TITLE: 'Before' });
  const sameInputs = deal({ TITLE: 'After' });
  const changedInputs = deal({ [FIELDS.budget]: ENUMS.budget.from3m });

  assert.equal(calculateScoringInputHash(base), calculateScoringInputHash(sameInputs));
  assert.notEqual(calculateScoringInputHash(base), calculateScoringInputHash(changedInputs));
});

test('scoring update is skipped only when stored hash and output fields exist', () => {
  const currentDeal = deal();
  const inputHash = calculateScoringInputHash(currentDeal);

  assert.equal(shouldSkipScoringUpdate(currentDeal, inputHash), false);
  assert.equal(shouldSkipScoringUpdate({
    ...currentDeal,
    [FIELDS.inputHash]: inputHash,
    [FIELDS.recommendation]: ENUMS.recommendation.take,
    [FIELDS.reason]: 'Ready'
  }, inputHash), true);
});

test('estimate format fills default planned hours', () => {
  const cases = [
    [ESTIMATE_ENUMS.format.none, 0],
    [ESTIMATE_ENUMS.format.range, 2],
    [ESTIMATE_ENUMS.format.highLevelProposal, 6],
    [ESTIMATE_ENUMS.format.detailedBreakdown, 20],
    [ESTIMATE_ENUMS.format.demoPrototype, 40]
  ];

  for (const [format, plannedHours] of cases) {
    assert.equal(calculateEstimatePlan(deal({ [ESTIMATE_FIELDS.format]: format })).plannedHours, plannedHours);
  }
});

test('tech lead is included only for detailed breakdown', () => {
  assert.match(ESTIMATE_FORMAT_RULES[ESTIMATE_ENUMS.format.detailedBreakdown].team, /техлид/i);
  assert.doesNotMatch(ESTIMATE_FORMAT_RULES[ESTIMATE_ENUMS.format.range].team, /техлид/i);
  assert.doesNotMatch(ESTIMATE_FORMAT_RULES[ESTIMATE_ENUMS.format.highLevelProposal].team, /техлид/i);
  assert.doesNotMatch(ESTIMATE_FORMAT_RULES[ESTIMATE_ENUMS.format.demoPrototype].team, /техлид/i);
});

test('estimate update is skipped when format is unchanged and plan already exists', () => {
  const currentDeal = deal({
    [ESTIMATE_FIELDS.format]: ESTIMATE_ENUMS.format.highLevelProposal,
    [ESTIMATE_FIELDS.plannedHours]: 5
  });
  const inputHash = calculateEstimateInputHash(currentDeal);

  assert.equal(shouldSkipEstimateUpdate(currentDeal, inputHash), false);
  assert.equal(shouldSkipEstimateUpdate({
    ...currentDeal,
    [ESTIMATE_FIELDS.inputHash]: inputHash
  }, inputHash), true);
});

test('estimate update payload contains only automatic estimate fields', () => {
  const currentDeal = deal({ [ESTIMATE_FIELDS.format]: ESTIMATE_ENUMS.format.detailedBreakdown });
  const estimate = calculateEstimatePlan(currentDeal);
  const inputHash = calculateEstimateInputHash(currentDeal);
  const fields = buildEstimateUpdateFields(estimate, inputHash);

  assert.deepEqual(fields, {
    [ESTIMATE_FIELDS.plannedHours]: 20,
    [ESTIMATE_FIELDS.inputHash]: inputHash
  });
});
