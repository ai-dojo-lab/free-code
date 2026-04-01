import * as React from 'react'
import { Text } from '../../ink.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { clearAuthRelatedCaches } from '../logout/logout.js'
import { removeOpenAIChatGPTAuth } from '../../utils/openaiAuth.js'
import { isOpenAIModel } from '../../services/openai/client.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  const result = removeOpenAIChatGPTAuth()
  await clearAuthRelatedCaches()

  let didResetModel = false
  context.onChangeAPIKey()
  context.setMessages(stripSignatureBlocks)
  context.setAppState(prev => {
    if (!isOpenAIModel(prev.mainLoopModel)) {
      return {
        ...prev,
        authVersion: prev.authVersion + 1,
      }
    }

    didResetModel = true
    return {
      ...prev,
      mainLoopModel: null,
      mainLoopModelForSession: null,
      authVersion: prev.authVersion + 1,
    }
  })

  const baseMessage = result.success
    ? 'Successfully logged out from your ChatGPT account.'
    : (result.warning ?? 'Failed to fully remove ChatGPT login.')

  const suffix = didResetModel ? ' Reset model to default.' : ''
  onDone(baseMessage + suffix)

  return (
    <Text>
      {baseMessage}
      {suffix}
    </Text>
  )
}
