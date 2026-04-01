import { openBrowser } from '../../utils/browser.js'
import { AuthCodeListener } from '../oauth/auth-code-listener.js'
import {
  buildChatGPTAuthUrl,
  exchangeCodeForTokens,
  formatTokenBundle,
  OPENAI_OAUTH_CALLBACK_PORT,
} from './client.js'
import * as crypto from '../oauth/crypto.js'
import type { OpenAIChatGPTTokens } from './types.js'

export class OpenAIOAuthService {
  private codeVerifier: string
  private authCodeListener: AuthCodeListener | null = null
  private port: number | null = null

  constructor() {
    this.codeVerifier = crypto.generateCodeVerifier()
  }

  async startOAuthFlow(
    authURLHandler: (url: string) => Promise<void>,
  ): Promise<OpenAIChatGPTTokens> {
    this.authCodeListener = new AuthCodeListener('/auth/callback')
    this.port = await this.authCodeListener.start(OPENAI_OAUTH_CALLBACK_PORT)

    const codeChallenge = crypto.generateCodeChallenge(this.codeVerifier)
    const state = crypto.generateState()
    const authUrl = buildChatGPTAuthUrl({
      codeChallenge,
      state,
      port: this.port,
    })

    const authorizationCode = await this.authCodeListener.waitForAuthorization(
      state,
      async () => {
        await authURLHandler(authUrl)
        await openBrowser(authUrl)
      },
    )

    try {
      const tokens = await exchangeCodeForTokens({
        authorizationCode,
        codeVerifier: this.codeVerifier,
        port: this.port!,
      })
      this.authCodeListener.handleSuccessRedirect([], res => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('ChatGPT login successful. You can close this window.')
      })
      return formatTokenBundle(tokens)
    } catch (error) {
      this.authCodeListener.handleErrorRedirect()
      throw error
    } finally {
      this.authCodeListener.close()
    }
  }

  cleanup(): void {
    this.authCodeListener?.close()
  }
}
