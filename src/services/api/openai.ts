import { randomUUID } from 'crypto'
import type { QueryChainTracking, Tools } from '../../Tool.js'
import { addToTotalSessionCost } from '../../cost-tracker.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from 'src/types/message.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { toolToAPISchema } from '../../utils/api.js'
import { createAssistantAPIErrorMessage, createAssistantMessage } from '../../utils/messages.js'
import { logError } from '../../utils/log.js'
import { calculateUSDCost } from '../../utils/modelCost.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { requestCodexResponse } from '../openai/client.js'
import { getOpenAIAuth } from '../../utils/openaiAuth.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import {
  logAPIQuery,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from './logging.js'

type OpenAITool = {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

type OpenAIChatMessage =
  | {
      role: 'system' | 'user' | 'tool'
      content: string
      tool_call_id?: string
    }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }

type OpenAIAssistantChatMessage = Extract<
  OpenAIChatMessage,
  { role: 'assistant' }
>

type CodexInputItem =
  | { role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

function blockToText(block: Record<string, unknown>): string {
  switch (block.type) {
    case 'text':
      return String(block.text ?? '')
    case 'thinking':
      return String(block.thinking ?? '')
    case 'redacted_thinking':
      return '[Redacted thinking omitted]'
    case 'document':
      return '[Document attachment omitted]'
    case 'image':
      return '[Image attachment omitted]'
    default:
      return ''
  }
}

function toolResultContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  return content
    .map(item =>
      typeof item === 'object' && item !== null
        ? blockToText(item as Record<string, unknown>)
        : String(item),
    )
    .filter(Boolean)
    .join('\n\n')
}

function userMessageToOpenAI(message: UserMessage): OpenAIChatMessage[] {
  if (typeof message.message.content === 'string') {
    return [{ role: 'user', content: message.message.content }]
  }

  const out: OpenAIChatMessage[] = []
  let buffer = ''
  for (const block of message.message.content) {
    if (block.type === 'tool_result') {
      if (buffer.trim()) {
        out.push({ role: 'user', content: buffer.trim() })
        buffer = ''
      }
      out.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: toolResultContentToText(block.content),
      })
      continue
    }

    const text = blockToText(block as Record<string, unknown>)
    if (text) {
      buffer = buffer ? `${buffer}\n\n${text}` : text
    }
  }

  if (buffer.trim()) {
    out.push({ role: 'user', content: buffer.trim() })
  }

  return out
}

function assistantMessageToOpenAI(message: AssistantMessage): OpenAIChatMessage[] {
  if (typeof message.message.content === 'string') {
    return [{ role: 'assistant', content: message.message.content }]
  }

  const textBlocks: string[] = []
  const toolCalls: NonNullable<OpenAIAssistantChatMessage['tool_calls']> = []
  for (const block of message.message.content) {
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments:
            typeof block.input === 'string'
              ? block.input
              : jsonStringify(block.input ?? {}),
        },
      })
      continue
    }

    const text = blockToText(block as Record<string, unknown>)
    if (text) {
      textBlocks.push(text)
    }
  }

  return [
    {
      role: 'assistant',
      content: textBlocks.length > 0 ? textBlocks.join('\n\n') : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ]
}

function messagesToOpenAI(messages: Message[], systemPrompt: SystemPrompt): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  const systemText = systemPrompt.join('\n\n').trim()
  if (systemText) {
    out.push({ role: 'system', content: systemText })
  }

  for (const message of messages) {
    if (message.type === 'user') {
      out.push(...userMessageToOpenAI(message))
    } else if (message.type === 'assistant') {
      out.push(...assistantMessageToOpenAI(message))
    }
  }

  return out
}

function messagesToCodexInput(
  messages: Message[],
  systemPrompt: SystemPrompt,
): { instructions: string; input: CodexInputItem[] } {
  const chatMessages = messagesToOpenAI(messages, systemPrompt)
  const instructions =
    typeof chatMessages[0]?.role === 'string' && chatMessages[0]?.role === 'system'
      ? chatMessages[0]?.content ?? ''
      : systemPrompt.join('\n\n').trim()
  const input: CodexInputItem[] = []

  for (const message of chatMessages) {
    if (message.role === 'system') {
      continue
    }
    if (message.role === 'user') {
      if (message.content.trim()) {
        input.push({ role: 'user', content: message.content })
      }
      continue
    }
    if (message.role === 'assistant') {
      if (typeof message.content === 'string' && message.content.trim()) {
        input.push({ role: 'assistant', content: message.content })
      }
      for (const toolCall of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })
      }
      continue
    }
    if (message.role === 'tool' && message.tool_call_id) {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content,
      })
    }
  }

  return { instructions, input }
}

