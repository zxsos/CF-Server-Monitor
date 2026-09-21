import {
  createTrafficBaselineLookupContext,
  getLatestMetricsForAllServers,
  getTrafficBaselineMetric
} from '../database/schema.js';
import { ensureNotificationDeliveryTable, updateDatabase } from '../database/updateDatabase.js';
import { clearServersListCache, getAllServers } from '../utils/cache.js';
import {
  DEFAULT_NOTIFICATION_TEMPLATE,
  getExpireReminderDays,
  getResourceAlertConfig,
  getResourceAlertRuleThresholds,
  getTgNotifyMinutes,
  loadSiteSettings,
  normalizeExpireNotificationTime,
  normalizeBooleanSetting,
  normalizeNotificationTemplate,
  normalizeNotificationTimezone,
  normalizeNotificationWebhookBody,
  normalizeNotificationWebhookFormat,
  normalizeNotificationWebhookHeaders,
  normalizeNotificationWebhookMethod,
  debug
} from '../utils/settings.js';
import { detectBillingCycle, normalizeBillingCycle, renewExpireDateIfNeeded } from '../utils/serverBilling.js';
import {
  RESOURCE_ALERT_EVALUATE_RULE_BATCH_SIZE,
  RESOURCE_ALERT_EVALUATE_SERVER_BATCH_SIZE,
  RESOURCE_ALERT_NOTIFICATION_SOFT_LIMIT
} from '../utils/config.js';

const RESOURCE_ALERT_STATE_ACTIVE = 'active';
const RESOURCE_ALERT_STATE_RECOVERED = 'recovered';
const RESOURCE_ALERT_STATE_KEY = 'resource_alert_state';
const DAY_MS = 24 * 60 * 60 * 1000;
const TRAFFIC_REPORT_NOTIFICATION_SOFT_LIMIT = 3000;
const NOTIFICATION_DELIVERY_LIMIT = 3000;
const NOTIFICATION_RETRY_BATCH_SIZE = 10;
const NOTIFICATION_DELIVERY_RETENTION_MS = 35 * DAY_MS;
const NOTIFICATION_RETRY_DELAYS_MS = [
  60_000,
  3 * 60_000,
  5 * 60_000,
  10 * 60_000
];
function isMissingColumnError(error) {
  const message = error?.message || String(error);
  return /no such column|has no column/i.test(message);
}

function isMissingNotificationDeliveryTableError(error) {
  const message = error?.message || String(error);
  return /no such table[^\n]*notification_deliveries/i.test(message);
}

async function saveTrafficSnapshots(db, snapshots, serverId) {
  const write = () => db.prepare('UPDATE servers SET traffic_snapshots = ? WHERE id = ?')
    .bind(JSON.stringify(snapshots), serverId).run();

  try {
    await write();
  } catch (error) {
    if (!isMissingColumnError(error)) throw error;

    console.warn('[TrafficReport] 检测到数据库字段缺失，尝试升级数据库后重试...');
    const upgrade = await updateDatabase(db);
    if (!upgrade?.success) throw error;
    await write();
  }
}

