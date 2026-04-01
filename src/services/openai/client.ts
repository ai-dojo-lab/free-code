import { logEvent } from 'src/services/analytics/index.js'
import { getUserAgent } from '../../utils/http.js'
import type {
  OpenAIChatGPTTokenExchangeResponse,
  OpenAIChatGPTTokens,
  OpenAIModelInfo,
} from './types.js'

const OPENAI_AUTH_ISSUER = 'https://auth.openai.com'
export const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_OAUTH_CALLBACK_PORT = 1455
export const OPENAI_CODEX_CLIENT_VERSION =
  process.env.OPENAI_CODEX_CLIENT_VERSION ?? '0.111.0'
export const OPENAI_OAUTH_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'

function formBody(values: Record<string, string>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    params.set(key, value)
  }
  return params.toString()
}

function getDefaultHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': getUserAgent(),
    ...extra,
  }
}

export function isOpenAIModel(model: string | null | undefined): boolean {
  if (!model) return false
  const normalized = model.toLowerCase()
  return normalized.startsWith('gpt-') || normalized.includes('codex')
}

export function parseJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const base64 = parts[1]!
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1]!.length / 4) * 4, '=')
    const raw = Buffer.from(base64, 'base64').toString('utf8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

export function deriveAccountId(
  idToken: string | undefined,
): string | undefined {
  const claims = idToken ? parseJwtClaims(idToken) : null
  if (!claims) {
    return undefined
  }
  const authClaim = claims['https://api.openai.com/auth']
  if (
    typeof authClaim === 'object' &&
    authClaim !== null &&
    typeof (authClaim as Record<string, unknown>).chatgpt_account_id === 'string'
  ) {
    return (authClaim as Record<string, string>).chatgpt_account_id
  }
  return undefined
}

export function getCodexAuthHeaders(tokens: {
  accessToken: string
  accountId: string
}): Record<string, string> {
  return {
    Authorization: `Bearer ${tokens.accessToken}`,
    'chatgpt-account-id': tokens.accountId,
    'OpenAI-Beta': 'responses=experimental',
    'User-Agent': getUserAgent(),
  }
}

export function buildChatGPTAuthUrl({
  codeChallenge,
  state,
  port,
}: {
  codeChallenge: string
  state: string
  port: number
}): string {
  const authUrl = new URL(`${OPENAI_AUTH_ISSUER}/oauth/authorize`)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', OPENAI_CODEX_CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', `http://localhost:${port}/auth/callback`)
  authUrl.searchParams.set('scope', OPENAI_OAUTH_SCOPE)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('id_token_add_organizations', 'true')
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true')
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('originator', 'codex_cli_rs')
  return authUrl.toString()
}

export async function exchangeCodeForTokens(params: {
  authorizationCode: string
  codeVerifier: string
  port: number
}): Promise<OpenAIChatGPTTokenExchangeResponse> {
  const response = await fetch(`${OPENAI_AUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: getDefaultHeaders(),
    body: formBody({
      grant_type: 'authorization_code',
      code: params.authorizationCode,
      redirect_uri: `http://localhost:${params.port}/auth/callback`,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: params.codeVerifier,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`ChatGPT token exchange failed (${response.status}): ${body}`)
  }

  logEvent('openai_chatgpt_token_exchange_success', {})
  return (await response.json()) as OpenAIChatGPTTokenExchangeResponse
}

export async function refreshChatGPTTokens(
  refreshToken: string,
): Promise<OpenAIChatGPTTokenExchangeResponse> {
  const response = await fetch(`${OPENAI_AUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': getUserAgent(),
    },
    body: JSON.stringify({
      client_id: OPENAI_CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: OPENAI_OAUTH_SCOPE,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`ChatGPT token refresh failed (${response.status}): ${body}`)
  }

  logEvent('openai_chatgpt_token_refresh_success', {})
  return (await response.json()) as OpenAIChatGPTTokenExchangeResponse
}

export async function fetchAvailableModels(
  tokens: {
    accessToken: string
    accountId: string
  },
): Promise<OpenAIModelInfo[]> {
  const response = await fetch(
    `${OPENAI_CODEX_BASE_URL}/models?client_version=${encodeURIComponent(OPENAI_CODEX_CLIENT_VERSION)}`,
    {
      headers: getCodexAuthHeaders(tokens),
    },
  )

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Codex model list failed (${response.status}): ${body}`)
  }

  const json = (await response.json()) as {
    data?: OpenAIModelInfo[]
    models?: Array<{ slug?: string }>
  }
  const explicitModels = json.data?.map(model => model.id) ?? []
  const slugs = json.models?.flatMap(model =>
    typeof model.slug === 'string' ? [model.slug] : [],
  ) ?? []
  const ids = [...new Set([...explicitModels, ...slugs])].filter(isOpenAIModel)
  return ids
    .sort((a, b) => a.localeCompare(b))
    .map(id => ({ id }))
}

export async function requestCodexResponse(
  body: Record<string, unknown>,
  tokens: {
    accessToken: string
    accountId: string
  },
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${OPENAI_CODEX_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      ...getCodexAuthHeaders(tokens),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
}

export function formatTokenBundle(
  tokenResponse: OpenAIChatGPTTokenExchangeResponse,
): OpenAIChatGPTTokens {
  const claims = parseJwtClaims(tokenResponse.id_token)
  const accountId = deriveAccountId(tokenResponse.id_token)
  if (!accountId) {
    throw new Error(
      'ChatGPT account id not found in ID token. Please complete ChatGPT/Codex account setup first.',
    )
  }
  return {
    idToken: tokenResponse.id_token,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? null,
    expiresAt: tokenResponse.expires_in
      ? Date.now() + tokenResponse.expires_in * 1000
      : null,
    accountId,
    email: typeof claims?.email === 'string' ? claims.email : null,
  }
}

export function getDefaultOpenAIModels(): OpenAIModelInfo[] {
  return ['gpt-5', 'gpt-5-mini', 'gpt-4.1'].map(id => ({ id }))
}
