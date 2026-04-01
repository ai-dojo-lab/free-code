import type { Command } from '../../commands.js'
import { hasOpenAIChatGPTAuth } from '../../utils/openaiAuth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login-chatgpt',
    description: hasOpenAIChatGPTAuth()
      ? 'Switch ChatGPT account and GPT model'
      : 'Sign in with your ChatGPT account',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    load: () => import('./login-chatgpt.js'),
  }) satisfies Command