async function buildOpenAITools(params: {
  tools: Tools
  getToolPermissionContext: () => Promise<import('../../Tool.js').ToolPermissionContext>
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  model: string
}): Promise<OpenAITool[]> {
  const out: OpenAITool[] = []
  for (const tool of params.tools) {
    const apiSchema = await toolToAPISchema(tool, {
      getToolPermissionContext: params.getToolPermissionContext,
      tools: params.tools,
      agents: params.agents,
      allowedAgentTypes: params.allowedAgentTypes,
      model: params.model,
    })

    if (
      !('name' in apiSchema) ||
      !('description' in apiSchema) ||
      !('input_schema' in apiSchema)
    ) {
      continue
    }

    out.push({
      type: 'function',
      name: apiSchema.name,
      description: apiSchema.description,
      parameters: apiSchema.input_schema as Record<string, unknown>,
      strict: 'strict' in apiSchema ? apiSchema.strict : undefined,
    })
  }
  return out
}

function responseOutputTextFromItem(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : []
  return content
    .map(part => {
      if (
        typeof part === 'object' &&
        part !== null &&
        'text' in part &&
        typeof (part as Record<string, unknown>).text === 'string'
      ) {
        return String((part as Record<string, unknown>).text)
      }
      if (
        typeof part === 'object' &&
        part !== null &&
        'refusal' in part &&
        typeof (part as Record<string, unknown>).refusal === 'string'
      ) {
        return String((part as Record<string, unknown>).refusal)
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function makeStreamEvent(
  event: Record<string, unknown>,
  ttftMs?: number,
): StreamEvent & { ttftMs?: number } {
  return ttftMs === undefined
    ? {
        type: 'stream_event',
        event: event as never,
      }
    : {
        type: 'stream_event',
        event: event as never,
        ttftMs,
      }
}

function toOpenAIUsage(rawUsage: Record<string, unknown> | undefined): NonNullableUsage {
  const inputTokens =
    typeof rawUsage?.input_tokens === 'number' ? rawUsage.input_tokens : 0
  const outputTokens =
    typeof rawUsage?.output_tokens === 'number' ? rawUsage.output_tokens : 0
  const inputTokenDetails =
    typeof rawUsage?.input_tokens_details === 'object' &&
    rawUsage.input_tokens_details !== null
      ? (rawUsage.input_tokens_details as Record<string, unknown>)
      : {}
  const cachedTokens =
    typeof inputTokenDetails.cached_tokens === 'number'
      ? inputTokenDetails.cached_tokens
      : 0
  const outputTokenDetails =
    typeof rawUsage?.output_tokens_details === 'object' &&
    rawUsage.output_tokens_details !== null
      ? (rawUsage.output_tokens_details as Record<string, unknown>)
      : {}
  const reasoningTokens =
    typeof outputTokenDetails.reasoning_tokens === 'number'
      ? outputTokenDetails.reasoning_tokens
      : 0

  return {
    ...EMPTY_USAGE,
    input_tokens: Math.max(inputTokens - cachedTokens, 0),
    cache_read_input_tokens: cachedTokens,
    output_tokens: outputTokens,
    output_token_details: {
      reasoning_tokens: reasoningTokens,
    } as NonNullableUsage['output_token_details'],
  }
}

function parseOpenAISSEPayload(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch (error) {
    logError(
      new Error(`Skipping malformed OpenAI SSE payload: ${line.slice(0, 200)}`, {
        cause: error,
      }),
    )
    return null
  }
}

function getCompletedResponseStopReason(
  completedResponse: Record<string, unknown> | undefined,
  completedOutput: Array<Record<string, unknown>>,
): string | null {
  if (completedOutput.some(item => item.type === 'function_call')) {
    return 'tool_calls'
  }

  const explicitFinishReason =
    typeof completedResponse?.finish_reason === 'string'
      ? completedResponse.finish_reason
      : typeof completedResponse?.stop_reason === 'string'
        ? completedResponse.stop_reason
        : null
  if (explicitFinishReason) {
    return explicitFinishReason
  }

  const incompleteDetails =
    typeof completedResponse?.incomplete_details === 'object' &&
    completedResponse.incomplete_details !== null
      ? (completedResponse.incomplete_details as Record<string, unknown>)
      : null
  const incompleteReason =
    typeof incompleteDetails?.reason === 'string'
      ? incompleteDetails.reason
      : null
  if (incompleteReason === 'max_output_tokens') {
    return 'max_tokens'
  }
  if (incompleteReason === 'content_filter') {
    return 'refusal'
  }
  if (incompleteReason) {
    return incompleteReason
  }

  const status =
    typeof completedResponse?.status === 'string' ? completedResponse.status : null
  if (status === 'incomplete') {
    return null
  }

  return 'stop'
}

function toAnthropicStopReason(stopReason: string | null): string | null {
  switch (stopReason) {
    case 'tool_calls':
      return 'tool_use'
    case 'stop':
    case 'completed':
      return 'end_turn'
    case 'max_tokens':
    case 'refusal':
    case 'pause_turn':
    case 'stop_sequence':
      return stopReason
    default:
      return null
  }
}

async function* parseOpenAISSE(
  response: Response,
): AsyncGenerator<Record<string, unknown>, void> {
  const reader = response.body?.getReader()
  if (!reader) {
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    buffer = buffer.replace(/\r\n/g, '\n')

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      const dataLines = rawEvent
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())

      for (const line of dataLines) {
        if (!line || line === '[DONE]') {
          continue
        }
        const parsed = parseOpenAISSEPayload(line)
        if (parsed) {
          yield parsed
        }
      }

      boundary = buffer.indexOf('\n\n')
    }
  }

  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const line = tail.slice(5).trim()
    if (line && line !== '[DONE]') {
      const parsed = parseOpenAISSEPayload(line)
      if (parsed) {
        yield parsed
      }
    }
  }
}

export async function* queryOpenAIModel({
  messages,
  systemPrompt,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: {
    model: string
    querySource: QuerySource
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
    getToolPermissionContext: () => Promise<import('../../Tool.js').ToolPermissionContext>
    queryTracking?: QueryChainTracking
    fastMode?: boolean
  }
}): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const auth = await getOpenAIAuth()
  if (!auth) {
    yield createAssistantAPIErrorMessage({
      content: 'Not logged in to ChatGPT. Run /login-chatgpt first.',
    })
    return
  }

  try {
    const requestStartedAt = Date.now()
    logAPIQuery({
      model: options.model,
      messagesLength: messages.length,
      temperature: 1,
      querySource: options.querySource,
      queryTracking: options.queryTracking,
      thinkingType: 'disabled',
      fastMode: options.fastMode,
    })
    const { instructions, input } = messagesToCodexInput(messages, systemPrompt)
    const response = await requestCodexResponse(
      {
        model: options.model,
        instructions,
        input,
        tools: await buildOpenAITools({
          tools,
          getToolPermissionContext: options.getToolPermissionContext,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model: options.model,
        }),
        tool_choice: 'auto',
        parallel_tool_calls: false,
        stream: true,
        store: false,
      },
      auth,
      signal,
    )

    if (!response.ok) {
      const body = await response.text()
      yield createAssistantAPIErrorMessage({
        content: `ChatGPT Codex API error (${response.status}): ${body}`,
      })
      return
    }

    const accumulatedText: string[] = []
    const toolCalls = new Map<
      number,
      { id: string; name: string; arguments: string; started: boolean }
    >()
    let responseId: string | undefined
    let emittedMessageStart = false
    let textBlockStarted = false
    let firstChunkAt: number | undefined
    let finishReason: string | null = null
    let usage: NonNullableUsage = { ...EMPTY_USAGE }
    let completedResponse: Record<string, unknown> | undefined
    const getMessageStartEvent = () => {
      const startedAt = firstChunkAt ?? Date.now()
      firstChunkAt = startedAt
      emittedMessageStart = true
      return makeStreamEvent(
        {
          type: 'message_start',
          message: {
            id: responseId ?? randomUUID(),
            type: 'message',
            role: 'assistant',
            model: options.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
          },
        },
        startedAt - requestStartedAt,
      )
    }

    for await (const event of parseOpenAISSE(response)) {
      const eventType =
        typeof event.type === 'string' ? event.type : undefined

      if (
        eventType === 'response.completed' &&
        typeof event.response === 'object' &&
        event.response !== null
      ) {
        completedResponse = event.response as Record<string, unknown>
        responseId =
          typeof completedResponse.id === 'string' ? completedResponse.id : responseId
        firstChunkAt ??= Date.now()
        if (
          typeof completedResponse.usage === 'object' &&
          completedResponse.usage !== null
        ) {
          usage = toOpenAIUsage(
            completedResponse.usage as Record<string, unknown>,
          )
        }
        continue
      }

      if (!emittedMessageStart) {
        firstChunkAt = Date.now()
        yield getMessageStartEvent()
      }

      if (eventType === 'response.output_item.added') {
        const rawIndex =
          typeof event.output_index === 'number' ? event.output_index : 0
        const toolIndex = textBlockStarted ? rawIndex + 1 : rawIndex
        const item =
          typeof event.item === 'object' && event.item !== null
            ? (event.item as Record<string, unknown>)
            : {}
        if (item.type === 'function_call') {
          const existing = {
            id:
              typeof item.call_id === 'string'
                ? item.call_id
                : typeof item.id === 'string'
                  ? item.id
                  : randomUUID(),
            name: typeof item.name === 'string' ? item.name : 'tool',
            arguments:
              typeof item.arguments === 'string' ? item.arguments : '',
            started: true,
          }
          toolCalls.set(toolIndex, existing)
          yield makeStreamEvent({
            type: 'content_block_start',
            index: toolIndex,
            content_block: {
              type: 'tool_use',
              id: existing.id,
              name: existing.name,
              input: '',
            },
          })
        }
        continue
      }

      if (eventType === 'response.output_text.delta') {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (delta.length === 0) continue
        if (!textBlockStarted) {
          textBlockStarted = true
          yield makeStreamEvent({
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'text',
              text: '',
            },
          })
        }
        accumulatedText.push(delta)
        yield makeStreamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: delta,
          },
        })
        continue
      }

      if (eventType === 'response.function_call_arguments.delta') {
        const rawIndex =
          typeof event.output_index === 'number' ? event.output_index : 0
        const toolIndex = textBlockStarted ? rawIndex + 1 : rawIndex
        const existing = toolCalls.get(toolIndex)
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (existing && delta.length > 0) {
          existing.arguments += delta
          yield makeStreamEvent({
            type: 'content_block_delta',
            index: toolIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: delta,
            },
          })
        }
        continue
      }
    }

    const completedOutput = Array.isArray(completedResponse?.output)
      ? (completedResponse?.output as Array<Record<string, unknown>>)
      : []

    if (!emittedMessageStart && completedResponse) {
      yield getMessageStartEvent()
    }

    if (!emittedMessageStart) {
      yield createAssistantAPIErrorMessage({
        content: 'OpenAI response stream ended before any content was received.',
      })
      return
    }

    finishReason = getCompletedResponseStopReason(completedResponse, completedOutput)
    const anthropicStopReason = toAnthropicStopReason(finishReason)

    yield makeStreamEvent({
      type: 'message_delta',
      delta: {
        stop_reason: anthropicStopReason,
        stop_sequence: null,
      },
      usage,
    })
    yield makeStreamEvent({ type: 'message_stop' })

    const content: Array<Record<string, unknown>> = []
    for (const item of completedOutput) {
      if (item.type === 'message') {
        const text = responseOutputTextFromItem(item)
        if (text) {
          content.push({ type: 'text', text })
        }
        continue
      }
      if (item.type === 'function_call') {
        const callId =
          typeof item.call_id === 'string'
            ? item.call_id
            : typeof item.id === 'string'
              ? item.id
              : randomUUID()
        let input: unknown = {}
        try {
          input =
            typeof item.arguments === 'string'
              ? JSON.parse(item.arguments)
              : item.arguments ?? {}
        } catch {
          input = item.arguments ?? {}
        }
        content.push({
          type: 'tool_use',
          id: callId,
          name: typeof item.name === 'string' ? item.name : 'tool',
          input,
        })
      }
    }
    if (content.length === 0 && accumulatedText.length > 0) {
      content.push({ type: 'text', text: accumulatedText.join('') })
    }

    const assistant = createAssistantMessage({
      content: content.length > 0 ? (content as never[]) : '',
      usage,
    })
    const finalAssistant: AssistantMessage = {
      ...assistant,
      requestId: responseId,
      message: {
        ...assistant.message,
        model: options.model,
        usage,
        stop_reason: (anthropicStopReason ?? assistant.message.stop_reason) as never,
      },
    }
    const costUSD = addToTotalSessionCost(
      calculateUSDCost(options.model, usage),
      usage,
      options.model,
    )
    void options.getToolPermissionContext().then(permissionContext => {
      logAPISuccessAndDuration({
        model: options.model,
        preNormalizedModel: options.model,
        start: requestStartedAt,
        startIncludingRetries: requestStartedAt,
        ttftMs:
          firstChunkAt !== undefined ? firstChunkAt - requestStartedAt : null,
        usage,
        attempt: 1,
        messageCount: messages.length,
        messageTokens: 0,
        requestId: responseId ?? null,
        stopReason: anthropicStopReason as never,
        didFallBackToNonStreaming: false,
        querySource: options.querySource,
        costUSD,
        queryTracking: options.queryTracking,
        permissionMode: permissionContext.mode,
        newMessages: [finalAssistant],
        fastMode: options.fastMode,
      })
    })
    yield finalAssistant
  } catch (error) {
    logError(error)
    yield createAssistantAPIErrorMessage({
      content:
        error instanceof Error ? error.message : 'OpenAI request failed',
    })
  }
}
