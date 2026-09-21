import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTrafficReportContent,
  buildTrafficReportPayloads,
  calculateTrafficDelta,
  checkTrafficReports,
  collectMissingTrafficBaselineTypes,
  dispatchNotificationTasks,
  enqueueNotification,
  getDueTrafficReportTypes,
  getTrafficBaselineTargets,
  getTrafficPeriodKeys,
  initializeMissingTrafficSnapshots,
  normalizeTrafficSnapshots,
  rebuildTrafficSnapshotsFromHistory,
  splitNotificationPayload,
  updateTrafficSnapshots
} from '../src/services/notification.js';

const timezone = 'Asia/Shanghai';
const server = { id: 'server-1', name: 'Tokyo' };

test('traffic snapshots initialize the three lightweight JSON baselines', () => {
  const now = Date.UTC(2026, 8, 1, 1);
  const result = updateTrafficSnapshots('{}', 10_000, 20_000, now, ['daily', 'weekly', 'monthly']);

  assert.equal(result.changed, true);
  assert.deepEqual(result.usage, {
    daily: { rx_bytes: 0, tx_bytes: 0 },
    weekly: { rx_bytes: 0, tx_bytes: 0 },
    monthly: { rx_bytes: 0, tx_bytes: 0 }
  });
  assert.deepEqual(Object.keys(result.snapshots), ['daily', 'weekly', 'monthly']);
  for (const snapshot of Object.values(result.snapshots)) {
    assert.deepEqual(snapshot, {
      time: Math.floor(now / 1000),
      rx_bytes: 10_000,
      tx_bytes: 20_000
    });
  }
});

test('traffic initialization fills only missing baselines', async () => {
  let saved;
  const db = {
    prepare(sql) {
      assert.doesNotMatch(sql, /SELECT|metrics_history/);
      return {
        bind(value, id) {
          saved = { value, id };
          return { run: async () => ({ success: true }) };
        }
      };
    }
  };
  const servers = [{
    id: server.id,
    history_partition_id: 1,
    traffic_snapshots: JSON.stringify({
      daily: { time: 1, rx_bytes: 100, tx_bytes: 200 }
    })
  }];
  const metrics = new Map([[server.id, { net_rx: 1_000, net_tx: 2_000 }]]);
  const now = Date.UTC(2026, 8, 20, 7);

  const count = await initializeMissingTrafficSnapshots(db, servers, metrics, now);
  const snapshots = JSON.parse(saved.value);

  assert.equal(count, 1);
  assert.equal(saved.id, server.id);
  assert.deepEqual(snapshots.daily, { time: 1, rx_bytes: 100, tx_bytes: 200 });
  assert.deepEqual(snapshots.weekly, { time: now / 1000, rx_bytes: 1_000, tx_bytes: 2_000 });
  assert.deepEqual(snapshots.monthly, { time: now / 1000, rx_bytes: 1_000, tx_bytes: 2_000 });
});

test('notification tasks recreate a deleted delivery table and retry', async () => {
  let tableExists = false;
  let createCount = 0;
  const insertedKeys = [];
  const db = {
    prepare(sql) {
      if (/CREATE TABLE IF NOT EXISTS notification_deliveries/.test(sql)) {
        return { run: async () => {
          tableExists = true;
          createCount += 1;
          return { success: true };
        } };
      }
      if (/CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status/.test(sql)) {
        return { run: async () => ({ success: true }) };
      }
      if (/INSERT OR IGNORE INTO notification_deliveries/.test(sql)) {
        return {
          bind(businessKey) {
            return { run: async () => {
              if (!tableExists) throw new Error('no such table: notification_deliveries');
              insertedKeys.push(businessKey);
              return { meta: { changes: 1 } };
            } };
          }
        };
      }
      if (/SELECT business_key, payload, status/.test(sql)) {
        return {
          bind() {
            return { all: async () => {
              if (!tableExists) throw new Error('no such table: notification_deliveries');
              return { results: [] };
            } };
          }
        };
      }
      assert.fail(`Unexpected SQL: ${sql}`);
    }
  };
  const task = {
    businessKey: 'test:delivery',
    type: 'test',
    period: '2026-09-20',
    now: Date.UTC(2026, 8, 20),
    msg: 'test',
    context: { event: 'test' }
  };

  assert.equal(await enqueueNotification(db, {}, task), 1);
  tableExists = false;
  assert.equal(await enqueueNotification(db, {}, { ...task, businessKey: 'test:delivery:retry' }), 1);
  tableExists = false;
  assert.deepEqual(await dispatchNotificationTasks(db, {
    tg_bot_token: 'token',
    tg_chat_id: 'chat'
  }), { attempted: 0, sent: 0, failed: 0 });

  assert.equal(createCount, 3);
  assert.deepEqual(insertedKeys, ['test:delivery:part:1', 'test:delivery:retry:part:1']);
});

