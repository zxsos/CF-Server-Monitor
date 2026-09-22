import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleGithubOAuthCallback,
  handleGithubOAuthStartApi,
  isGithubOAuthConfigured,
  isGithubOAuthReady,
} from '../src/handlers/githubAuth.js';
import { checkAuth, generateToken } from '../src/middleware/auth.js';
import { clearSiteSettingsCache, loadSiteSettings, SITE_FIELDS } from '../src/utils/settings.js';

const oauthSettings = {
  github_oauth_enabled: 'true',
  github_client_id: 'client-id',
  github_client_secret: 'client-secret',
  github_user_id: '12345',
  jwt_secret: '0123456789abcdef0123456789abcdef'
};

test('GitHub OAuth is exposed for login only after an account is bound', () => {
  assert.equal(isGithubOAuthConfigured(oauthSettings), true);
  assert.equal(isGithubOAuthReady(oauthSettings), true);
  assert.equal(isGithubOAuthReady({ ...oauthSettings, github_user_id: '' }), false);
  assert.equal(isGithubOAuthReady({ ...oauthSettings, github_user_id: 'octocat' }), false);
});

test('GitHub OAuth start builds the registered callback and a short-lived state cookie', async () => {
  const response = handleGithubOAuthStartApi(
    new Request('https://monitor.example/auth/github'),
    oauthSettings
  );

  assert.equal(response.status, 200);
  const location = new URL((await response.json()).authorize_url);
  assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(location.searchParams.get('client_id'), 'client-id');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://monitor.example/auth/github/callback');
  assert.ok(location.searchParams.get('state'));
  assert.match(response.headers.get('Set-Cookie') || '', /cfsm_github_oauth_state=/);
  assert.match(response.headers.get('Set-Cookie') || '', /HttpOnly/);
});

test('GitHub OAuth callback issues the existing auth cookie without a database lookup', async () => {
  const startResponse = handleGithubOAuthStartApi(
    new Request('https://monitor.example/auth/github'),
    oauthSettings
  );
  const authorizeUrl = new URL((await startResponse.json()).authorize_url);
  const state = authorizeUrl.searchParams.get('state');
  const stateCookie = (startResponse.headers.get('Set-Cookie') || '').match(/cfsm_github_oauth_state=[^;]+/)?.[0];
  assert.ok(stateCookie);

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/login/oauth/access_token')) {
      return Response.json({ access_token: 'github-access-token' });
    }
    if (String(url) === 'https://api.github.com/user') {
      return Response.json({ id: 12345, login: 'octocat' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const callbackRequest = new Request(
      `https://monitor.example/auth/github/callback?code=code-1&state=${state}`,
      { headers: { Cookie: stateCookie } }
    );
    const response = await handleGithubOAuthCallback(callbackRequest, {}, oauthSettings);

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), 'https://monitor.example/admin');
    assert.equal(calls.length, 2);
    assert.match(calls[0].options.body, /client_secret=client-secret/);

    const setCookie = response.headers.get('Set-Cookie') || '';
    const token = setCookie.match(/cfsm_auth=([^;,]+)/)?.[1];
    assert.ok(token);
    const authenticated = await checkAuth(new Request('https://monitor.example/admin/api', {
      headers: { Cookie: `cfsm_auth=${token}` }
    }), {}, oauthSettings);
    assert.equal(authenticated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('binding stores the authenticated GitHub account with one D1 write and no D1 read', async () => {
  const unboundSettings = { ...oauthSettings, github_user_id: '' };
  const startResponse = handleGithubOAuthStartApi(
    new Request('https://monitor.example/auth/github'),
    unboundSettings,
    'bind'
  );
  const authorizeUrl = new URL((await startResponse.json()).authorize_url);
  const state = authorizeUrl.searchParams.get('state');
  const stateCookie = (startResponse.headers.get('Set-Cookie') || '').match(/cfsm_github_oauth_state=[^;]+/)?.[0];
  const authToken = await generateToken({}, unboundSettings);
  const dbCalls = [];
  const db = {
    prepare(sql) {
      dbCalls.push({ sql, params: [] });
      const call = dbCalls.at(-1);
      return {
        bind(...params) {
          call.params = params;
          return this;
        },
        async run() {
          return { success: true };
        }
      };
    }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/login/oauth/access_token')) {
      return Response.json({ access_token: 'github-binding-token' });
    }
    if (String(url) === 'https://api.github.com/user') {
      return Response.json({ id: 67890, login: 'bound-user' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const response = await handleGithubOAuthCallback(new Request(
      `https://monitor.example/auth/github/callback?code=bind-code&state=${state}`,
      { headers: { Cookie: `${stateCookie}; cfsm_auth=${authToken}` } }
    ), { DB: db }, unboundSettings);

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), 'https://monitor.example/admin?github_bound=1');
    assert.equal(dbCalls.length, 1);
    assert.match(dbCalls[0].sql, /json_set/);
    assert.deepEqual(dbCalls[0].params, ['67890', '67890', '67890']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('binding callback rejects an expired admin session before calling GitHub or D1', async () => {
  const unboundSettings = { ...oauthSettings, github_user_id: '' };
  const startResponse = handleGithubOAuthStartApi(
    new Request('https://monitor.example/auth/github'),
    unboundSettings,
    'bind'
  );
  const authorizeUrl = new URL((await startResponse.json()).authorize_url);
  const state = authorizeUrl.searchParams.get('state');
  const stateCookie = (startResponse.headers.get('Set-Cookie') || '').match(/cfsm_github_oauth_state=[^;]+/)?.[0];

  const response = await handleGithubOAuthCallback(new Request(
    `https://monitor.example/auth/github/callback?code=bind-code&state=${state}`,
    { headers: { Cookie: stateCookie } }
  ), {
    DB: {
      prepare() {
        throw new Error('D1 must not be called');
      }
    }
  }, unboundSettings);

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get('Location'),
    'https://monitor.example/admin?github_error=binding_auth_required'
  );
});

test('new GitHub fields do not trigger a legacy settings query', async () => {
  clearSiteSettingsCache();
  const githubFields = new Set([
    'github_oauth_enabled',
    'github_client_id',
    'github_client_secret',
    'github_user_id'
  ]);
  const siteOptions = Object.fromEntries(
    SITE_FIELDS.filter(field => !githubFields.has(field)).map(field => [field, ''])
  );
  siteOptions.jwt_secret = oauthSettings.jwt_secret;
  siteOptions.resource_alert_rules = [];
  siteOptions.wss_report_hours = [];

  const calls = [];
  const db = {
    prepare(sql) {
      calls.push(sql);
      return {
        async first() {
          return { value: JSON.stringify(siteOptions) };
        },
        async all() {
          throw new Error('legacy settings query should not run');
        }
      };
    }
  };

  const settings = await loadSiteSettings(db, { forceRefresh: true });
  assert.equal(settings.github_oauth_enabled, 'false');
  assert.equal(calls.filter(sql => /SELECT \* FROM settings/.test(sql)).length, 0);
  clearSiteSettingsCache();
});