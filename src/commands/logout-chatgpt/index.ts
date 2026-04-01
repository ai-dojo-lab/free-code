import type { Command } from '../../commands.js'
import { hasOpenAIChatGPTAuth } from '../../utils/openaiAuth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'logout-chatgpt',
    description: hasOpenAIChatGPTAuth()
      ? 'Sign out from your ChatGPT account'
      : 'Clear ChatGPT login for GPT models',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGOUT_COMMAND),
    load: () => import('./logout-chatgpt.js'),
  }) satisfies Command
