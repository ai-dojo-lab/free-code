import memoize from 'lodash-es/memoize.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  refreshChatGPTTokens,
  formatTokenBundle,
} from '../services/openai/client.js'
import type { OpenAIChatGPTTokens } from '../services/openai/types.js'
import { errorMessage } from './errors.js'
import { logError } from './log.js'
import { getSecureStorage } from './secureStorage/index.js'

const OPENAI_STORAGE_KEY = 'openaiChatgptOauth'
const OPENAI_MODELS_STORAGE_KEY = 'openaiChatgptModels'
const REFRESH_BUFFER_MS = 5 * 60 * 1000

export function saveOpenAIChatGPTTokens(tokens: OpenAIChatGPTTokens): {
  success: boolean
  warning?: string
} {
  const secureStorage = getSecureStorage()
  try {
    const storageData = secureStorage.read() || {}
    storageData[OPENAI_STORAGE_KEY] = tokens
    const result = secureStorage.update(storageData)
    clearOpenAIAuthCache()
    if (result.success) {
      logEvent('openai_chatgpt_tokens_saved', {})
    }
    return result
  } catch (error) {
    logError(error)
    return {
      success: false,
      warning: `Failed to save ChatGPT credentials: ${errorMessage(error)}`,
    }
  }
}

export const getOpenAIChatGPTTokens = memoize(
  (): OpenAIChatGPTTokens | null => {
    try {
      const secureStorage = getSecureStorage()
      const storageData = secureStorage.read() || {}
      return (storageData[OPENAI_STORAGE_KEY] as OpenAIChatGPTTokens) ?? null
    } catch (error) {
      logError(error)
      return null
    }
  },
)

export function hasOpenAIChatGPTAuth(): boolean {
  return getOpenAIChatGPTTokens() !== null
}

export function clearOpenAIAuthCache(): void {
  getOpenAIChatGPTTokens.cache?.clear?.()
  getAvailableOpenAIModels.cache?.clear?.()
}

export function saveAvailableOpenAIModels(models: string[]): {
  success: boolean
  warning?: string
} {
  const secureStorage = getSecureStorage()
  try {
    const storageData = secureStorage.read() || {}
    storageData[OPENAI_MODELS_STORAGE_KEY] = models
    const result = secureStorage.update(storageData)
    getAvailableOpenAIModels.cache?.clear?.()
    return result
  } catch (error) {
    logError(error)
    return {
      success: false,
      warning: `Failed to save ChatGPT model list: ${errorMessage(error)}`,
    }
  }
}

export const getAvailableOpenAIModels = memoize((): string[] => {
  try {
    const secureStorage = getSecureStorage()
    const storageData = secureStorage.read() || {}
    const models = storageData[OPENAI_MODELS_STORAGE_KEY]
    return Array.isArray(models)
      ? models.filter((model): model is string => typeof model === 'string')
      : []
  } catch (error) {
    logError(error)
    return []
  }
})

export async function checkAndRefreshOpenAIAuthIfNeeded(): Promise<OpenAIChatGPTTokens | null> {
  const tokens = getOpenAIChatGPTTokens()
  if (!tokens) return null

  if (
    tokens.expiresAt !== null &&
    tokens.refreshToken &&
    tokens.expiresAt - Date.now() <= REFRESH_BUFFER_MS
  ) {
    try {
      const refreshed = await refreshChatGPTTokens(tokens.refreshToken)
      const merged = formatTokenBundle(refreshed)
      const nextTokens = {
        ...tokens,
        ...merged,
        refreshToken: merged.refreshToken ?? tokens.refreshToken,
      }
      const update = saveOpenAIChatGPTTokens(nextTokens)
      if (!update.success) {
        logEvent('openai_chatgpt_tokens_refresh_save_failed', {
          warning:
            (update.warning ??
              'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }
      return nextTokens
    } catch (error) {
      logError(error)
      throw error
    }
  }

  return tokens
}

export async function getOpenAIAuth(): Promise<{
  accessToken: string
  accountId: string
} | null> {
  const tokens = await checkAndRefreshOpenAIAuthIfNeeded()
  if (!tokens) return null
  return {
    accessToken: tokens.accessToken,
    accountId: tokens.accountId,
  }
}

export function getOpenAIAccountInfo(): {
  email?: string
  accountId?: string
} | null {
  const tokens = getOpenAIChatGPTTokens()
  if (!tokens) return null
  return {
    ...(tokens.email ? { email: tokens.email } : {}),
    ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
  }
}

export function removeOpenAIChatGPTAuth(): {
  success: boolean
  warning?: string
} {
  const secureStorage = getSecureStorage()
  try {
    const storageData = secureStorage.read() || {}
    delete storageData[OPENAI_STORAGE_KEY]
    delete storageData[OPENAI_MODELS_STORAGE_KEY]
    const result = secureStorage.update(storageData)
    clearOpenAIAuthCache()
    return result
  } catch (error) {
    logError(error)
    return {
      success: false,
      warning: `Failed to remove ChatGPT credentials: ${errorMessage(error)}`,
    }
  }
}