test('cron can initialize a missing baseline in memory without an extra D1 write', async () => {
  const now = Date.UTC(2026, 8, 20, 7);
  const servers = [{ id: server.id, traffic_snapshots: '{}' }];
  const metrics = new Map([[server.id, { net_rx: 1_000, net_tx: 2_000 }]]);
  const db = { prepare: () => assert.fail('cron initialization should not write') };

  const count = await initializeMissingTrafficSnapshots(
    db,
    servers,
    metrics,
    now,
    ['daily'],
    false
  );

  assert.equal(count, 1);
  assert.deepEqual(servers[0].traffic_snapshots.daily, {
    time: now / 1000,
    rx_bytes: 1_000,
    tx_bytes: 2_000
  });
});

test('manual traffic rebuild overwrites all baselines from retained history', async () => {
  let saved;
  let saves = 0;
  const queries = [];
  const now = Date.UTC(2026, 8, 20, 2);
  const historicalTimestamp = Date.UTC(2026, 8, 19, 2, 1);
  const db = {
    prepare(sql) {
      if (/sqlite_master/.test(sql)) {
        return { first: async () => ({ name: 'metrics_history_old' }) };
      }
      if (/SELECT timestamp, net_rx, net_tx/.test(sql)) {
        queries.push(sql);
        return {
          bind() {
            return {
              first: async () => /metrics_history_old/.test(sql)
                ? { timestamp: historicalTimestamp, net_rx: 400, net_tx: 700 }
                : { timestamp: now, net_rx: 800, net_tx: 900 }
            };
          }
        };
      }
      return {
        bind(value, id) {
          saved = { value, id };
          return { run: async () => {
            saves += 1;
            return { success: true };
          } };
        }
      };
    }
  };
  const servers = [{
    id: server.id,
    history_partition_id: 1,
    traffic_snapshots: JSON.stringify({
      daily: { time: 1, rx_bytes: 1, tx_bytes: 2 },
      weekly: { time: 1, rx_bytes: 1, tx_bytes: 2 },
      monthly: { time: 1, rx_bytes: 1, tx_bytes: 2 }
    })
  }];
  const metrics = new Map([[server.id, { net_rx: 1_000, net_tx: 2_000 }]]);

  const stats = await rebuildTrafficSnapshotsFromHistory(db, servers, metrics, now, {
    notification_timezone: timezone,
    expire_notification_time: '10'
  });

  const snapshots = JSON.parse(saved.value);
  assert.deepEqual(snapshots.daily, {
    time: now / 1000,
    rx_bytes: 1_000,
    tx_bytes: 2_000
  });
  for (const type of ['weekly', 'monthly']) {
    assert.deepEqual(snapshots[type], {
      time: historicalTimestamp / 1000,
      rx_bytes: 400,
      tx_bytes: 700
    });
  }
  assert.deepEqual(stats, {
    updated: 1,
    historyMatched: 2,
    fallbackToLatest: 1,
    skipped: 0,
    failed: 0
  });
  assert.equal(saves, 1);
  assert.equal(queries.length, 2);
  assert.equal(queries.filter(sql => /FROM metrics_history_old/.test(sql)).length, 2);
  queries.forEach(sql => assert.doesNotMatch(sql, /SELECT \*/));
});

