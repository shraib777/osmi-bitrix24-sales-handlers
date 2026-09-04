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
const bitrix = new BitrixClient(process.env.BITRIX24_WEBHOOK_URL);

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
    if (request.query.dryRun === '1' || request.body.dryRun === '1' || request.body.dryRun === true) {
      console.log(JSON.stringify({
        event: 'scoring.dryRun',
        dealId,
        recommendation: scoring.recommendation,
        skippedByInputHash,
        skippedEstimateByInputHash
      }));
      response.json({
        ok: true,
        dealId,
        dryRun: true,
        skipped: skippedByInputHash && skippedEstimateByInputHash,
        fields
      });
      return;
    }

    if (skippedByInputHash && skippedEstimateByInputHash) {
      console.log(JSON.stringify({ event: 'scoring.skip', dealId, reason: 'Inputs are unchanged', recommendation: scoring.recommendation }));
      response.json({
        ok: true,
        dealId,
        skipped: true,
        reason: 'Inputs are unchanged',
        recommendation: scoring.recommendation
      });
      return;
    }

    const changed = Object.entries(fields).some(([field, nextValue]) => String(deal[field] || '') !== String(nextValue));

    if (!changed) {
      console.log(JSON.stringify({ event: 'scoring.skip', dealId, reason: 'Scoring fields are already up to date', recommendation: scoring.recommendation }));
      response.json({
        ok: true,
        dealId,
        skipped: true,
        reason: 'Scoring fields are already up to date',
        recommendation: scoring.recommendation
      });
      return;
    }

    await bitrix.updateDeal(dealId, fields);
    console.log(JSON.stringify({
      event: 'scoring.updated',
      dealId,
      recommendation: scoring.recommendation
    }));

    response.json({
      ok: true,
      dealId,
      recommendation: scoring.recommendation,
      reason: scoring.reason
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
});
