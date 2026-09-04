export function normalizeWebhookUrl(value) {
  if (!value) return '';
  return String(value).replace(/\/[a-z0-9_.-]+\.json(?:\?.*)?$/i, '/').replace(/\/?$/, '/');
}

export class BitrixClient {
  constructor(webhookUrl) {
    this.webhookUrl = normalizeWebhookUrl(webhookUrl);
    if (!this.webhookUrl) {
      throw new Error('BITRIX24_WEBHOOK_URL is required');
    }
  }

  async call(method, params = {}) {
    const response = await fetch(`${this.webhookUrl}${method}.json`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify(params)
    });

    const payload = await response.json();
    if (!response.ok || payload.error) {
      const message = payload.error_description || payload.error || response.statusText;
      throw new Error(`${method} failed: ${message}`);
    }

    return payload.result;
  }

  async getDeal(id) {
    return this.call('crm.deal.get', { id });
  }

  async updateDeal(id, fields) {
    return this.call('crm.deal.update', { id, fields });
  }
}
