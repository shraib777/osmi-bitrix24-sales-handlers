import { createHash } from 'node:crypto';

export const ESTIMATE_FIELDS = {
  format: 'UF_CRM_EST_FORMAT',
  plannedHours: 'UF_CRM_EST_PLAN_HOURS',
  reason: 'UF_CRM_EST_REASON',
  inputHash: 'UF_CRM_EST_INPUT_HASH'
};

export const ESTIMATE_ENUMS = {
  format: {
    none: '2355',
    range: '2357',
    highLevelProposal: '2359',
    detailedBreakdown: '2361',
    demoPrototype: '2363'
  }
};

export const ESTIMATE_PLAN_HOURS = {
  [ESTIMATE_ENUMS.format.none]: 0,
  [ESTIMATE_ENUMS.format.range]: 2,
  [ESTIMATE_ENUMS.format.highLevelProposal]: 6,
  [ESTIMATE_ENUMS.format.detailedBreakdown]: 20,
  [ESTIMATE_ENUMS.format.demoPrototype]: 40
};

export const ESTIMATE_FORMAT_RULES = {
  [ESTIMATE_ENUMS.format.none]: {
    name: 'Не считаем',
    team: 'Менеджер',
    note: 'Просчет не делается.'
  },
  [ESTIMATE_ENUMS.format.range]: {
    name: 'Экспресс-оценка / вилка',
    team: 'Менеджер + профильный эксперт при необходимости',
    note: 'Быстрый диапазон бюджета и сроков.'
  },
  [ESTIMATE_ENUMS.format.highLevelProposal]: {
    name: 'Верхнеуровневый просчет КП',
    team: 'Менеджер + пресейл/аналитик + профильный эксперт при необходимости',
    note: 'КП с укрупненными блоками работ без глубокой декомпозиции.'
  },
  [ESTIMATE_ENUMS.format.detailedBreakdown]: {
    name: 'Детальный просчет / декомпозиция',
    team: 'Менеджер + пресейл/аналитик + профильный эксперт + техлид',
    note: 'Техлид подключается только на этом формате.'
  },
  [ESTIMATE_ENUMS.format.demoPrototype]: {
    name: 'Демо решения / прототип',
    team: 'Менеджер + пресейл/аналитик + профильный эксперт/разработчик демо',
    note: 'Демо или прототип для подтверждения ценности решения.'
  }
};

function value(deal, field) {
  const raw = deal[field];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function estimateInputSnapshot(deal) {
  return {
    format: value(deal, ESTIMATE_FIELDS.format) || ''
  };
}

export function calculateEstimateInputHash(deal) {
  return createHash('sha256')
    .update(JSON.stringify(estimateInputSnapshot(deal)))
    .digest('hex');
}

export function calculateEstimatePlan(deal) {
  const format = value(deal, ESTIMATE_FIELDS.format);
  if (!format || !Object.hasOwn(ESTIMATE_PLAN_HOURS, format)) {
    return null;
  }

  return {
    format,
    plannedHours: ESTIMATE_PLAN_HOURS[format],
    rule: ESTIMATE_FORMAT_RULES[format]
  };
}

export function shouldSkipEstimateUpdate(deal, inputHash = calculateEstimateInputHash(deal)) {
  const estimate = calculateEstimatePlan(deal);
  if (!estimate) return true;

  return (
    value(deal, ESTIMATE_FIELDS.inputHash) === inputHash &&
    value(deal, ESTIMATE_FIELDS.plannedHours) !== ''
  );
}

export function buildEstimateUpdateFields(estimate, inputHash) {
  if (!estimate) return {};

  return {
    [ESTIMATE_FIELDS.plannedHours]: estimate.plannedHours,
    [ESTIMATE_FIELDS.inputHash]: inputHash
  };
}
