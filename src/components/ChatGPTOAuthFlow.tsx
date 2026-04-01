import React, { useEffect, useMemo, useState } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { Box, Link, Text } from '../ink.js'
import {
  fetchAvailableModels,
  getDefaultOpenAIModels,
} from '../services/openai/client.js'
import { OpenAIOAuthService } from '../services/openai/index.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { sendNotification } from '../services/notifier.js'
import { logError } from '../utils/log.js'
import {
  saveAvailableOpenAIModels,
  saveOpenAIChatGPTTokens,
} from '../utils/openaiAuth.js'
import { Select } from './CustomSelect/select.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Spinner } from './Spinner.js'

type Props = {
  onDone(model: string): void
  onCancel(): void
}

type State =
  | { kind: 'starting' }
  | { kind: 'waiting'; url: string }
  | { kind: 'select-model'; email?: string | null; models: string[] }
  | { kind: 'error'; message: string }

export function ChatGPTOAuthFlow({
  onDone,
  onCancel,
}: Props): React.ReactNode {
  const [state, setState] = useState<State>({ kind: 'starting' })
  const [oauthService] = useState(() => new OpenAIOAuthService())
  const terminal = useTerminalNotification()

  useEffect(() => {
    let cancelled = false

    async function run(): Promise<void> {
      try {
        logEvent('openai_chatgpt_login_start', {})
        const tokens = await oauthService.startOAuthFlow(async url => {
          if (!cancelled) {
            setState({ kind: 'waiting', url })
          }
        })

        const saveResult = saveOpenAIChatGPTTokens(tokens)
        if (!saveResult.success) {
          throw new Error(saveResult.warning ?? 'Failed to save ChatGPT login')
        }

        let models = getDefaultOpenAIModels().map(model => model.id)
        try {
          const remoteModels = await fetchAvailableModels({
            accessToken: tokens.accessToken,
            accountId: tokens.accountId,
          })
          if (remoteModels.length > 0) {
            models = remoteModels.map(model => model.id)
          }
        } catch (error) {
          logError(error)
        }

        if (!cancelled) {
          void saveAvailableOpenAIModels(models)
          setState({
            kind: 'select-model',
            email: tokens.email,
            models,
          })
          void sendNotification(
            {
              message: 'ChatGPT login successful',
              notificationType: 'auth_success',
            },
            terminal,
          )
        }
      } catch (error) {
        logError(error)
        if (!cancelled) {
          setState({
            kind: 'error',
            message:
              error instanceof Error ? error.message : 'ChatGPT login failed',
          })
        }
      }
    }

    void run()

    return () => {
      cancelled = true
      oauthService.cleanup()
    }
  }, [oauthService, terminal])

  const modelOptions = useMemo(
    () =>
      state.kind === 'select-model'
        ? state.models.map(model => ({
            value: model,
            label: model,
            description: 'Available after ChatGPT login',
          }))
        : [],
    [state],
  )

  if (state.kind === 'starting') {
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Spinner />
          <Text>Starting ChatGPT login...</Text>
        </Box>
      </Box>
    )
  }

  if (state.kind === 'waiting') {
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Spinner />
          <Text>Waiting for ChatGPT login in your browser...</Text>
        </Box>
        <Text dimColor>If the browser did not open, visit:</Text>
        <Link url={state.url}>{state.url}</Link>
      </Box>
    )
  }

  if (state.kind === 'error') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">{state.message}</Text>
        <Text dimColor>
          Re-run <Text bold>/login-chatgpt</Text> to try again.
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      {state.email ? (
        <Text dimColor>
          Logged in as <Text>{state.email}</Text>
        </Text>
      ) : null}
      <Text>Select a GPT model for this session:</Text>
      <Select
        options={modelOptions}
        visibleOptionCount={Math.min(8, modelOptions.length)}
        onChange={value => {
          logEvent('openai_chatgpt_model_selected', {
            model:
              value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          onDone(value)
        }}
        onCancel={onCancel}
      />
      <KeyboardShortcutHint
        action="confirm:yes"
        context="Select"
        fallback="Enter"
        description="select model"
      />
    </Box>
  )
}