test('manual traffic rebuild falls back to latest counters when history is unavailable', async () => {
  let saved;
  const now = Date.UTC(2026, 8, 20, 7);
  const db = {
    prepare(sql) {
      if (/sqlite_master/.test(sql)) return { first: async () => null };
      if (/SELECT timestamp, net_rx, net_tx/.test(sql)) {
        return { bind: () => ({ first: async () => null }) };
      }
      return {
        bind(value, id) {
          saved = { value, id };
          return { run: async () => ({ success: true }) };
        }
      };
    }
  };
  const servers = [{ id: server.id, history_partition_id: 1, traffic_snapshots: '{}' }];
  const metrics = new Map([[server.id, { net_rx: 1_000, net_tx: 2_000 }]]);

  const stats = await rebuildTrafficSnapshotsFromHistory(db, servers, metrics, now, {
    notification_timezone: timezone,
    expire_notification_time: '10'
  });

  const snapshots = JSON.parse(saved.value);
  for (const type of ['daily', 'weekly', 'monthly']) {
    assert.deepEqual(snapshots[type], {
      time: now / 1000,
      rx_bytes: 1_000,
      tx_bytes: 2_000
    });
  }
  assert.equal(stats.updated, 1);
  assert.equal(stats.historyMatched, 0);
  assert.equal(stats.fallbackToLatest, 3);
});

test('traffic baseline targets honor timezone and notification hour', () => {
  const targets = getTrafficBaselineTargets(
    Date.UTC(2026, 8, 20, 7),
    'Asia/Shanghai',
    '10'
  );

  assert.equal(new Date(targets.daily).toISOString(), '2026-09-20T02:00:00.000Z');
  assert.equal(new Date(targets.weekly).toISOString(), '2026-09-14T02:00:00.000Z');
  assert.equal(new Date(targets.monthly).toISOString(), '2026-09-01T02:00:00.000Z');
});

test('traffic baseline targets keep the previous period before its scheduled boundary', () => {
  const targets = getTrafficBaselineTargets(
    Date.UTC(2026, 8, 21, 1, 59),
    'Asia/Shanghai',
    '10'
  );

  assert.equal(new Date(targets.daily).toISOString(), '2026-09-20T02:00:00.000Z');
  assert.equal(new Date(targets.weekly).toISOString(), '2026-09-14T02:00:00.000Z');
  assert.equal(new Date(targets.monthly).toISOString(), '2026-09-01T02:00:00.000Z');

  const nextReport = Date.UTC(2026, 8, 21, 2);
  const result = updateTrafficSnapshots({
    daily: { time: targets.daily / 1000, rx_bytes: 100, tx_bytes: 200 },
    weekly: { time: targets.weekly / 1000, rx_bytes: 100, tx_bytes: 200 }
  }, 300, 500, nextReport, ['daily', 'weekly'], 'Asia/Shanghai');

  assert.deepEqual(result.usage.daily, { rx_bytes: 200, tx_bytes: 300 });
  assert.deepEqual(result.usage.weekly, { rx_bytes: 200, tx_bytes: 300 });
});

test('monthly traffic baseline switches at the configured hour on the first day', () => {
  const beforeBoundary = getTrafficBaselineTargets(
    Date.UTC(2026, 9, 1, 1, 59),
    'Asia/Shanghai',
    '10'
  );
  const atBoundary = getTrafficBaselineTargets(
    Date.UTC(2026, 9, 1, 2),
    'Asia/Shanghai',
    '10'
  );

  assert.equal(new Date(beforeBoundary.monthly).toISOString(), '2026-09-01T02:00:00.000Z');
  assert.equal(new Date(atBoundary.monthly).toISOString(), '2026-10-01T02:00:00.000Z');
});

