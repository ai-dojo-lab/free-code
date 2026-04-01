import * as React from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import { ChatGPTOAuthFlow } from '../../components/ChatGPTOAuthFlow.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Text } from '../../ink.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import { resetUserCache } from '../../utils/user.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return (
    <LoginChatGPT
      onDone={selectedModel => {
        context.onChangeAPIKey()
        context.setMessages(stripSignatureBlocks)
        resetCostState()
        resetUserCache()
        context.setAppState(prev => ({
          ...prev,
          mainLoopModel: selectedModel,
          mainLoopModelForSession: null,
          authVersion: prev.authVersion + 1,
        }))
        onDone(`ChatGPT login successful · model set to ${selectedModel}`)
      }}
      onCancel={() => onDone('ChatGPT login saved. No model selected.')}
    />
  )
}

function LoginChatGPT(props: {
  onDone: (selectedModel: string) => void
  onCancel: () => void
}): React.ReactNode {
  return (
    <Dialog
      title="Login with ChatGPT"
      onCancel={props.onCancel}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      <ChatGPTOAuthFlow onDone={props.onDone} onCancel={props.onCancel} />
    </Dialog>
  )
}
