export type OpenAIChatGPTTokens = {
  idToken: string
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  accountId: string
  email?: string | null
}

export type OpenAIChatGPTTokenExchangeResponse = {
  id_token: string
  access_token: string
  refresh_token?: string
  expires_in?: number
}

export type OpenAIModelInfo = {
  id: string
  owned_by?: string
}
