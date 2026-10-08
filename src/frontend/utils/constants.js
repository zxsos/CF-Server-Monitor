export const DEFAULT_SITE_TITLE = 'Cloudflare Server Monitor'
export const FRONTEND_WS_TIMEOUT_MINUTES_MAX = 1440

export const TIME = {
  ONLINE_THRESHOLD_MS: 300000,
  RECONNECT_INITIAL_DELAY_MS: 1000,
  RECONNECT_MAX_DELAY_MS: 30000,
  MAX_RECONNECT_ATTEMPTS: 10
}

export const CHART = {
  MAX_DATA_POINTS: 500,
  ANIMATION_DURATION: 300,
  MAX_TICKS: 8,
  MAX_TICKS_HOUR: 12
}

export const HISTORY = {
  LONG_RANGE_POINT_OPTIONS: [60, 120, 180, 240],
  DEFAULT_LONG_RANGE_POINTS: 120
}

export const LATENCY_WINDOW = {
  POINTS: 20,
  HOURS: 2
}

export const PING = {
  GOOD_THRESHOLD: 80,
  WARNING_THRESHOLD: 160,
  CRITICAL_THRESHOLD: 240
}

export const STORAGE = {
  THEME_PREFERENCE: 'theme_preference',
  LANGUAGE_PREFERENCE: 'language_preference',
  VIEW_PREFERENCE: 'monitor_preferred_view',
  JWT_TOKEN: 'jwt_token',
  TURNSTILE_TOKEN: 'turnstile_token',
  TURNSTILE_VERIFIED: 'turnstile_verified'
}
