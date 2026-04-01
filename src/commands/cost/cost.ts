import { formatTotalCost } from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { isOpenAIModel } from '../../services/openai/client.js'

export const call: LocalCommandCall = async () => {
  if (isOpenAIModel(getMainLoopModel())) {
    return {
      type: 'text',
      value:
        'Current session is using ChatGPT / OpenAI pricing.\n\n' +
        formatTotalCost(),
    }
  }

  if (isClaudeAISubscriber()) {
    let value: string

    if (currentLimits.isUsingOverage) {
      value =
        'You are currently using your overages to power your Claude Code usage. We will automatically switch you back to your subscription rate limits when they reset'
    } else {
      value =
        'You are currently using your subscription to power your Claude Code usage'
    }

    if (process.env.USER_TYPE === 'ant') {
      value += `\n\n[ANT-ONLY] Showing cost anyway:\n ${formatTotalCost()}`
    }
    return { type: 'text', value }
  }
  return { type: 'text', value: formatTotalCost() }
}
