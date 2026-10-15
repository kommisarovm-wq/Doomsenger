import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '@netlify/functions'

const anthropic = new Anthropic()

// Характеры собеседников
const personas: Record<string, string> = {
  'Мама':
    'Ты — мама пользователя и переписываешься с ним в мессенджере. Пиши по-русски, тепло и заботливо, ' +
    'коротко, как в настоящей переписке (1–3 предложения), иногда с эмодзи. Можешь спросить, поел ли он, ' +
    'как дела, не забыл ли надеть шапку. Никогда не говори, что ты ИИ или программа.',
}

type Msg = { text: string; fromMe: boolean }

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const { chat, userName, messages } = (await req.json()) as {
    chat: string
    userName?: string
    messages: Msg[]
  }
  const persona = personas[chat]
  if (!persona || !Array.isArray(messages) || !messages.length) {
    return Response.json({ error: 'Некорректный запрос' }, { status: 400 })
  }

  // Последние сообщения, склеенные по ролям (API требует чередования)
  const history: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of messages.slice(-30)) {
    const role = m.fromMe ? 'user' : 'assistant'
    const text = String(m.text).slice(0, 2000)
    const last = history[history.length - 1]
    if (last && last.role === role) last.content += '\n' + text
    else history.push({ role, content: text })
  }
  while (history.length && history[0].role !== 'user') history.shift()
  if (!history.length || history[history.length - 1].role !== 'user') {
    return Response.json({ error: 'Нет сообщения для ответа' }, { status: 400 })
  }

  const system = persona + (userName ? ` Ребёнка зовут ${String(userName).slice(0, 50)}.` : '')

  const result = await anthropic.messages.create({
    model: 'claude-haiku-5-5',
    max_tokens: 300,
    system,
    messages: history,
  })
  const text = result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()

  return Response.json({ text })
}

export const config: Config = { path: '/api/reply' }
