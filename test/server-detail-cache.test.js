import test from 'node:test';
import assert from 'node:assert/strict';
import { getServerDetail, clearServerDetailCache } from '../src/utils/cache.js';

function makeDb(first) {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        first
      };
    }
  };
}

test('getServerDetail falls back to the last known value when D1 throws', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  clearServerDetailCache();

  let failing = false;
  const db = makeDb(async () => {
    if (failing) throw new Error('D1_ERROR');
    return { id: 'cache-fallback-server', history_partition_id: 7 };
  });

  const first = await getServerDetail(db, 'cache-fallback-server', true);
  assert.equal(first.history_partition_id, 7);

  failing = true;
  t.mock.timers.tick(121 * 1000);

  const fallback = await getServerDetail(db, 'cache-fallback-server', true);
  assert.equal(fallback.history_partition_id, 7);
});

test('getServerDetail rethrows when there is no cached value to fall back to', async () => {
  clearServerDetailCache();
  const db = makeDb(async () => {
    throw new Error('D1_ERROR');
  });

  await assert.rejects(() => getServerDetail(db, 'cache-no-entry-server', true), /D1_ERROR/);
});