test('traffic snapshots calculate usage and roll only crossed period boundaries', () => {
  const first = updateTrafficSnapshots('{}', 10_000, 20_000, Date.UTC(2026, 8, 6, 1), ['daily', 'weekly', 'monthly']);
  const monday = updateTrafficSnapshots(first.snapshots, 15_000, 28_000, Date.UTC(2026, 8, 7, 1), ['daily', 'weekly']);

  assert.deepEqual(monday.usage.daily, { rx_bytes: 5_000, tx_bytes: 8_000 });
  assert.deepEqual(monday.usage.weekly, { rx_bytes: 5_000, tx_bytes: 8_000 });
  assert.equal(monday.usage.monthly, undefined);
  assert.equal(monday.snapshots.daily.rx_bytes, 15_000);
  assert.equal(monday.snapshots.weekly.rx_bytes, 15_000);
  assert.equal(monday.snapshots.monthly.rx_bytes, 10_000);
});

test('traffic snapshots calculate partial usage from a baseline in the same period', () => {
  const first = updateTrafficSnapshots('{}', 10_000, 20_000, Date.UTC(2026, 8, 7, 1), ['daily', 'weekly', 'monthly']);
  const partial = updateTrafficSnapshots(first.snapshots, 15_000, 28_000, Date.UTC(2026, 8, 7, 2), ['daily', 'weekly', 'monthly']);

  assert.deepEqual(partial.usage, {
    daily: { rx_bytes: 5_000, tx_bytes: 8_000 },
    weekly: { rx_bytes: 5_000, tx_bytes: 8_000 },
    monthly: { rx_bytes: 5_000, tx_bytes: 8_000 }
  });
});

test('traffic snapshots reset safely after missed report periods', () => {
  const first = updateTrafficSnapshots('{}', 10_000, 20_000, Date.UTC(2026, 8, 1, 1), ['daily']);
  const afterMissedDays = updateTrafficSnapshots(
    first.snapshots,
    25_000,
    40_000,
    Date.UTC(2026, 8, 4, 1),
    ['daily']
  );

  assert.deepEqual(afterMissedDays.usage.daily, { rx_bytes: 0, tx_bytes: 0 });
  assert.equal(afterMissedDays.snapshots.daily.rx_bytes, 25_000);
});

test('traffic snapshot period keys honor the configured notification timezone', () => {
  const sundayUtc = Date.UTC(2026, 8, 6, 16, 30);
  assert.deepEqual(getTrafficPeriodKeys(sundayUtc, timezone), {
    daily: '2026-09-07',
    weekly: '2026-09-07',
    monthly: '2026-09'
  });

  assert.deepEqual(getDueTrafficReportTypes(sundayUtc, timezone), ['daily', 'weekly']);

  const monthStart = updateTrafficSnapshots('{}', 1_000, 2_000, Date.UTC(2026, 8, 30, 15), ['monthly']);
  const october = updateTrafficSnapshots(monthStart.snapshots, 3_000, 5_000, Date.UTC(2026, 8, 30, 16), ['monthly']);
  assert.equal(october.snapshots.monthly.rx_bytes, 3_000);
  assert.equal(october.snapshots.monthly.tx_bytes, 5_000);
});

test('traffic snapshot parsing and counter reset handling are backward safe', () => {
  assert.deepEqual(normalizeTrafficSnapshots('invalid json'), {});
  assert.equal(calculateTrafficDelta(15_000, 10_000), 5_000);
  assert.equal(calculateTrafficDelta(2_048, 50_000), 2_048);
  assert.equal(calculateTrafficDelta(2_048, null), 0);
});

