import { buildAuthCookie, checkAuth, generateToken } from '../middleware/auth.js';
import { clearSiteSettingsCache } from '../utils/settings.js';

const GITHUB_OAUTH_STATE_COOKIE = 'cfsm_github_oauth_state';
const GITHUB_OAUTH_STATE_TTL_SECONDS = 600;
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

function isEnabled(value) {
  return value === true || value === 'true';
}

function normalizeGithubUserId(value) {
  const userId = String(value || '').trim();
  return /^[1-9]\d*$/.test(userId) ? userId : '';
}

export function hasGithubOAuthCredentials(settings = {}) {
  return Boolean(String(settings.github_client_id || '').trim()) &&
    Boolean(String(settings.github_client_secret || '').trim());
}

export function isGithubOAuthConfigured(settings = {}) {
  return isEnabled(settings.github_oauth_enabled) && hasGithubOAuthCredentials(settings);
}

export function isGithubOAuthReady(settings = {}) {
  return isGithubOAuthConfigured(settings) && Boolean(normalizeGithubUserId(settings.github_user_id));
}

function getCookieValue(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const prefix = `${name}=`;
  for (const part of cookie.split(';')) {
    const item = part.trim();
    if (!item.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(item.slice(prefix.length));
    } catch (_) {
      return item.slice(prefix.length);
    }
  }
  return '';
}

function stateMatches(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function getCallbackUrl(request) {
  return new URL('/auth/github/callback', request.url).toString();
}

function buildStateCookie(request, state) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${GITHUB_OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; Max-Age=${GITHUB_OAUTH_STATE_TTL_SECONDS}; Path=/auth/github/callback; HttpOnly; SameSite=Lax${secure}`;
}

function buildClearStateCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${GITHUB_OAUTH_STATE_COOKIE}=; Max-Age=0; Path=/auth/github/callback; HttpOnly; SameSite=Lax${secure}`;
}

function redirectResponse(location, cookies = []) {
  const headers = new Headers({
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer'
  });
  for (const cookie of cookies) {
    if (cookie) headers.append('Set-Cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
}

function redirectToAdmin(request, error = '', cookies = [], params = {}) {
  const target = new URL('/admin', request.url);
  if (error) target.searchParams.set('github_error', error);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      target.searchParams.set(key, String(value));
    }
  }
  return redirectResponse(target.toString(), cookies);
}

function createGithubAuthorizeRequest(request, settings, mode) {
  const state = `${mode}.${crypto.randomUUID().replace(/-/g, '')}`;
  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', String(settings.github_client_id).trim());
  authorizeUrl.searchParams.set('redirect_uri', getCallbackUrl(request));
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('allow_signup', 'false');
  return {
    authorizeUrl: authorizeUrl.toString(),
    stateCookie: buildStateCookie(request, state)
  };
}

export function handleGithubOAuthStartApi(request, settings, mode = 'login') {
  const normalizedMode = mode === 'bind' ? 'bind' : 'login';
  const ready = normalizedMode === 'bind'
    ? hasGithubOAuthCredentials(settings)
    : isGithubOAuthReady(settings);
  if (!ready) {
    return new Response(JSON.stringify({ error: 'githubOAuthNotConfigured', code: 400 }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  const { authorizeUrl, stateCookie } = createGithubAuthorizeRequest(request, settings, normalizedMode);
  return new Response(JSON.stringify({ authorize_url: authorizeUrl }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': stateCookie
    }
  });
}

export async function handleGithubOAuthCallback(request, env, settings) {
  const clearStateCookie = buildClearStateCookie(request);
  const url = new URL(request.url);
  const state = url.searchParams.get('state') || '';
  const expectedState = getCookieValue(request, GITHUB_OAUTH_STATE_COOKIE);
  if (!stateMatches(state, expectedState)) {
    return redirectToAdmin(request, 'invalid_state', [clearStateCookie]);
  }

  const mode = state.startsWith('bind.') ? 'bind' : 'login';
  if (mode === 'bind' && !hasGithubOAuthCredentials(settings)) {
    return redirectToAdmin(request, 'not_configured', [clearStateCookie]);
  }
  if (mode === 'login' && !isGithubOAuthConfigured(settings)) {
    return redirectToAdmin(request, 'not_configured', [clearStateCookie]);
  }
  if (mode === 'login' && !normalizeGithubUserId(settings.github_user_id)) {
    return redirectToAdmin(request, 'not_bound', [clearStateCookie]);
  }
  if (mode === 'bind' && !await checkAuth(request, env, settings)) {
    return redirectToAdmin(request, 'binding_auth_required', [clearStateCookie]);
  }

  if (url.searchParams.get('error')) {
    return redirectToAdmin(request, 'cancelled', [clearStateCookie]);
  }

  const code = url.searchParams.get('code') || '';
  if (!code) {
    return redirectToAdmin(request, 'missing_code', [clearStateCookie]);
  }

  try {
    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'CF-Server-Monitor'
      },
      body: new URLSearchParams({
        client_id: String(settings.github_client_id).trim(),
        client_secret: String(settings.github_client_secret).trim(),
        code,
        redirect_uri: getCallbackUrl(request)
      }).toString()
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenData.access_token) {
      return redirectToAdmin(request, 'token_exchange_failed', [clearStateCookie]);
    }

    const userResponse = await fetch(GITHUB_USER_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${tokenData.access_token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'CF-Server-Monitor'
      }
    });
    const user = await userResponse.json().catch(() => ({}));
    if (!userResponse.ok || !Number.isSafeInteger(user.id) || user.id <= 0) {
      return redirectToAdmin(request, 'user_lookup_failed', [clearStateCookie]);
    }

    const githubUserId = String(user.id);
    if (mode === 'bind') {
      await env.DB.prepare(`
        INSERT INTO settings (key, value)
        VALUES ('site_options', json_object('github_user_id', ?))
        ON CONFLICT(key) DO UPDATE SET value = CASE
          WHEN json_valid(value) AND json_type(value) = 'object'
          THEN json_set(value, '$.github_user_id', ?)
          ELSE json_object('github_user_id', ?)
        END
      `).bind(
        githubUserId,
        githubUserId,
        githubUserId
      ).run();
      clearSiteSettingsCache();
      return redirectToAdmin(request, '', [clearStateCookie], { github_bound: '1' });
    }

    if (githubUserId !== normalizeGithubUserId(settings.github_user_id)) {
      return redirectToAdmin(request, 'not_allowed', [clearStateCookie]);
    }

    const token = await generateToken(env, settings);
    return redirectToAdmin(request, '', [
      buildAuthCookie(request, token),
      clearStateCookie
    ]);
  } catch (error) {
    console.error('GitHub OAuth callback failed:', error?.message || error);
    return redirectToAdmin(request, 'request_failed', [clearStateCookie]);
  }
}