import { createHash } from 'node:crypto';

export const FIELDS = {
  direction: 'UF_CRM_1759405287275',
  companyType: 'UF_CRM_1761812533674',
  budget: 'UF_CRM_SC_BUDGET',
  lpr: 'UF_CRM_SC_LPR',
  interest: 'UF_CRM_SC_INTEREST',
  request: 'UF_CRM_SC_REQUEST',
  recommendation: 'UF_CRM_SC_RECOMM',
  reason: 'UF_CRM_SC_REASON',
  decision: 'UF_CRM_SC_DECISION',
  overrideReason: 'UF_CRM_SC_OVERRIDE',
  inputHash: 'UF_CRM_SC_INPUT_HASH'
};

export const ENUMS = {
  companyType: {
    medium: '1593',
    enterprise: '2313',
    startup: '1595',
    government: '2315',
    small: '2317'
  },
  direction: {
    web: '1585',
    ai: '1587',
    unknown: '1745',
    irrelevant: '2319'
  },
  budget: {
    from3m: '2321',
    below3m: '2323',
    unknown: '2325'
  },
  lpr: {
    contact: '2327',
    path: '2329',
    noPath: '2331'
  },
  interest: {
    yes: '2333',
    potential: '2335',
    no: '2337'
  },
  request: {
    yes: '2339',
    no: '2341'
  },
  recommendation: {
    take: '2343',
    recon: '2345',
    reject: '2347'
  },
  decision: {
    take: '2349',
    recon: '2351',
    reject: '2353'
  }
};

const TEXT = {
  take: {
    reason: 'Скоринг пройден: направление целевое, интерес подтвержден, ЛПР/путь к ЛПР понятен, бюджет/масштаб достаточен по регламенту.',
    action: 'Рекомендуемое действие: перевести сделку в Целевой лид и продолжить пресейл/подготовку КП.'
  },
  recon: {
    reason: 'Есть потенциал, но данных для квалификации недостаточно: требуется добрать бюджет, ЛПР, направление, конкретику запроса или подтверждение интереса.',
    action: 'Рекомендуемое действие: оставить сделку в квалификации/доразведке и добрать недостающие данные.'
  },
  reject: {
    reason: 'По регламенту есть фактор отказа: малый бизнес, нецелевое направление, нет интереса, нет пути к ЛПР или бюджет ниже 3 млн ₽.',
    action: 'Рекомендуемое действие: перевести сделку в отказ и заполнить причину отказа. Если менеджер не согласен, заполнить Причину ручного override.'
  }
};

function value(deal, field) {
  const raw = deal[field];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function scoringInputSnapshot(deal) {
  return {
    direction: value(deal, FIELDS.direction) || '',
    companyType: value(deal, FIELDS.companyType) || '',
    budget: value(deal, FIELDS.budget) || '',
    lpr: value(deal, FIELDS.lpr) || '',
    interest: value(deal, FIELDS.interest) || '',
    request: value(deal, FIELDS.request) || ''
  };
}

export function calculateScoringInputHash(deal) {
  return createHash('sha256')
    .update(JSON.stringify(scoringInputSnapshot(deal)))
    .digest('hex');
}

export function shouldSkipScoringUpdate(deal, inputHash = calculateScoringInputHash(deal)) {
  return (
    value(deal, FIELDS.inputHash) === inputHash &&
    Boolean(value(deal, FIELDS.recommendation)) &&
    Boolean(value(deal, FIELDS.reason))
  );
}

function isTargetDirection(direction) {
  return direction === ENUMS.direction.web || direction === ENUMS.direction.ai;
}

function isStrategicCompany(companyType) {
  return companyType === ENUMS.companyType.enterprise || companyType === ENUMS.companyType.government;
}

function requiresConfirmedBudget(companyType) {
  return companyType === ENUMS.companyType.medium || companyType === ENUMS.companyType.startup;
}

function hasLprPath(lpr) {
  return lpr === ENUMS.lpr.contact || lpr === ENUMS.lpr.path;
}

export function calculateScoring(deal) {
  const companyType = value(deal, FIELDS.companyType);
  const direction = value(deal, FIELDS.direction);
  const budget = value(deal, FIELDS.budget);
  const lpr = value(deal, FIELDS.lpr);
  const interest = value(deal, FIELDS.interest);
  const request = value(deal, FIELDS.request);

  const hardReject =
    companyType === ENUMS.companyType.small ||
    direction === ENUMS.direction.irrelevant ||
    interest === ENUMS.interest.no ||
    lpr === ENUMS.lpr.noPath ||
    (requiresConfirmedBudget(companyType) && budget === ENUMS.budget.below3m);

  if (hardReject) {
    return {
      recommendation: ENUMS.recommendation.reject,
      reason: `${TEXT.reject.reason} ${TEXT.reject.action}`
    };
  }

  const budgetOk =
    isStrategicCompany(companyType) ||
    (requiresConfirmedBudget(companyType) && budget === ENUMS.budget.from3m);

  const take =
    isTargetDirection(direction) &&
    (isStrategicCompany(companyType) || requiresConfirmedBudget(companyType)) &&
    interest === ENUMS.interest.yes &&
    hasLprPath(lpr) &&
    request === ENUMS.request.yes &&
    budgetOk;

  if (take) {
    return {
      recommendation: ENUMS.recommendation.take,
      reason: `${TEXT.take.reason} ${TEXT.take.action}`
    };
  }

  return {
    recommendation: ENUMS.recommendation.recon,
    reason: `${TEXT.recon.reason} ${TEXT.recon.action}`
  };
}

export function buildUpdateFields(scoring, inputHash) {
  return {
    [FIELDS.recommendation]: scoring.recommendation,
    [FIELDS.reason]: scoring.reason,
    [FIELDS.inputHash]: inputHash
  };
}