test('traffic report content formats per-server usage and totals', () => {
  const report = buildTrafficReportContent([server], [{
    server_id: server.id,
    rx_bytes: 5_000,
    tx_bytes: 8_000
  }], '每日');

  assert.match(report.context.event, /每日流量报告/);
  assert.match(report.msg, /Tokyo/);
  assert.match(report.msg, /↓ 4\.88 KB/);
  assert.match(report.msg, /↑ 7\.81 KB/);
  assert.match(report.msg, /总计/);
});

test('traffic report content explains missing previous-period baselines', () => {
  const labels = [
    ['每日', '暂无昨日数据'],
    ['每周', '暂无上周数据'],
    ['每月', '暂无上月数据']
  ];
  for (const [label, expected] of labels) {
    const report = buildTrafficReportContent([server], [{
      server_id: server.id,
      missing: true
    }], label);
    assert.match(report.msg, new RegExp(expected));
    assert.doesNotMatch(report.msg, /总计/);
  }
});

test('traffic report payloads do not split solely by server count', () => {
  const servers = Array.from({ length: 51 }, (_, index) => ({
    id: `server-${index + 1}`,
    name: `S${index + 1}`
  }));
  const rows = servers.map(item => ({
    server_id: item.id,
    rx_bytes: 1_000,
    tx_bytes: 2_000
  }));

  const reports = buildTrafficReportPayloads(servers, rows, '每日');

  assert.equal(reports.length, 1);
  assert.equal(reports[0].context.count, 51);
});

test('generic notification splitting measures the rendered notification', () => {
  const settings = {
    notification_template: '{{event}}\n{{message}}\n' + 'x'.repeat(120),
    notification_timezone: 'UTC'
  };
  const message = Array.from({ length: 30 }, (_, index) => `${index}-${'y'.repeat(30)}`).join('\n');
  const payloads = splitNotificationPayload(settings, message, { event: '节点离线告警' }, 500);

  assert.ok(payloads.length > 1);
  assert.ok(payloads.every(payload => payload.context.message === payload.msg));
  assert.ok(payloads.every(payload => payload.context.event.includes('/')));
});

test('traffic report payloads also split before the message soft limit', () => {
  const servers = Array.from({ length: 20 }, (_, index) => ({
    id: `long-server-${index + 1}`,
    name: `${index + 1}-${'x'.repeat(180)}`
  }));
  const rows = servers.map(item => ({
    server_id: item.id,
    rx_bytes: 1_000,
    tx_bytes: 2_000
  }));

  const reports = buildTrafficReportPayloads(servers, rows, '每日');

  assert.ok(reports.length > 1);
  assert.ok(reports.every(report => report.msg.length <= 3000));
});

test('traffic snapshots flag every period without a usable baseline', () => {
  const now = Date.UTC(2026, 8, 20, 2);
  const first = updateTrafficSnapshots('{}', 10_000, 20_000, now, ['daily', 'weekly', 'monthly']);

  assert.deepEqual(first.missing, ['daily', 'weekly', 'monthly']);
  assert.deepEqual(first.usage.daily, { rx_bytes: 0, tx_bytes: 0 });

  const samePeriod = updateTrafficSnapshots(
    first.snapshots,
    15_000,
    28_000,
    Date.UTC(2026, 8, 20, 4),
    ['daily', 'weekly', 'monthly']
  );
  assert.deepEqual(samePeriod.missing, []);
  assert.deepEqual(samePeriod.usage.daily, { rx_bytes: 5_000, tx_bytes: 8_000 });

  const afterGap = updateTrafficSnapshots(first.snapshots, 25_000, 40_000, Date.UTC(2026, 8, 24, 2), ['daily']);
  assert.deepEqual(afterGap.missing, ['daily']);
  assert.deepEqual(afterGap.usage.daily, { rx_bytes: 0, tx_bytes: 0 });
});

