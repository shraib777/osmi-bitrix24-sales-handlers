import 'dotenv/config';
import express from 'express';
import { BitrixClient } from './bitrix.mjs';
import {
  buildUpdateFields,
  calculateScoring,
  calculateScoringInputHash,
  shouldSkipScoringUpdate
} from './scoring.mjs';
import {
  buildEstimateUpdateFields,
  calculateEstimateInputHash,
  calculateEstimatePlan,
  shouldSkipEstimateUpdate
} from './estimate.mjs';

const app = express();
const port = Number(process.env.PORT || 8787);
const scoringSecret = process.env.SCORING_SECRET || '';
const dealCategoryId = process.env.BITRIX24_DEAL_CATEGORY_ID ?? '0';
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 30000);
const pollLookbackMinutes = Number(process.env.POLL_LOOKBACK_MINUTES || 10);
const pollBatchSize = Number(process.env.POLL_BATCH_SIZE || 50);
const bitrix = new BitrixClient(process.env.BITRIX24_WEBHOOK_URL);
let pollerRunning = false;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/health', (_request, response) => {
  response.json({ ok: true });
});

app.get('/bitrix/scoring', handleScoringRequest);
app.post('/bitrix/scoring', handleScoringRequest);

async function handleScoringRequest(request, response) {
  try {
    if (scoringSecret && !hasValidSecret(request)) {
      console.log(JSON.stringify({ event: 'scoring.forbidden', method: request.method }));
      response.status(403).json({ ok: false, error: 'Forbidden' });
      return;
    }

    const dealId = extractDealId({ ...request.query, ...request.body });
    if (!dealId) {
      response.status(400).json({ ok: false, error: 'Deal ID is required' });
      return;
    }
    console.log(JSON.stringify({ event: 'scoring.request', method: request.method, dealId }));

    const deal = await bitrix.getDeal(dealId);
    if (dealCategoryId !== '' && String(deal.CATEGORY_ID) !== String(dealCategoryId)) {
      console.log(JSON.stringify({ event: 'scoring.skip', dealId, reason: 'Different deal category' }));
      response.json({ ok: true, dealId, skipped: true, reason: 'Different deal category' });
      return;
    }

    const result = buildDealProcessingResult(deal);
    if (request.query.dryRun === '1' || request.body.dryRun === '1' || request.body.dryRun === true) {
      console.log(JSON.stringify({
        event: 'scoring.dryRun',
        dealId,
        recommendation: result.scoring.recommendation,
        skippedByInputHash: result.skippedByInputHash,
        skippedEstimateByInputHash: result.skippedEstimateByInputHash
      }));
      response.json({
        ok: true,
        dealId,
        dryRun: true,
        skipped: result.skipped,
        fields: result.fields
      });
      return;
    }

    if (result.skipped) {
      console.log(JSON.stringify({ event: 'scoring.skip', dealId, reason: 'Inputs are unchanged', recommendation: result.scoring.recommendation }));
      response.json({
        ok: true,
        dealId,
        skipped: true,
        reason: 'Inputs are unchanged',
        recommendation: result.scoring.recommendation
      });
      return;
    }

    await bitrix.updateDeal(dealId, result.fields);
    console.log(JSON.stringify({
      event: 'scoring.updated',
      dealId,
      recommendation: result.scoring.recommendation
    }));

    response.json({
      ok: true,
      dealId,
      recommendation: result.scoring.recommendation,
      reason: result.scoring.reason
    });
  } catch (error) {
    console.error(error);
    response.status(500).json({ ok: false, error: 'Internal error' });
  }
}

function hasValidSecret(request) {
  return (
    request.query.secret === scoringSecret ||
    request.headers['x-scoring-secret'] === scoringSecret ||
    request.body?.auth?.application_token === scoringSecret ||
    request.body?.auth?.application_token?.[0] === scoringSecret
  );
}

function buildDealProcessingResult(deal) {
  const inputHash = calculateScoringInputHash(deal);
  const estimateInputHash = calculateEstimateInputHash(deal);
  const skippedByInputHash = shouldSkipScoringUpdate(deal, inputHash);
  const skippedEstimateByInputHash = shouldSkipEstimateUpdate(deal, estimateInputHash);
  const scoring = calculateScoring(deal);
  const estimate = calculateEstimatePlan(deal);
  const fields = {
    ...(!skippedByInputHash ? buildUpdateFields(scoring, inputHash) : {}),
    ...(!skippedEstimateByInputHash ? buildEstimateUpdateFields(estimate, estimateInputHash) : {})
  };
  const changed = Object.entries(fields).some(([field, nextValue]) => String(deal[field] || '') !== String(nextValue));

  return {
    scoring,
    fields,
    skippedByInputHash,
    skippedEstimateByInputHash,
    skipped: (skippedByInputHash && skippedEstimateByInputHash) || !changed
  };
}

function extractDealId(body = {}) {
  return (
    body.dealId ||
    body.ID ||
    body.id ||
    body?.data?.FIELDS?.ID ||
    body?.data?.FIELDS?.ID?.[0] ||
    body?.document_id?.[2]?.replace(/^DEAL_/, '')
  );
}

app.listen(port, () => {
  console.log(`Bitrix24 scoring handler is listening on ${port}`);
  startPoller();
});

function startPoller() {
  if (!pollIntervalMs || pollIntervalMs < 1000) return;

  console.log(JSON.stringify({
    event: 'poller.started',
    intervalMs: pollIntervalMs,
    lookbackMinutes: pollLookbackMinutes,
    batchSize: pollBatchSize
  }));

  setInterval(() => {
    runPollerOnce().catch((error) => {
      console.error(JSON.stringify({ event: 'poller.error', message: error.message }));
    });
  }, pollIntervalMs);
}

async function runPollerOnce() {
  if (pollerRunning) {
    console.log(JSON.stringify({ event: 'poller.skip', reason: 'Previous run is still active' }));
    return;
  }

  pollerRunning = true;
  try {
    const modifiedAfter = new Date(Date.now() - pollLookbackMinutes * 60 * 1000).toISOString();
    const deals = await bitrix.call('crm.deal.list', {
      order: { DATE_MODIFY: 'DESC' },
      filter: {
        CATEGORY_ID: dealCategoryId,
        '>DATE_MODIFY': modifiedAfter
      },
      select: [
        'ID',
        'TITLE',
        'DATE_MODIFY',
        'CATEGORY_ID',
        'STAGE_ID',
        'UF_CRM_1759405287275',
        'UF_CRM_1761812533674',
        'UF_CRM_SC_BUDGET',
        'UF_CRM_SC_LPR',
        'UF_CRM_SC_INTEREST',
        'UF_CRM_SC_REQUEST',
        'UF_CRM_SC_RECOMM',
        'UF_CRM_SC_REASON',
        'UF_CRM_SC_INPUT_HASH',
        'UF_CRM_EST_FORMAT',
        'UF_CRM_EST_PLAN_HOURS',
        'UF_CRM_EST_INPUT_HASH'
      ],
      start: 0
    });

    let updated = 0;
    for (const deal of deals.slice(0, pollBatchSize)) {
      const result = buildDealProcessingResult(deal);
      if (result.skipped) continue;

      await bitrix.updateDeal(deal.ID, result.fields);
      updated += 1;
      console.log(JSON.stringify({
        event: 'poller.updated',
        dealId: deal.ID,
        recommendation: result.scoring.recommendation
      }));
    }

    console.log(JSON.stringify({ event: 'poller.done', scanned: deals.length, updated }));
  } finally {
    pollerRunning = false;
  }
}
