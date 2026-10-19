import test from 'node:test';
import assert from 'node:assert/strict';
import { handleUpdate, normalizeMetricSamples } from '../src/handlers/update.js';
import { UPDATE_MAX_BATCH_SAMPLES, UPDATE_MAX_REQUEST_BYTES } from '../src/utils/config.js';

function createRequest(body, headers = {}) {
  return new Request('https://example.com/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body
  });
}

test('handleUpdate rejects oversized payload before touching D1', async () => {
  let dbTouched = false;
  const env = {
    API_SECRET: 'secret',
    DB: {
      prepare() {
        dbTouched = true;
        throw new Error('D1 should not be touched');
      }
    }
  };

  const response = await handleUpdate(
    createRequest('{}', { 'Content-Length': String(UPDATE_MAX_REQUEST_BYTES + 1) }),
    env,
    { waitUntil() {} }
  );

  assert.equal(response.status, 413);
  assert.equal(response.headers.get('X-CFSM-Agent-Status'), 'payload_too_large');
  assert.equal(dbTouched, false);
});

test('handleUpdate without Content-Length skips the size guard', async () => {
  let queriedId = '';
  const env = {
    API_SECRET: 'secret',
    DB: {
      prepare() {
        return {
          bind(id) {
            queriedId = id;
            return { first: async () => null };
          }
        };
      }
    }
  };

  const response = await handleUpdate(
    createRequest(JSON.stringify({ id: 'payload-limit-test-server', secret: 'secret' })),
    env,
    { waitUntil() {} }
  );

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('X-CFSM-Agent-Status'), 'server_not_found');
  assert.equal(response.headers.get('Retry-After'), '300');
  assert.equal(queriedId, 'payload-limit-test-server');
});

test('normalizeMetricSamples keeps only the latest samples before processing', () => {
  const samples = Array.from({ length: UPDATE_MAX_BATCH_SAMPLES + 200 }, (_, index) => ({
    ts: 1700000000 + index,
    metrics: { cpu: String(index) }
  }));

  const result = normalizeMetricSamples({ samples });

  assert.equal(result.length, UPDATE_MAX_BATCH_SAMPLES);
  assert.equal(result[0].metrics.cpu, String(200));
  assert.equal(result[result.length - 1].metrics.cpu, String(UPDATE_MAX_BATCH_SAMPLES + 199));
});

test('normalizeMetricSamples keeps the newest samples for out-of-order batches', () => {
  const total = UPDATE_MAX_BATCH_SAMPLES + 200;
  const samples = Array.from({ length: total }, (_, index) => ({
    ts: 1700000000000 + (total - 1 - index),
    metrics: { cpu: String(index) }
  }));

  const result = normalizeMetricSamples({ samples });

  assert.equal(result.length, UPDATE_MAX_BATCH_SAMPLES);
  assert.equal(result[result.length - 1].ts, 1700000000000 + total - 1);
  assert.equal(result[0].ts, 1700000000000 + total - UPDATE_MAX_BATCH_SAMPLES);
});