test('traffic baseline detection only reports periods that are actually absent', () => {
  const servers = [
    { id: 'kept', traffic_snapshots: JSON.stringify({ daily: { time: 1, rx_bytes: 1, tx_bytes: 2 } }) },
    { id: 'blank', traffic_snapshots: '{}' },
    { id: 'broken', traffic_snapshots: 'invalid json' }
  ];

  const missing = collectMissingTrafficBaselineTypes(servers, ['daily', 'weekly']);

  assert.deepEqual([...missing.get('kept')], ['weekly']);
  assert.deepEqual([...missing.get('blank')], ['daily', 'weekly']);
  assert.deepEqual([...missing.get('broken')], ['daily', 'weekly']);
  assert.equal(missing.size, 3);
});

function createTrafficReportDb() {
  const saved = [];
  const inserted = [];
  const db = {
    prepare(sql) {
      if (/INSERT INTO settings/.test(sql)) {
        return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
      }
      if (/UPDATE servers SET traffic_snapshots/.test(sql)) {
        return {
          bind(value, id) {
            return { run: async () => {
              saved.push({ value, id });
              return { success: true };
            } };
          }
        };
      }
      if (/INSERT OR IGNORE INTO notification_deliveries/.test(sql)) {
        return {
          bind(...args) {
            return { run: async () => {
              inserted.push(args);
              return { meta: { changes: 1 } };
            } };
          }
        };
      }
      assert.fail(`Unexpected SQL: ${sql}`);
    }
  };
  return { db, saved, inserted };
}

function trafficReportSettings() {
  return {
    traffic_report_enabled: 'true',
    notification_timezone: timezone,
    expire_notification_time: '10',
    tg_bot_token: 'token',
    tg_chat_id: 'chat'
  };
}

test('cron traffic reports a wiped baseline as unavailable instead of 0 B', async () => {
  const now = Date.UTC(2026, 8, 20, 2);
  const servers = [{ id: server.id, name: server.name, traffic_snapshots: '{}' }];
  const latestMetrics = new Map([[server.id, { net_rx: 5_000, net_tx: 8_000 }]]);
  const { db, saved, inserted } = createTrafficReportDb();

  const handled = await checkTrafficReports(db, {
    snapshot: { settings: trafficReportSettings(), now, servers, latestMetrics }
  });

  assert.equal(handled, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0][0], 'traffic:daily:2026-09-20:batch:1:part:1');
  assert.equal(inserted[0][1], 'traffic_daily');

  const payload = JSON.parse(inserted[0][3]);
  assert.match(payload.msg, /Tokyo/);
  assert.match(payload.msg, /暂无昨日数据/);
  assert.doesNotMatch(payload.msg, /0 B/);
  assert.doesNotMatch(payload.msg, /总计/);

  // The blank baseline is still rolled forward so the next period stays correct.
  assert.deepEqual(JSON.parse(saved[0].value).daily, {
    time: Math.floor(now / 1000),
    rx_bytes: 5_000,
    tx_bytes: 8_000
  });
});

test('cron traffic reports a baseline from a non-adjacent period as unavailable', async () => {
  const now = Date.UTC(2026, 8, 20, 2);
  const staleTime = Math.floor(Date.UTC(2026, 8, 15, 2) / 1000);
  const servers = [{
    id: server.id,
    name: server.name,
    traffic_snapshots: JSON.stringify({
      daily: { time: staleTime, rx_bytes: 1_000, tx_bytes: 2_000 }
    })
  }];
  const latestMetrics = new Map([[server.id, { net_rx: 5_000, net_tx: 8_000 }]]);
  const { db, saved, inserted } = createTrafficReportDb();

  const handled = await checkTrafficReports(db, {
    snapshot: { settings: trafficReportSettings(), now, servers, latestMetrics }
  });

  assert.equal(handled, true);
  assert.equal(inserted.length, 1);

  const payload = JSON.parse(inserted[0][3]);
  assert.match(payload.msg, /暂无昨日数据/);
  assert.doesNotMatch(payload.msg, /0 B/);
  assert.deepEqual(JSON.parse(saved[0].value).daily, {
    time: Math.floor(now / 1000),
    rx_bytes: 5_000,
    tx_bytes: 8_000
  });
});