function getZonedDateParts(timestamp = Date.now(), timezone = 'UTC') {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const timeZone = normalizeNotificationTimezone(timezone);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(part => [part.type, part.value])
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function formatNotificationTime(timestamp = Date.now(), settings = {}) {
  const parts = getZonedDateParts(timestamp, settings?.notification_timezone);
  if (!parts) return '无效时间';
  const pad = value => String(value).padStart(2, '0');
  return `${Number(parts.year)}/${Number(parts.month)}/${Number(parts.day)} ` +
    `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function formatLastReportTime(timestamp, settings = {}) {
  if (!timestamp) return '无上报记录';

  return formatNotificationTime(timestamp, settings);
}

function isExpireNotificationTimeDue(settings = {}, timestamp = Date.now()) {
  const parts = getZonedDateParts(timestamp, settings.notification_timezone);
  if (!parts) return false;
  return Number(parts.hour) === Number(normalizeExpireNotificationTime(settings.expire_notification_time));
}

function getZonedDateSerial(timestamp, timezone) {
  const parts = getZonedDateParts(timestamp, timezone);
  if (!parts) return NaN;
  return Math.floor(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / DAY_MS);
}

function parseDateSerial(dateString) {
  const match = String(dateString || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return NaN;
  }
  return Math.floor(date.getTime() / DAY_MS);
}

function formatDateSerial(serial) {
  const date = new Date(serial * DAY_MS);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function formatTrafficBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 || size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function isTrafficReportEnabled(settings, field) {
  return normalizeBooleanSetting(settings?.[field]) === 'true';
}

function formatMegabitsPerSecond(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0 Mbps';
  const mbps = number * 8 / 1000 / 1000;
  return `${mbps >= 10 ? mbps.toFixed(1) : mbps.toFixed(2)} Mbps`;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0%';
  return `${number.toFixed(number >= 10 ? 1 : 2)}%`;
}

function formatResourceMetric(metric) {
  const metricLabels = {
    cpu: 'CPU',
    ram: 'RAM',
    disk: 'DISK',
    netIn: '下行网速',
    netOut: '上行网速',
    netTotal: '总网速'
  };
  const label = metricLabels[metric.metric] || metric.metric;
  const valueLabel = metric.mode === 'average' ? '平均' : '当前';
  const value = metric.triggerValue ?? metric.current;
  if (metric.metric === 'cpu' || metric.metric === 'ram' || metric.metric === 'disk') {
    return `${label} ${valueLabel} ${formatPercent(value)} > ${formatPercent(metric.threshold)}`;
  }
  return `${label} ${valueLabel} ${formatMegabitsPerSecond(value)} > ${formatMegabitsPerSecond(metric.threshold)}`;
}

function getResourceMetricLabel(metric) {
  const metricLabels = {
    cpu: 'CPU',
    ram: 'RAM',
    disk: 'DISK',
    netIn: '下行网速',
    netOut: '上行网速',
    netTotal: '总网速'
  };
  return metricLabels[metric?.metric] || metric?.metric || '';
}

function formatResourceMetricValue(metric, value) {
  if (metric?.metric === 'cpu' || metric?.metric === 'ram' || metric?.metric === 'disk') {
    return formatPercent(value);
  }
  return formatMegabitsPerSecond(value);
}

function formatRecoveredResourceMetric(metric) {
  if (!metric || typeof metric !== 'object') return '';
  const label = getResourceMetricLabel(metric);
  const value = metric.current;
  const valueText = formatResourceMetricValue(metric, value);
  const thresholdText = formatResourceMetricValue(metric, metric.threshold);

  return `${label} 当前 ${valueText} < ${thresholdText}`;
}

function parseResourceAlertState(row) {
  if (!row || !row.value) return { signature: '', servers: {} };
  try {
    const parsed = JSON.parse(row.value);
    if (parsed && typeof parsed === 'object' && parsed.servers && typeof parsed.servers === 'object') {
      return {
        signature: String(parsed.signature || ''),
        servers: parsed.servers
      };
    }
  } catch (_) {}
  return { signature: '', servers: {} };
}

function hasResourceAlertStateEntries(alertState) {
  return alertState && typeof alertState === 'object' && Object.keys(alertState).length > 0;
}

function getD1Changes(result) {
  const changes = Number(result?.meta?.changes ?? result?.changes ?? 0);
  return Number.isFinite(changes) && changes > 0 ? changes : 0;
}

export async function clearResourceAlertState(db) {
  if (!db) return false;
  const result = await db.prepare(
    `DELETE FROM settings WHERE key = ?`
  ).bind(RESOURCE_ALERT_STATE_KEY).run();
  return getD1Changes(result) > 0;
}

async function saveResourceAlertState(db, configSignature, alertState, hadStoredState) {
  if (hasResourceAlertStateEntries(alertState)) {
    await db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(RESOURCE_ALERT_STATE_KEY, JSON.stringify({ signature: configSignature, servers: alertState })).run();
    return;
  }

  if (hadStoredState) {
    await clearResourceAlertState(db);
  }
}

function getResourceAlertStateStatus(state) {
  if (!state || typeof state !== 'object') return RESOURCE_ALERT_STATE_ACTIVE;
  return state.status === RESOURCE_ALERT_STATE_RECOVERED
    ? RESOURCE_ALERT_STATE_RECOVERED
    : RESOURCE_ALERT_STATE_ACTIVE;
}

function getResourceAlertStateTimestamp(state, key) {
  if (!state || typeof state !== 'object') return 0;
  const timestamp = Number(state[key] || 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function getStoredResourceAlertMetrics(alert) {
  return (alert?.metrics || []).map(m => ({
    metric: m.metric,
    mode: m.mode,
    threshold: m.threshold,
    triggerValue: m.triggerValue ?? m.current
  }));
}

function canRecoverResourceAlert(evaluation) {
  const metrics = Array.isArray(evaluation?.metrics) ? evaluation.metrics : [];
  return metrics.length > 0 && metrics.every(metric => {
    const current = Number(metric?.current);
    const threshold = Number(metric?.threshold);
    return Number.isFinite(current) && Number.isFinite(threshold) && current < threshold;
  });
}

function getResourceAlertRuleIntervalMs(rule) {
  const minutes = Number(rule?.intervalMinutes);
  const normalizedMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
  return Math.max(5, normalizedMinutes) * 60 * 1000;
}

function formatCurrentTime(settings = {}) {
  return formatNotificationTime(Date.now(), settings);
}

function getResourceAlertRuleStateKey(rule, serverId) {
  return `${rule.id}:${serverId}`;
}

function getResourceAlertRuleName(rule) {
  return String(rule?.name || '资源负载告警').trim() || '资源负载告警';
}

function getResourceAlertRuleServerIds(rule, servers) {
  const allServerIds = servers.map(server => String(server.id)).filter(Boolean);
  if (!Array.isArray(rule.servers) || rule.servers.length === 0) {
    return allServerIds;
  }

  const allowed = new Set(allServerIds);
  const seen = new Set();
  const ids = [];
  for (const serverId of rule.servers) {
    const id = String(serverId || '').trim();
    if (!id || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function formatConciseResourceMetric(metric, valueKey = 'triggerValue') {
  const label = getResourceMetricLabel(metric);
  const value = metric?.[valueKey] ?? metric?.current;
  return `${label} ${formatResourceMetricValue(metric, value)}`;
}

function buildGroupedResourceAlertEntries(nodes, valueKey = 'triggerValue') {
  const groups = new Map();

  for (const item of Array.isArray(nodes) ? nodes : []) {
    const serverName = String(item?.server?.name || '').trim();
    if (!serverName) continue;

    const sourceMetrics = item.alert?.metrics || item.metrics || [];
    if (!Array.isArray(sourceMetrics) || sourceMetrics.length === 0) continue;

    let group = groups.get(serverName);
    if (!group) {
      group = { serverName, metrics: [], seen: new Set() };
      groups.set(serverName, group);
    }

    for (const metric of sourceMetrics) {
      const text = formatConciseResourceMetric(metric, valueKey);
      if (!text || group.seen.has(text)) continue;
      group.seen.add(text);
      group.metrics.push(text);
    }
  }

  return Array.from(groups.values())
    .filter(group => group.metrics.length > 0)
    .map(group => ({
      serverName: group.serverName,
      text: `${group.serverName}  ${group.metrics.join('  ')}`
    }));
}

function appendResourceAlertNotificationChunks(payloads, entries, options) {
  if (!Array.isArray(entries) || entries.length === 0) return;

  let chunkEntries = [];
  let chunkClients = [];
  const flush = () => {
    if (chunkEntries.length === 0) return;

    const nodeList = chunkEntries.map(entry => entry.text).join('\n');
    payloads.push({
      msg: nodeList,
      context: {
        event: options.event,
        emoji: options.emoji,
        clients: chunkClients,
        count: new Set(chunkClients).size || chunkEntries.length,
        message: nodeList
      }
    });
    chunkEntries = [];
    chunkClients = [];
  };

  for (const entry of entries) {
    const candidateEntries = [...chunkEntries, entry];
    const candidateNodeList = candidateEntries.map(item => item.text).join('\n');
    const candidate = candidateNodeList;
    if (chunkEntries.length > 0 && candidate.length > RESOURCE_ALERT_NOTIFICATION_SOFT_LIMIT) {
      flush();
    }
    chunkEntries.push(entry);
    if (entry.serverName) chunkClients.push(entry.serverName);
  }

  flush();
}

export function buildResourceAlertNotificationPayloads(alertNodes, recoveredNodes) {
  const payloads = [];
  appendResourceAlertNotificationChunks(
    payloads,
    buildGroupedResourceAlertEntries(alertNodes, 'triggerValue'),
    {
      event: '资源负载告警',
      emoji: '❌'
    }
  );
  appendResourceAlertNotificationChunks(
    payloads,
    buildGroupedResourceAlertEntries(recoveredNodes, 'current'),
    {
      event: '资源负载恢复',
      emoji: '✅'
    }
  );
  return payloads;
}

async function evaluateResourceAlertRules(stub, ruleRequests) {
  const resultMap = new Map();
  const requests = [];

  for (const item of Array.isArray(ruleRequests) ? ruleRequests : []) {
    const serverIds = Array.isArray(item?.serverIds) ? item.serverIds : [];
    for (let offset = 0; offset < serverIds.length; offset += RESOURCE_ALERT_EVALUATE_SERVER_BATCH_SIZE) {
      requests.push({
        rule: item.rule,
        serverIds: serverIds.slice(offset, offset + RESOURCE_ALERT_EVALUATE_SERVER_BATCH_SIZE)
      });
    }
  }

  for (let offset = 0; offset < requests.length; offset += RESOURCE_ALERT_EVALUATE_RULE_BATCH_SIZE) {
    const batch = requests.slice(offset, offset + RESOURCE_ALERT_EVALUATE_RULE_BATCH_SIZE);
    if (batch.length === 0) continue;

    try {
      const response = await stub.fetch('http://internal/evaluate-resource-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rules: batch.map(({ rule, serverIds }) => ({
            ruleId: rule.id,
            serverIds,
            mode: rule.mode,
            windowMinutes: Number(rule.intervalMinutes),
            thresholds: getResourceAlertRuleThresholds(rule)
          }))
        })
      });

      if (!response.ok) {
        console.warn('[ResourceAlert] DO evaluate failed:', response.status);
        continue;
      }

      const result = await response.json();
      for (const item of Array.isArray(result?.results) ? result.results : []) {
        const ruleId = String(item?.ruleId || '').trim();
        if (!ruleId) continue;
        const existing = resultMap.get(ruleId) || {
          alerts: [],
          evaluatedServerIds: [],
          evaluations: []
        };
        existing.alerts.push(...(Array.isArray(item.alerts) ? item.alerts : []));
        existing.evaluatedServerIds.push(...(
          Array.isArray(item.evaluatedServerIds)
            ? item.evaluatedServerIds.map(id => String(id)).filter(Boolean)
            : []
        ));
        existing.evaluations.push(...(
          Array.isArray(item.evaluations)
            ? item.evaluations.filter(evaluation => evaluation && evaluation.serverId)
            : []
        ));
        resultMap.set(ruleId, existing);
      }
    } catch (e) {
      console.warn('[ResourceAlert] DO evaluate failed:', e?.message || e);
    }
  }

  return resultMap;
}

async function fetchWithRetry(url, options) {
  const response = await fetch(url, options);
  if (response.ok) return response;
  throw new Error(`HTTP ${response.status}`);
}

function zonedDateTimeToTimestamp(parts, timezone) {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, 0, 0);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = getZonedDateParts(guess, timezone);
    if (!actual) break;
    const actualAsUtc = Date.UTC(
      Number(actual.year),
      Number(actual.month) - 1,
      Number(actual.day),
      Number(actual.hour),
      0,
      0
    );
    const difference = desired - actualAsUtc;
    if (difference === 0) return guess;
    guess += difference;
  }
  return guess;
}

function trafficTargetFromDateSerial(serial, hour, timezone) {
  const date = new Date(serial * DAY_MS);
  return zonedDateTimeToTimestamp({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour
  }, timezone);
}

export function getTrafficBaselineTargets(timestamp, timezone, notificationHour) {
  const timeZone = normalizeNotificationTimezone(timezone);
  const hour = Number(normalizeExpireNotificationTime(notificationHour));
  const serial = getZonedDateSerial(timestamp, timeZone);
  const parts = getZonedDateParts(timestamp, timeZone);
  if (!Number.isFinite(serial) || !parts) return null;

  const weekday = ((serial + 4) % 7 + 7) % 7;
  const mondayOffset = (weekday + 6) % 7;
  const todayBoundary = trafficTargetFromDateSerial(serial, hour, timeZone);
  const dailySerial = timestamp >= todayBoundary ? serial : serial - 1;

  let weeklySerial = serial - mondayOffset;
  let weeklyBoundary = trafficTargetFromDateSerial(weeklySerial, hour, timeZone);
  if (timestamp < weeklyBoundary) {
    weeklySerial -= 7;
    weeklyBoundary = trafficTargetFromDateSerial(weeklySerial, hour, timeZone);
  }

  let monthlyBoundary = zonedDateTimeToTimestamp({
    year: Number(parts.year),
    month: Number(parts.month),
    day: 1,
    hour
  }, timeZone);
  if (timestamp < monthlyBoundary) {
    let previousMonthYear = Number(parts.year);
    let previousMonth = Number(parts.month) - 1;
    if (previousMonth === 0) {
      previousMonth = 12;
      previousMonthYear -= 1;
    }
    monthlyBoundary = zonedDateTimeToTimestamp({
      year: previousMonthYear,
      month: previousMonth,
      day: 1,
      hour
    }, timeZone);
  }

  return {
    daily: trafficTargetFromDateSerial(dailySerial, hour, timeZone),
    weekly: weeklyBoundary,
    monthly: monthlyBoundary
  };
}

function stableNotificationKey(value) {
  let hash = 14695981039346656037n;
  for (const char of String(value || '')) {
    hash ^= BigInt(char.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(36);
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/\*\*/g, '')
    .replace(/^[\s✅⚠️⏰💌•-]+/u, '')
    .trim();
}

function inferNotificationEvent(msg) {
  const firstLine = String(msg || '').split('\n').find(line => line.trim());
  return stripMarkdown(firstLine || '通知') || '通知';
}

function escapeJsonStringFragment(value) {
  return JSON.stringify(String(value ?? '')).slice(1, -1);
}

function renderTemplate(template, data, options = {}) {
  const source = String(template || '');
  return source.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = data[key] ?? '';
    return options.jsonString ? escapeJsonStringFragment(value) : String(value);
  });
}

function normalizeNotificationClients(context = {}) {
  const source = Array.isArray(context.clients)
    ? context.clients
    : (context.client ? String(context.client).split(',') : []);
  const clients = source
    .map(client => String(client || '').trim())
    .filter(Boolean);
  if (clients.length > 0) return Array.from(new Set(clients));
  return ['CF Server Monitor'];
}

function inferNotificationEmoji(event) {
  const normalizedEvent = String(event || '');
  if (/恢复|测试|成功/.test(normalizedEvent)) return '✅';
  if (/到期|提醒/.test(normalizedEvent)) return '⚠️';
  if (/离线|告警|失败|异常/.test(normalizedEvent)) return '❌';
  return 'ℹ️';
}

function buildNotificationContext(settings, msg, context = {}) {
  const now = formatCurrentTime(settings);
  const clients = normalizeNotificationClients(context);
  const count = Number.isFinite(Number(context.count)) && Number(context.count) > 0
    ? Number(context.count)
    : clients.length;
  const event = context.event || inferNotificationEvent(msg);
  return {
    title: '💌 Cloudflare Server Monitor',
    event,
    emoji: context.emoji || inferNotificationEmoji(event),
    client: context.client || clients.join(', '),
    clients: clients.join(', '),
    count: String(count),
    message: context.message || String(msg || ''),
    time: context.time || now
  };
}

function formatNotificationMessage(settings, msg, context) {
  const template = normalizeNotificationTemplate(settings?.notification_template || DEFAULT_NOTIFICATION_TEMPLATE);
  return renderTemplate(template, context) || String(msg || '');
}

function parseWebhookHeaders(rawHeaders, context) {
  const raw = renderTemplate(normalizeNotificationWebhookHeaders(rawHeaders), context).trim();
  const headers = {};
  if (!raw) return headers;

  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('headers must be an object');
    }
    for (const [key, value] of Object.entries(parsed)) {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey || /^(host|content-length)$/i.test(normalizedKey)) continue;
      headers[normalizedKey] = String(value ?? '');
    }
    return headers;
  }

  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!key || /^(host|content-length)$/i.test(key)) continue;
    headers[key] = line.slice(index + 1).trim();
  }
  return headers;
}

function buildWebhookQueryParams(settings, context) {
  const rawBody = normalizeNotificationWebhookBody(settings.notification_webhook_body);
  try {
    const body = renderTemplate(rawBody, context, { jsonString: true });
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(([key, value]) => [key, String(value ?? '')]);
    }
  } catch (_) {}

  const params = new URLSearchParams(renderTemplate(rawBody, context));
  return Array.from(params.entries());
}

function buildWebhookUrl(settings, context, method) {
  const rawUrl = settings.notification_webhook_url;
  const renderedUrl = renderTemplate(String(rawUrl || '').trim(), context);
  if (!renderedUrl) throw new Error('missing webhook url');

  const url = new URL(renderedUrl);
  if (method === 'GET') {
    for (const [key, value] of buildWebhookQueryParams(settings, context)) {
      if (!key) continue;
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function buildWebhookBody(settings, context, format) {
  const rawBody = normalizeNotificationWebhookBody(settings.notification_webhook_body);
  if (format === 'json') {
    const body = renderTemplate(rawBody, context, { jsonString: true });
    return JSON.stringify(JSON.parse(body));
  }
  if (format === 'form') {
    try {
      const body = renderTemplate(rawBody, context, { jsonString: true });
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(parsed)) {
          params.set(key, String(value ?? ''));
        }
        return params.toString();
      }
    } catch (_) {}
  }
  return renderTemplate(rawBody, context);
}

async function sendCustomWebhookNotification(settings, context) {
  const method = normalizeNotificationWebhookMethod(settings.notification_webhook_method);
  const format = normalizeNotificationWebhookFormat(settings.notification_webhook_format);
  const endpoint = buildWebhookUrl(settings, context, method);
  const headers = parseWebhookHeaders(settings.notification_webhook_headers, context);
  const options = { method, headers };

  if (method !== 'GET') {
    const contentTypeHeader = Object.keys(headers).find(key => key.toLowerCase() === 'content-type');
    if (!contentTypeHeader) {
      headers['Content-Type'] = format === 'json'
        ? 'application/json'
        : (format === 'form' ? 'application/x-www-form-urlencoded' : 'text/plain; charset=utf-8');
    }
    options.body = buildWebhookBody(settings, context, format);
  }

  await fetchWithRetry(endpoint, options);
}

function hasNotificationTarget(settings) {
  if (normalizeBooleanSetting(settings?.notification_webhook_enabled) === 'true') {
    return String(settings?.notification_webhook_url || '').trim().length > 0;
  }
  return String(settings?.tg_bot_token || '').trim().length > 0;
}

export async function createNotificationSnapshot(db, options = {}) {
  const now = Number(options.now || Date.now());
  const settings = await loadSiteSettings(db);
  const servers = options.includeServers === false ? null : await getAllServers(db);
  const shouldLoadLatest = options.includeLatestMetrics === true && (
    options.forceLatestMetrics === true ||
    (getTgNotifyMinutes(settings.tg_notify) > 0 && hasNotificationTarget(settings))
  );
  const latestMetrics = shouldLoadLatest
    ? await getLatestMetricsForAllServers(db, servers || undefined)
    : null;
  return Object.freeze({ now, settings, servers, latestMetrics });
}

export async function sendNotification(settings, msg, notificationContext = {}) {
  const context = buildNotificationContext(settings || {}, msg, notificationContext);
  const formattedMsg = formatNotificationMessage(settings || {}, msg, context);
  context.notification = formattedMsg;
  const title = context.title;

  if (normalizeBooleanSetting(settings?.notification_webhook_enabled) === 'true') {
    if (!String(settings?.notification_webhook_url || '').trim()) return "自定义 Webhook 通知失败: 缺少 URL";
    try {
      await sendCustomWebhookNotification(settings, context);
      return;
    } catch (e) {
      return "自定义 Webhook 通知发送失败: " + e.message;
    }
  }

  if(!settings.tg_bot_token) return;
  if(settings.tg_bot_token.indexOf("onebot:") == 0) {
    // OneBot 协议 (QQ 等)，私聊格式: onebot:http://127.0.0.1:3000/send_private_msg?access_token=xxx
    // 群聊格式: onebot:http://127.0.0.1:3000/send_group_msg?access_token=xxx
    let onebotUrl = settings.tg_bot_token.replace("onebot:", "");
    const targetId = settings.tg_chat_id || '';
    const isGroup = onebotUrl.indexOf("send_group_msg") != -1;
    if (!targetId) {
      return "OneBot 通知失败: 缺少 tg_chat_id（私人: QQ号，群: group:群号）";
    }
    try {
      const endpoint = onebotUrl.trim();
      const body = {
        [isGroup ? 'group_id' : 'user_id']: targetId,
        message: [
          {
            type: 'text',
            data: {
              text: `${title}\n${String(formattedMsg || '').replace(/\*/g, '')}\n`
            }
          }
        ]
      };
      await fetchWithRetry(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      return "OneBot 通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("open.feishu.cn")) {
    // 飞书机器人 Webhook
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          msg_type: "interactive",
          card: {
            schema: "2.0",
            header: { template: "blue", title: { content: title, tag: "plain_text" } },
            body: { elements: [{ tag: "markdown", content: formattedMsg }] }
          }
        })
      });
    } catch (e) {
      return "飞书通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("oapi.dingtalk.com") || settings.tg_bot_token.includes("api.dingtalk.com")) {
    // 钉钉机器人 Webhook
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: { title: title, text: formattedMsg }
        })
      });
    } catch (e) {
      return "钉钉通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("https://api.day.app/") || settings.tg_bot_token.indexOf("bark:") == 0) {
    let barkUrl = settings.tg_bot_token;
    if(barkUrl.indexOf("bark:") == 0) {
      barkUrl = barkUrl.replace("bark:", "");
    }
    try {
      await fetchWithRetry(barkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          markdown: formattedMsg,
          group: "Cloudflare Server Monitor"
        })
      });
    } catch (e) {
      return "Bark通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("https://qyapi.weixin.qq.com")){
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: "text",
          text: {
            content: formattedMsg.replace(/\*/g, '')
          }
        })
      });
    } catch (e) {
      return "企业微信通知发送失败: " + e.message;
    }
  // Server 酱（使用 sendkey）
  }else if(settings.tg_bot_token.includes("https://sctapi.ftqq.com/") || settings.tg_bot_token.indexOf("server:") == 0) {
    let serverUrl = settings.tg_bot_token;
    if(serverUrl.indexOf("server:") == 0) {
      serverUrl = serverUrl.replace("server:", "");
    }
    try {
      await fetchWithRetry(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          desp: formattedMsg
        })
      });
    } catch (e) {
      return "Server酱通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("https://wxpusher.zjiecode.com/api/send/message/SPT_")) {
    const match = settings.tg_bot_token.match(/\/message\/([^/]+)/);
    const spt = match ? match[1] : null;
    if (!spt) return "WxPusher 通知失败: 无法提取 SPT";
    try {
      await fetchWithRetry("https://wxpusher.zjiecode.com/api/send/message/simple-push", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          "content": formattedMsg,
          "summary": title,
          "contentType":3,
          "spt": spt,
        })
      });
    } catch (e) {
      return "WxPusher通知发送失败: " + e.message;
    }
  }else if(settings.tg_bot_token.includes("/message?token=")) {
    try {
      await fetchWithRetry(settings.tg_bot_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          message: formattedMsg,
          priority: 5,
          extras: {
            "client::display": { "contentType": "text/markdown" }
          }
        })
      });
    } catch (e) {
      return "Gotify通知发送失败: " + e.message;
    }
  }else if(settings.tg_chat_id) {
    // Telegram Bot (最后 fallback，通过 chat_id 判断)
    try {
      await fetchWithRetry(`https://api.telegram.org/bot${settings.tg_bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: settings.tg_chat_id,
          text: formattedMsg
        })
      });
    } catch (e) {
      return "Telegram 通知发送失败: " + e.message;
    }
  }else {
    return "未知的通知方式";
  }
}

