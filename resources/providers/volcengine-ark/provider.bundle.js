const DEFAULT_VLM_MODEL = 'doubao-seed-2-0-lite-260215'
const DEFAULT_VLM_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

const DEFAULT_REPLY_MODEL = 'deepseek-chat'
const DEFAULT_REPLY_BASE_URL = 'https://api.deepseek.com/v1'

const DEFAULT_PROMPT = `你是一个微信自动回复助手。你会收到一张微信/企业微信的聊天窗口截图。

## 你的任务
分析截图中的聊天内容，生成合适的回复。

## 规则
1. 只输出回复文字，不要解释、不要添加多余内容
2. 防自我循环：仔细观察截图。聊天窗口中，右侧的气泡是"我"发送的。如果最后一条消息是右侧气泡，必须输出 [SKIP]
3. 如果最新消息是系统消息、群公告、红包、转账等非对话消息，输出 [SKIP]
4. 如果无法判断是否需要回复，输出 [SKIP]
5. 回复要自然、口语化，像真人对话`

const TRANSCRIBE_PROMPT = `请逐条列出这张微信聊天截图中的所有消息。
对每条消息，标注发送者是"我"（右侧气泡）还是"对方"（左侧气泡）。
保留原始文字内容，不要修改或概括。
如果最后一条消息是"我"发送的，在末尾标注 [SELF_LAST]。
如果聊天内容是系统消息、群公告、红包、转账等非对话内容，直接输出 [NOT_DIALOG]。`

const DEFAULT_REPLY_PROMPT = `你是一个微信自动回复助手。根据以下聊天记录，生成一个自然、口语化的回复。

## 规则
1. 只输出回复文字，不要解释、不要添加多余内容
2. 如果最后一条消息是我自己发送的（标注了 [SELF_LAST]），输出 [SKIP]
3. 如果是系统消息、群公告等非对话内容（标注了 [NOT_DIALOG]），输出 [SKIP]
4. 回复要自然、口语化，像真人对话`

export const manifest = {
  id: 'volcengine-ark',
  apiVersion: 1
}

export function createProvider(context) {
  const providerConfig = context && context.providerConfig ? context.providerConfig : {}

  return {
    async *run(input) {
      if (!input || !input.screenshot) {
        yield { type: 'skip' }
        return
      }

      const apiKey = providerConfig.apiKey
      if (!apiKey) {
        yield { type: 'error', error: '聊天服务缺少视觉接口密钥' }
        return
      }

      const replyApiKey = providerConfig.replyApiKey

      try {
        if (replyApiKey) {
          yield { type: 'thinking', content: '正在识别截图中的聊天内容...' }

          const transcript = await transcribeScreenshot({
            screenshot: input.screenshot,
            apiKey,
            model: providerConfig.model || DEFAULT_VLM_MODEL,
            baseURL: DEFAULT_VLM_BASE_URL
          })

          if (!transcript || transcript === '[NOT_DIALOG]') {
            yield { type: 'skip' }
            return
          }

          yield { type: 'thinking', content: '正在使用 DeepSeek 生成回复...' }

          const memorySection = buildMemorySection(input.memoryCards)
          const reply = await callTextReply({
            transcript,
            apiKey: replyApiKey,
            model: providerConfig.replyModel || DEFAULT_REPLY_MODEL,
            baseURL: providerConfig.replyBaseURL || DEFAULT_REPLY_BASE_URL,
            systemPrompt: (providerConfig.replySystemPrompt || DEFAULT_REPLY_PROMPT) + memorySection
          })

          if (!reply || reply.trim() === '[SKIP]') {
            yield { type: 'skip' }
            return
          }

          yield { type: 'reply_text', content: reply.trim() }
        } else {
          const memorySection = buildMemorySection(input.memoryCards)
          yield {
            type: 'thinking',
            content: memorySection
              ? `正在分析聊天内容（已加载 ${input.memoryCards.length} 条团队经验）...`
              : '正在分析聊天内容...'
          }

          const reply = await callVisionReply({
            screenshot: input.screenshot,
            apiKey,
            model: providerConfig.model || DEFAULT_VLM_MODEL,
            systemPrompt: (providerConfig.systemPrompt || DEFAULT_PROMPT) + memorySection
          })

          if (!reply || reply.trim() === '[SKIP]') {
            yield { type: 'skip' }
            return
          }

          yield { type: 'reply_text', content: reply.trim() }
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        if (context && context.host && typeof context.host.log === 'function') {
          context.host.log(`provider error: ${message}`)
        }
        yield { type: 'error', error: message || '聊天服务调用失败' }
      }
    }
  }
}

async function transcribeScreenshot({ screenshot, apiKey, model, baseURL }) {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: TRANSCRIBE_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: normalizeImageUrl(screenshot) } },
            { type: 'text', text: '请识别这张截图中的聊天内容。' }
          ]
        }
      ],
      stream: false
    })
  })

  if (!response.ok) {
    throw new Error(`VLM transcription failed: ${response.status} ${response.statusText}`)
  }

  const json = await response.json()
  const text = json?.choices?.[0]?.message?.content || ''
  return text.trim()
}

async function callTextReply({ transcript, apiKey, model, baseURL, systemPrompt }) {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `以下是聊天记录：\n\n${transcript}\n\n请根据以上聊天记录生成回复。` }
      ],
      stream: false
    })
  })

  if (!response.ok) {
    throw new Error(`DeepSeek reply failed: ${response.status} ${response.statusText}`)
  }

  const json = await response.json()
  return json?.choices?.[0]?.message?.content?.trim() || ''
}

async function callVisionReply({ screenshot, apiKey, model, systemPrompt }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: normalizeImageUrl(screenshot) } },
          { type: 'text', text: '请根据截图中微信聊天窗口的最新消息进行回复。' }
        ]
      }
    ],
    stream: false
  }

  const response = await fetch(`${DEFAULT_VLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    throw new Error(`VLM request failed: ${response.status} ${response.statusText}`)
  }

  const json = await response.json()
  return json?.choices?.[0]?.message?.content?.trim() || ''
}

function buildMemorySection(memoryCards) {
  if (!Array.isArray(memoryCards) || memoryCards.length === 0) {
    return ''
  }
  const lines = memoryCards.map((card, index) => {
    const rationale = card.rationale ? `（原因：${card.rationale}）` : ''
    return `${index + 1}. 【${card.scenario}】${card.guidance}${rationale}`
  })
  return `\n\n## 团队经验（来自工作记忆，优先遵循）\n${lines.join('\n')}`
}

function normalizeImageUrl(screenshot) {
  const rawBase64 = stripBase64Prefix(screenshot)
  if (rawBase64.startsWith('http')) {
    return rawBase64
  }
  return `data:image/png;base64,${rawBase64}`
}

function stripBase64Prefix(base64) {
  const idx = String(base64).indexOf('base64,')
  return idx !== -1 ? String(base64).slice(idx + 'base64,'.length) : String(base64)
}