function notificationFits(settings, msg, context, limit) {
  const normalizedContext = buildNotificationContext(settings || {}, msg, context || {});
  return formatNotificationMessage(settings || {}, msg, normalizedContext).length <= limit;
}

function splitOversizedNotificationLine(settings, line, context, limit) {
  const chars = Array.from(String(line || ''));
  const chunks = [];
  let offset = 0;
  while (offset < chars.length) {
    let low = 1;
    let high = chars.length - offset;
    let accepted = 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = chars.slice(offset, offset + middle).join('');
      if (notificationFits(settings, candidate, context, limit)) {
        accepted = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    chunks.push(chars.slice(offset, offset + accepted).join(''));
    offset += accepted;
  }
  return chunks;
}

export function splitNotificationPayload(settings, msg, context = {}, limit = NOTIFICATION_DELIVERY_LIMIT) {
  const safeLimit = Math.max(256, Number(limit) || NOTIFICATION_DELIVERY_LIMIT) - 32;
  const lines = String(msg || '').split('\n');
  const chunks = [];
  let current = '';

  const append = line => {
    const candidate = current ? `${current}\n${line}` : line;
    if (!current || notificationFits(settings, candidate, context, safeLimit)) {
      current = candidate;
      return;
    }
    chunks.push(current);
    current = line;
  };

  for (const line of lines) {
    if (notificationFits(settings, line, context, safeLimit)) {
      append(line);
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    for (const part of splitOversizedNotificationLine(settings, line, context, safeLimit)) {
      append(part);
    }
  }
  if (current || chunks.length === 0) chunks.push(current);

  return chunks.map((part, index) => ({
    msg: part,
    context: {
      ...context,
      event: chunks.length > 1
        ? `${context.event || inferNotificationEvent(msg)}（${index + 1}/${chunks.length}）`
        : context.event,
      message: part
    }
  }));
}

export async function enqueueNotification(db, settings, task) {
  if (!db || !task?.businessKey || !task?.type) return 0;
  const now = Number(task.now || Date.now());
  const period = String(task.period || '');
  const payloads = splitNotificationPayload(settings, task.msg, task.context);
  let inserted = 0;

  for (let index = 0; index < payloads.length; index += 1) {
    const businessKey = `${task.businessKey}:part:${index + 1}`;
    const insert = () => db.prepare(`
        INSERT OR IGNORE INTO notification_deliveries
          (business_key, type, period, payload, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `).bind(
        businessKey,
        task.type,
        period,
        JSON.stringify(payloads[index]),
        now,
        Number(task.expiresAt || (now + NOTIFICATION_DELIVERY_RETENTION_MS))
      ).run();
    let result;
    try {
      result = await insert();
    } catch (error) {
      if (!isMissingNotificationDeliveryTableError(error)) throw error;
      await ensureNotificationDeliveryTable(db);
      result = await insert();
    }
    inserted += getD1Changes(result);
  }
  return inserted;
}

export async function dispatchNotificationTasks(db, settings, options = {}) {
  if (!db || !hasNotificationTarget(settings)) return { attempted: 0, sent: 0, failed: 0 };
  const now = Number(options.now || Date.now());
  const limit = Math.max(1, Math.min(50, Number(options.limit) || NOTIFICATION_RETRY_BATCH_SIZE));
  const selectPending = () => db.prepare(`
      SELECT business_key, payload, status, attempt_count, next_attempt_at, lease_until
      FROM notification_deliveries
      WHERE status IN ('pending', 'failed', 'sending') AND expires_at > ?
      ORDER BY created_at ASC
      LIMIT ?
    `).bind(now, limit).all();
  let pendingResult;
  try {
    pendingResult = await selectPending();
  } catch (error) {
    if (!isMissingNotificationDeliveryTableError(error)) throw error;
    await ensureNotificationDeliveryTable(db);
    pendingResult = await selectPending();
  }
  const { results = [] } = pendingResult;

  let attempted = 0;
  let sent = 0;
  let failed = 0;
  for (const row of results) {
    if (Number(row.next_attempt_at || 0) > now) break;
    if (row.status === 'sending' && Number(row.lease_until || 0) > now) break;
    const claim = await db.prepare(`
      UPDATE notification_deliveries
      SET status = 'sending', lease_until = ?
      WHERE business_key = ? AND status <> 'sent'
        AND next_attempt_at <= ? AND lease_until <= ?
    `).bind(now + 2 * 60_000, row.business_key, now, now).run();
    if (getD1Changes(claim) === 0) continue;
    attempted += 1;
    try {
      const payload = JSON.parse(row.payload);
      const error = await sendNotification(settings, payload.msg, payload.context);
      if (error) throw new Error(error);
      await db.prepare(`
        UPDATE notification_deliveries
        SET status = 'sent', sent_at = ?, last_error = '', lease_until = 0
        WHERE business_key = ? AND status = 'sending'
      `).bind(now, row.business_key).run();
      sent += 1;
    } catch (error) {
      const attemptCount = Math.max(0, Number(row.attempt_count) || 0) + 1;
      const errorMessage = String(error?.message || error).slice(0, 500);
      if (attemptCount > NOTIFICATION_RETRY_DELAYS_MS.length) {
        console.warn('[Notification] retries exhausted:', row.business_key, errorMessage);
        await db.prepare(`
          UPDATE notification_deliveries
          SET status = 'sent', sent_at = ?, last_error = '',
              attempt_count = ?, lease_until = 0
          WHERE business_key = ? AND status = 'sending'
        `).bind(
          now,
          attemptCount,
          row.business_key
        ).run();
        failed += 1;
        continue;
      }
      const retryDelay = NOTIFICATION_RETRY_DELAYS_MS[
        Math.min(attemptCount - 1, NOTIFICATION_RETRY_DELAYS_MS.length - 1)
      ];
      await db.prepare(`
        UPDATE notification_deliveries
        SET status = 'failed', failed_at = COALESCE(failed_at, ?), last_error = ?,
            attempt_count = ?, next_attempt_at = ?, lease_until = 0
        WHERE business_key = ? AND status = 'sending'
      `).bind(
        now,
        errorMessage,
        attemptCount,
        now + retryDelay,
        row.business_key
      ).run();
      failed += 1;
    }
  }

  const cleanupDate = new Date(now);
  if (cleanupDate.getUTCHours() === 3 && cleanupDate.getUTCMinutes() === 0) {
    await db.prepare(`
      DELETE FROM notification_deliveries
      WHERE expires_at <= ? OR (status = 'sent' AND sent_at < ?)
    `).bind(now, now - NOTIFICATION_DELIVERY_RETENTION_MS).run();
  }
  return { attempted, sent, failed };
}

export async function checkOfflineNodes(db, options = {}) {
  const snapshot = options.snapshot;
  const siteSettings = snapshot?.settings || await loadSiteSettings(db);
  const tgNotifyMinutes = getTgNotifyMinutes(siteSettings.tg_notify);

  if (tgNotifyMinutes === 0 || !hasNotificationTarget(siteSettings)) return;

  try {
    const allServers = snapshot?.servers || await getAllServers(db);
    const latestMetricsMap = snapshot?.latestMetrics instanceof Map
      ? snapshot.latestMetrics
      : await getLatestMetricsForAllServers(db, allServers);
    
    let alertState = {};
    const stateRes = await db.prepare(
      "SELECT value FROM settings WHERE key = 'alert_state'"
    ).first();
    
    if (stateRes) {
      try {
        alertState = JSON.parse(stateRes.value);
      } catch (e) {
        alertState = {};
      }
    }

    const now = Number(snapshot?.now || options.now || Date.now());
    const offlineThreshold = tgNotifyMinutes * 60 * 1000;
    const offlineNodes = [];
    const recoveredNodes = [];

    for (const s of allServers) {
      if (s.offline_notify_disabled === '1') continue;

      const latestMetrics = latestMetricsMap.get(s.id);
      
      let isOffline = true;
      if (latestMetrics) {
        const diff = now - latestMetrics.timestamp;
        isOffline = diff > offlineThreshold;
      }

      if (isOffline && !alertState[s.id]) {
        offlineNodes.push({
          id: s.id,
          name: s.name,
          lastReportTime: latestMetrics?.timestamp
        });
        alertState[s.id] = {
          offlineSince: Number(latestMetrics?.timestamp || now)
        };
      } else if (!isOffline && alertState[s.id]) {
        recoveredNodes.push({
          ...s,
          offlineSince: Number(alertState[s.id]?.offlineSince || 0)
        });
        delete alertState[s.id];
      }
    }

    const queuedTasks = [];
    if (offlineNodes.length > 0) {
      const nodeList = offlineNodes
        .map(n => `${n.name}  最后上报: ${formatLastReportTime(n.lastReportTime, siteSettings)}`)
        .join('\n');
      const identity = offlineNodes
        .map(n => `${n.id}:${Number(n.lastReportTime || now)}`)
        .sort()
        .join('|');
      queuedTasks.push(enqueueNotification(db, siteSettings, {
        businessKey: `offline:${stableNotificationKey(identity)}`,
        type: 'offline',
        period: String(now),
        now,
        msg: nodeList,
        context: {
          event: '节点离线告警',
          emoji: '❌',
          clients: offlineNodes.map(n => n.name),
          count: offlineNodes.length,
          message: nodeList
        }
      }));
    }

    if (recoveredNodes.length > 0) {
      const nodeList = recoveredNodes.map(n => n.name).join('\n');
      const identity = recoveredNodes
        .map(n => `${n.id}:${n.offlineSince}`)
        .sort()
        .join('|');
      queuedTasks.push(enqueueNotification(db, siteSettings, {
        businessKey: `recovery:${stableNotificationKey(identity)}`,
        type: 'recovery',
        period: String(now),
        now,
        msg: nodeList,
        context: {
          event: '节点恢复通知',
          emoji: '✅',
          clients: recoveredNodes.map(n => n.name),
          count: recoveredNodes.length,
          message: nodeList
        }
      }));
    }
    await Promise.all(queuedTasks);

    if (offlineNodes.length > 0 || recoveredNodes.length > 0) {
      await db.prepare(
        'INSERT INTO settings (key, value) VALUES ("alert_state", ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind(JSON.stringify(alertState)).run();
    }
  } catch (e) {
    console.error('离线检测失败:', e);
  }
}

export async function checkResourceAlerts(env, options = {}) {
  if (!env?.DB || !env?.METRICS_BROADCASTER) return;

  const db = env.DB;
  const snapshot = options.snapshot;
  const siteSettings = snapshot?.settings || await loadSiteSettings(db, { forceRefresh: true });
  if (!hasNotificationTarget(siteSettings)) return;

  const resourceConfig = getResourceAlertConfig(siteSettings);

  if (!resourceConfig.enabled || !resourceConfig.hasRules) {
    await clearResourceAlertState(db);
    return;
  }

  try {
    const allServers = snapshot?.servers || await getAllServers(db);
    if (allServers.length === 0) {
      await clearResourceAlertState(db);
      return;
    }

    const serverMap = new Map(allServers.map(server => [String(server.id), server]));
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    const activeMap = new Map();
    const evaluationMap = new Map();
    const configuredRules = [];
    const configuredRuleServers = [];
    const evaluatedRuleServers = [];

    const configSignature = JSON.stringify({
      rules: resourceConfig.rules.map(rule => ({
        id: rule.id,
        name: rule.name,
        metric: rule.metric,
        threshold: rule.threshold,
        servers: rule.servers,
        intervalMinutes: rule.intervalMinutes,
        mode: rule.mode
      }))
    });

    for (const rule of resourceConfig.rules) {
      const serverIds = getResourceAlertRuleServerIds(rule, allServers);
      if (serverIds.length === 0) continue;

      const ruleServers = [];
      for (const serverId of serverIds) {
        const server = serverMap.get(String(serverId));
        if (!server) continue;
        ruleServers.push({
          key: getResourceAlertRuleStateKey(rule, serverId),
          rule,
          server,
          serverId: String(serverId)
        });
      }
      if (ruleServers.length === 0) continue;
      configuredRuleServers.push(...ruleServers);
      configuredRules.push({ rule, serverIds, ruleServers });
    }

    if (configuredRuleServers.length === 0) {
      await clearResourceAlertState(db);
      return;
    }

    const evaluationResults = await evaluateResourceAlertRules(stub, configuredRules);
    for (const { rule, ruleServers } of configuredRules) {
      const result = evaluationResults.get(String(rule.id));
      if (!result) continue;
      const evaluatedServerIdSet = new Set(result.evaluatedServerIds);
      evaluatedRuleServers.push(...ruleServers.filter(item => evaluatedServerIdSet.has(item.serverId)));
      for (const alert of result.alerts) {
        activeMap.set(getResourceAlertRuleStateKey(rule, alert.serverId), { rule, alert });
      }
      for (const evaluation of result.evaluations || []) {
        evaluationMap.set(getResourceAlertRuleStateKey(rule, evaluation.serverId), evaluation);
      }
    }

    const stateRow = await db.prepare(
      `SELECT value FROM settings WHERE key = ?`
    ).bind(RESOURCE_ALERT_STATE_KEY).first();
    const hadStoredState = !!stateRow;
    const parsedState = parseResourceAlertState(stateRow);
    let alertState = parsedState.servers || {};

    const now = Number(snapshot?.now || options.now || Date.now());
    const alertNodes = [];
    const recoveredNodes = [];
    const validStateKeys = new Set(configuredRuleServers.map(item => item.key));
    let stateChanged = hadStoredState && parsedState.signature !== configSignature;

    for (const key of Object.keys(alertState)) {
      if (!validStateKeys.has(key)) {
        delete alertState[key];
        stateChanged = true;
      }
    }

    for (const { key, rule, server } of evaluatedRuleServers) {
      const active = activeMap.get(key);
      const alert = active?.alert;
      const evaluation = evaluationMap.get(key);
      const currentState = alertState[key];
      const currentStatus = currentState
        ? getResourceAlertStateStatus(currentState)
        : '';
      const ruleIntervalMs = getResourceAlertRuleIntervalMs(rule);

      if (alert) {
        const isActiveAlert = currentStatus === RESOURCE_ALERT_STATE_ACTIVE;
        const recoveredAt = currentStatus === RESOURCE_ALERT_STATE_RECOVERED
          ? getResourceAlertStateTimestamp(currentState, 'recoveredAt')
          : 0;
        if (recoveredAt > 0 && now - recoveredAt < ruleIntervalMs) {
          continue;
        }

        if (!isActiveAlert) {
          alertNodes.push({ rule, server, alert });
          alertState[key] = {
            status: RESOURCE_ALERT_STATE_ACTIVE,
            alertAt: now,
            lastTriggeredAt: now,
            metrics: getStoredResourceAlertMetrics(alert)
          };
          stateChanged = true;
        } else {
          const lastTriggeredAt = getResourceAlertStateTimestamp(currentState, 'lastTriggeredAt');
          if (lastTriggeredAt === 0 || now - lastTriggeredAt >= ruleIntervalMs) {
            alertState[key] = {
              ...currentState,
              status: RESOURCE_ALERT_STATE_ACTIVE,
              alertAt: getResourceAlertStateTimestamp(currentState, 'alertAt') || now,
              lastTriggeredAt: now,
              metrics: getStoredResourceAlertMetrics(alert)
            };
            stateChanged = true;
          }
        }
      } else if (currentState) {
        if (currentStatus === RESOURCE_ALERT_STATE_ACTIVE) {
          if (!canRecoverResourceAlert(evaluation)) {
            continue;
          }

          recoveredNodes.push({ rule, server, metrics: evaluation?.metrics || [] });
          alertState[key] = {
            ...currentState,
            status: RESOURCE_ALERT_STATE_RECOVERED,
            recoveredAt: now,
            metrics: evaluation?.metrics || currentState.metrics
          };
          stateChanged = true;
        } else {
          const recoveredAt = getResourceAlertStateTimestamp(currentState, 'recoveredAt');
          if (recoveredAt === 0 || now - recoveredAt >= ruleIntervalMs) {
            delete alertState[key];
            stateChanged = true;
          }
        }
      }
    }

    const notificationPayloads = buildResourceAlertNotificationPayloads(alertNodes, recoveredNodes);
    if (notificationPayloads.length > 0) {
      const identity = [
        ...alertNodes.map(item => `active:${item.rule.id}:${item.server.id}`),
        ...recoveredNodes.map(item => `recovered:${item.rule.id}:${item.server.id}`)
      ].sort().join('|');
      await Promise.all(notificationPayloads.map((payload, index) => enqueueNotification(db, siteSettings, {
        businessKey: `resource:${stableNotificationKey(identity)}:batch:${index + 1}`,
        type: 'resource',
        period: String(now),
        now,
        msg: payload.msg,
        context: payload.context
      })));
    }

    if (stateChanged) {
      await saveResourceAlertState(db, configSignature, alertState, hadStoredState);
    }
  } catch (e) {
    console.error('资源负载告警检测失败:', e);
  }
}

export function calculateTrafficDelta(current, previous) {
  const currentValue = Math.max(0, Number(current) || 0);
  if (previous === null || previous === undefined) return 0;
  const previousValue = Math.max(0, Number(previous) || 0);
  return currentValue >= previousValue ? currentValue - previousValue : currentValue;
}

export function normalizeTrafficSnapshots(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result = {};
    for (const type of ['daily', 'weekly', 'monthly']) {
      const snapshot = parsed[type];
      if (!snapshot || typeof snapshot !== 'object') continue;
      const time = Number(snapshot.time);
      if (!Number.isFinite(time) || time <= 0) continue;
      result[type] = {
        time,
        rx_bytes: Math.max(0, Number(snapshot.rx_bytes) || 0),
        tx_bytes: Math.max(0, Number(snapshot.tx_bytes) || 0)
      };
    }
    return result;
  } catch (_) {
    return {};
  }
}

export function getTrafficPeriodKeys(timestamp, timezone) {
  const serial = getZonedDateSerial(timestamp, timezone);
  const parts = getZonedDateParts(timestamp, timezone);
  if (!Number.isFinite(serial) || !parts) return null;
  const weekday = ((serial + 4) % 7 + 7) % 7;
  const mondayOffset = (weekday + 6) % 7;
  return {
    daily: formatDateSerial(serial),
    weekly: formatDateSerial(serial - mondayOffset),
    monthly: `${parts.year}-${parts.month}`
  };
}

export function getDueTrafficReportTypes(timestamp, timezone) {
  const keys = getTrafficPeriodKeys(timestamp, timezone);
  if (!keys) return [];
  const parts = getZonedDateParts(timestamp, timezone);
  const serial = getZonedDateSerial(timestamp, timezone);
  const weekday = ((serial + 4) % 7 + 7) % 7;
  const types = [];
  types.push('daily');
  if (weekday === 1) types.push('weekly');
  if (Number(parts.day) === 1) types.push('monthly');
  return types;
}

function isPreviousTrafficPeriod(snapshot, timestamp, type, timezone) {
  const previousTimestamp = Number(snapshot?.time) * 1000;
  if (!Number.isFinite(previousTimestamp) || previousTimestamp >= timestamp) return false;

  const currentKeys = getTrafficPeriodKeys(timestamp, timezone);
  const previousKeys = getTrafficPeriodKeys(previousTimestamp, timezone);
  if (!currentKeys || !previousKeys) return false;

  if (type === 'daily') {
    const difference = parseDateSerial(currentKeys.daily) - parseDateSerial(previousKeys.daily);
    return difference === 0 || difference === 1;
  }
  if (type === 'weekly') {
    const difference = parseDateSerial(currentKeys.weekly) - parseDateSerial(previousKeys.weekly);
    return difference === 0 || difference === 7;
  }
  if (type === 'monthly') {
    const currentParts = getZonedDateParts(timestamp, timezone);
    const previousParts = getZonedDateParts(previousTimestamp, timezone);
    if (!currentParts || !previousParts) return false;
    const difference =
      (Number(currentParts.year) * 12 + Number(currentParts.month)) -
      (Number(previousParts.year) * 12 + Number(previousParts.month));
    return difference === 0 || difference === 1;
  }
  return false;
}

async function claimTrafficReportTypes(db, reportTypes, periodKeys) {
  const claimedTypes = [];
  for (const type of reportTypes) {
    const result = await db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE value <> excluded.value
    `).bind(`traffic_report_last_${type}`, periodKeys[type]).run();
    if (result.meta?.changes > 0) claimedTypes.push(type);
  }
  return claimedTypes;
}

async function releaseTrafficReportTypes(db, reportTypes, periodKeys) {
  await Promise.all(reportTypes.map(type => db.prepare(
    'DELETE FROM settings WHERE key = ? AND value = ?'
  ).bind(`traffic_report_last_${type}`, periodKeys[type]).run()));
}

export function updateTrafficSnapshots(value, currentRx, currentTx, timestamp, types, timezone = 'UTC') {
  const snapshots = normalizeTrafficSnapshots(value);
  const nowSeconds = Math.floor(timestamp / 1000);
  const rx = Math.max(0, Number(currentRx) || 0);
  const tx = Math.max(0, Number(currentTx) || 0);
  const usage = {};
  const missing = [];
  let changed = false;

  for (const type of types) {
    const previous = snapshots[type];
    if (!previous || !isPreviousTrafficPeriod(previous, timestamp, type, timezone)) {
      // No usable baseline (first report of this server, a wiped snapshot, or a
      // gap after missed periods): reset the baseline to the current cumulative
      // counter. The delta stays zero, but the period is flagged so the report
      // can say "no data" instead of a misleading 0 B.
      usage[type] = { rx_bytes: 0, tx_bytes: 0 };
      missing.push(type);
    } else {
      usage[type] = {
        rx_bytes: calculateTrafficDelta(rx, previous.rx_bytes),
        tx_bytes: calculateTrafficDelta(tx, previous.tx_bytes)
      };
    }
    snapshots[type] = { time: nowSeconds, rx_bytes: rx, tx_bytes: tx };
    changed = true;
  }
  return { snapshots, usage, changed, missing };
}

export async function initializeMissingTrafficSnapshots(
  db,
  servers,
  latestMetricsMap,
  timestamp = Date.now(),
  requestedTypes = ['daily', 'weekly', 'monthly'],
  persist = true
) {
  const types = Array.from(new Set(
    (Array.isArray(requestedTypes) ? requestedTypes : [])
      .filter(type => ['daily', 'weekly', 'monthly'].includes(type))
  ));
  if (types.length === 0) return 0;
  const nowSeconds = Math.floor(timestamp / 1000);
  let initialized = 0;

  for (const server of servers || []) {
    const metrics = latestMetricsMap?.get(server.id);
    if (!metrics) continue;

    const snapshots = normalizeTrafficSnapshots(server.traffic_snapshots);
    let changed = false;
    for (const type of types) {
      if (snapshots[type]) continue;
      snapshots[type] = {
        time: nowSeconds,
        rx_bytes: Math.max(0, Number(metrics.net_rx) || 0),
        tx_bytes: Math.max(0, Number(metrics.net_tx) || 0)
      };
      changed = true;
    }
    if (!changed) continue;

    if (persist) await saveTrafficSnapshots(db, snapshots, server.id);
    server.traffic_snapshots = snapshots;
    initialized += 1;
  }

  return initialized;
}

const TRAFFIC_BASELINE_REBUILD_CONCURRENCY = 10;

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export async function rebuildTrafficSnapshotsFromHistory(
  db,
  servers,
  latestMetricsMap,
  timestamp = Date.now(),
  settings = {}
) {
  const targets = getTrafficBaselineTargets(
    timestamp,
    settings.notification_timezone,
    settings.expire_notification_time
  );
  if (!targets) throw new Error('Invalid traffic baseline target time');

  const lookupContext = await createTrafficBaselineLookupContext(
    db,
    Math.min(...Object.values(targets)),
    timestamp
  );
  const types = ['daily', 'weekly', 'monthly'];
  const stats = {
    updated: 0,
    historyMatched: 0,
    fallbackToLatest: 0,
    skipped: 0,
    failed: 0
  };

  await mapWithConcurrency(
    Array.isArray(servers) ? servers : [],
    TRAFFIC_BASELINE_REBUILD_CONCURRENCY,
    async server => {
      const latest = latestMetricsMap?.get(server.id);
      try {
        const baselines = await Promise.all(types.map(type =>
          getTrafficBaselineMetric(db, server, targets[type], lookupContext)
        ));
        const sources = baselines.map(historical => historical || latest);
        if (sources.some(source => !source)) {
          stats.skipped += 1;
          return;
        }
        const snapshots = {};

        for (let index = 0; index < types.length; index += 1) {
          const type = types[index];
          const historical = baselines[index];
          const source = sources[index];
          const sourceTimestamp = Number(historical?.timestamp);
          snapshots[type] = {
            time: Number.isFinite(sourceTimestamp) && sourceTimestamp > 0
              ? Math.floor(sourceTimestamp / 1000)
              : Math.floor(timestamp / 1000),
            rx_bytes: Math.max(0, Number(source.net_rx) || 0),
            tx_bytes: Math.max(0, Number(source.net_tx) || 0)
          };
          if (historical) stats.historyMatched += 1;
          else stats.fallbackToLatest += 1;
        }

        await saveTrafficSnapshots(db, snapshots, server.id);
        server.traffic_snapshots = snapshots;
        stats.updated += 1;
      } catch (error) {
        stats.failed += 1;
        console.error(`[TrafficReport] Failed to rebuild baselines for server ${server.id}:`, error);
      }
    }
  );

  return stats;
}

export function buildTrafficReportContent(servers, rows, label) {
  const usageByServer = new Map((rows || []).map(row => [row.server_id, row]));
  const lines = [];
  const clients = [];
  let totalRx = 0;
  let totalTx = 0;
  let measuredCount = 0;
  const missingLabels = {
    '每日': '暂无昨日数据',
    '每周': '暂无上周数据',
    '每月': '暂无上月数据'
  };

  for (const server of servers) {
    const usage = usageByServer.get(server.id);
    if (!usage) continue;
    clients.push(server.name);
    if (usage.missing) {
      lines.push(`${server.name}  ${missingLabels[label] || '暂无上一周期数据'}`);
      continue;
    }
    const rx = Math.max(0, Number(usage.rx_bytes) || 0);
    const tx = Math.max(0, Number(usage.tx_bytes) || 0);
    totalRx += rx;
    totalTx += tx;
    measuredCount += 1;
    lines.push(`${server.name}  ↓ ${formatTrafficBytes(rx)} + ↑ ${formatTrafficBytes(tx)}  = ${formatTrafficBytes(rx + tx)}`);
  }

  if (lines.length === 0) return null;
  if (measuredCount > 0) {
    lines.push(`总计  ↓ ${formatTrafficBytes(totalRx)} + ↑ ${formatTrafficBytes(totalTx)}  = ${formatTrafficBytes(totalRx + totalTx)}`);
  }
  return {
    msg: lines.join('\n'),
    context: {
      event: `${label}流量报告`,
      emoji: '📊',
      clients,
      count: clients.length,
      message: lines.join('\n')
    }
  };
}

export function buildTrafficReportPayloads(servers, rows, label) {
  const rowServerIds = new Set((Array.isArray(rows) ? rows : []).map(row => row.server_id));
  const normalizedServers = (Array.isArray(servers) ? servers : [])
    .filter(server => rowServerIds.has(server.id));
  const batches = [];
  let currentBatch = [];

  for (const server of normalizedServers) {
    const candidate = [...currentBatch, server];
    const candidateReport = buildTrafficReportContent(candidate, rows, label);
    const exceedsLength = currentBatch.length > 0 &&
      candidateReport?.msg.length > TRAFFIC_REPORT_NOTIFICATION_SOFT_LIMIT;
    if (exceedsLength) {
      batches.push(currentBatch);
      currentBatch = [server];
    } else {
      currentBatch = candidate;
    }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  const totalBatches = batches.length;
  const payloads = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batchServers = batches[index];
    const report = buildTrafficReportContent(batchServers, rows, label);
    if (!report) continue;
    if (totalBatches > 1) {
      report.context.event = `${label}流量报告（${index + 1}/${totalBatches}）`;
    }
    payloads.push(report);
  }

  return payloads;
}

export function collectMissingTrafficBaselineTypes(servers, types) {
  const requestedTypes = Array.isArray(types) ? types : [];
  const missingByServerId = new Map();

  for (const server of servers || []) {
    const snapshots = normalizeTrafficSnapshots(server?.traffic_snapshots);
    const missingTypes = requestedTypes.filter(type => !snapshots[type]);
    if (missingTypes.length > 0) missingByServerId.set(server.id, new Set(missingTypes));
  }

  return missingByServerId;
}

export async function checkTrafficReports(db, options = {}) {
  const snapshot = options.snapshot;
  const settings = snapshot?.settings || await loadSiteSettings(db);
  const now = Number(snapshot?.now || options.now || Date.now());
  if (!isTrafficReportEnabled(settings, 'traffic_report_enabled')) return false;
  const zonedParts = getZonedDateParts(now, settings.notification_timezone);
  if (options.scheduled) {
    // Hourly Cron may be delivered a few minutes late. The period claim below
    // provides deduplication, so matching the configured hour is sufficient.
    if (!isExpireNotificationTimeDue(settings, now)) {
      return false;
    }
  }
  if (options.scheduledMinute !== undefined && Number(zonedParts?.minute) !== Number(options.scheduledMinute)) return false;
  const dueTypes = getDueTrafficReportTypes(now, settings.notification_timezone);
  const requestedTypes = Array.isArray(options.reportTypes) && options.reportTypes.length > 0
    ? new Set(options.reportTypes)
    : null;
  let reportTypes = requestedTypes
    ? dueTypes.filter(type => requestedTypes.has(type))
    : dueTypes;
  if (options.staggered && zonedParts) {
    const baseMinute = 0;
    const slot = Number(zonedParts.minute) - baseMinute;
    const utcDate = new Date(now);
    const isSundayRotationWindow = utcDate.getUTCDay() === 0 && utcDate.getUTCHours() === 0;
    // On the Sunday 00:00 UTC history-table rotation only, leave a wider
    // buffer before traffic reports. Keep the normal slots otherwise.
    // Cron delivery can be delayed by a few minutes. Treat the slots as
    // lower bounds, and let the per-period claim below deduplicate retries.
    const slotMinutes = isSundayRotationWindow
      ? { daily: 5, weekly: 6, monthly: 7 }
      : { daily: 0, weekly: 1, monthly: 2 };
    reportTypes = dueTypes.filter(type =>
      slot >= slotMinutes[type] && (!requestedTypes || requestedTypes.has(type))
    );
  }
  if (reportTypes.length === 0) return false;
  const periodKeys = getTrafficPeriodKeys(now, settings.notification_timezone);
  const claimedReportTypes = await claimTrafficReportTypes(
    db,
    reportTypes,
    periodKeys
  );
  if (claimedReportTypes.length === 0) return false;

  try {
    // Claim first: the existing period marker is also the send-once check.
    // This avoids querying every server and its latest metrics on retries
    // after this period has already been claimed.
    const servers = snapshot?.servers || await getAllServers(db);
    const latestMetrics = snapshot?.latestMetrics instanceof Map
      ? snapshot.latestMetrics
      : await getLatestMetricsForAllServers(db, servers);
    // Seeding below replaces "no baseline" with the current counters, so the
    // periods without a baseline must be captured first: they cannot be
    // measured and must not be reported as 0 B.
    const blankBaselineTypes = collectMissingTrafficBaselineTypes(servers, claimedReportTypes);
    // Missing baselines are filled from the already loaded latest metrics.
    // Keep this in memory because the report roll below persists the same
    // snapshot once, avoiding a second D1 write for the same server.
    await initializeMissingTrafficSnapshots(
      db,
      servers,
      latestMetrics,
      now,
      claimedReportTypes,
      false
    );
    for (const server of servers) {
      server.traffic_snapshots = normalizeTrafficSnapshots(server.traffic_snapshots);
    }
    const usageRows = { daily: [], weekly: [], monthly: [] };
    const pendingSnapshots = [];

    for (const server of servers) {
      const metrics = latestMetrics.get(server.id);
      if (!metrics) continue;
      const result = updateTrafficSnapshots(
        server.traffic_snapshots,
        metrics.net_rx,
        metrics.net_tx,
        now,
        claimedReportTypes,
        settings.notification_timezone
      );
      const blankTypes = blankBaselineTypes.get(server.id);
      for (const type of claimedReportTypes) {
        const missingBaseline = Boolean(blankTypes?.has(type)) || result.missing.includes(type);
        usageRows[type].push(missingBaseline
          ? { server_id: server.id, missing: true }
          : { server_id: server.id, ...result.usage[type] });
      }
      if (result.changed) {
        pendingSnapshots.push({ id: server.id, snapshots: result.snapshots });
        server.traffic_snapshots = result.snapshots;
      }
    }

    if (!hasNotificationTarget(settings)) {
      for (const pending of pendingSnapshots) {
        await saveTrafficSnapshots(db, pending.snapshots, pending.id);
      }
      return true;
    }
    const reportPayloads = {
      daily: claimedReportTypes.includes('daily')
        ? buildTrafficReportPayloads(servers, usageRows.daily, '每日')
        : [],
      weekly: claimedReportTypes.includes('weekly')
        ? buildTrafficReportPayloads(servers, usageRows.weekly, '每周')
        : [],
      monthly: claimedReportTypes.includes('monthly')
        ? buildTrafficReportPayloads(servers, usageRows.monthly, '每月')
        : []
    };
    const reports = Object.values(reportPayloads).flat();
    if (reports.length === 0) {
      await releaseTrafficReportTypes(db, claimedReportTypes, periodKeys);
      return false;
    }

    for (const type of claimedReportTypes) {
      const typeReports = reportPayloads[type] || [];
      for (let index = 0; index < typeReports.length; index += 1) {
        const report = typeReports[index];
        await enqueueNotification(db, settings, {
          businessKey: `traffic:${type}:${periodKeys[type]}:batch:${index + 1}`,
          type: `traffic_${type}`,
          period: periodKeys[type],
          now,
          msg: report.msg,
          context: report.context
        });
      }
    }

    for (const pending of pendingSnapshots) {
      await saveTrafficSnapshots(db, pending.snapshots, pending.id);
    }

    return true;
  } catch (error) {
    try {
      await releaseTrafficReportTypes(db, claimedReportTypes, periodKeys);
    } catch (releaseError) {
      console.warn('[TrafficReport] failed to release report claim:', releaseError);
    }
    throw error;
  }
}

export async function checkExpiringServers(db, options = {}) {
  const snapshot = options.snapshot;
  const siteSettings = snapshot?.settings || await loadSiteSettings(db);
  const now = Number(snapshot?.now || options?.now || Date.now());

  if (options?.scheduled && !isExpireNotificationTimeDue(siteSettings, now)) {
    return false;
  }

  try {
    const allServers = snapshot?.servers || await getAllServers(db);
    const expiringServers = [];
    const reminderDays = getExpireReminderDays(siteSettings.expire_reminder);
    const shouldNotify = reminderDays > 0 && hasNotificationTarget(siteSettings);
    let hasRenewedServers = false;
    const currentDateSerial = getZonedDateSerial(now, siteSettings.notification_timezone);

    for (const s of allServers) {
      if (!s.expire_date) continue;

      const billingCycle = normalizeBillingCycle(detectBillingCycle(s.price) || s.billing_cycle);
      const renewal = renewExpireDateIfNeeded(s.expire_date, billingCycle, s.auto_renewal, now, 1);
      if (renewal.renewed) {
        await db.prepare(
          'UPDATE servers SET expire_date = ?, billing_cycle = ? WHERE id = ?'
        ).bind(renewal.expire_date, billingCycle, s.id).run();
        s.expire_date = renewal.expire_date;
        s.billing_cycle = billingCycle;
        hasRenewedServers = true;
        debug(`[Cron] 服务器 ${s.name} 已自动续费，到期日期更新为 ${s.expire_date}`);
      }

      if (!shouldNotify) continue;

      const expireDateSerial = parseDateSerial(s.expire_date);
      if (!Number.isFinite(expireDateSerial) || !Number.isFinite(currentDateSerial)) continue;

      const days = expireDateSerial - currentDateSerial;

      debug(`[Cron] 检测到服务器 ${s.name} 到期日期 ${s.expire_date}，剩余天数 ${days} 天`);

      if (days > 0 && days <= reminderDays) {
        expiringServers.push({ name: s.name, expire_date: s.expire_date, days });
      }
    }

    if (hasRenewedServers) {
      clearServersListCache();
    }

    if (expiringServers.length > 0) {
      const serverList = expiringServers.map(s => `${s.name}  剩余${s.days}天  ${s.expire_date}`).join('\n');
      const msg = serverList;
      debug(`[Cron] 发送到期提醒通知: ${msg}`);
      const localDate = formatDateSerial(currentDateSerial);
      const identity = expiringServers
        .map(server => `${server.name}:${server.expire_date}`)
        .sort()
        .join('|');
      await enqueueNotification(db, siteSettings, {
        businessKey: `expiry:${localDate}:${stableNotificationKey(identity)}`,
        type: 'expiry',
        period: localDate,
        now,
        msg,
        context: {
          event: '服务器到期提醒',
          emoji: '⚠️',
          clients: expiringServers.map(s => s.name),
          count: expiringServers.length,
          message: serverList
        }
      });
    }
    return true;
  } catch (e) {
    console.error('到期检测失败:', e);
    return false;
  }
}
