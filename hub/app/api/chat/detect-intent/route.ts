import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { GoogleGenerativeAI, SchemaType, type Schema } from '@google/generative-ai'

const genAI = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || ''
)

export const runtime = 'nodejs'

const intentSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    intent: {
      type: SchemaType.STRING,
      description: 'The classified intent. If no intent matches perfectly, return an empty string.',
      nullable: true,
    },
    extractedEntities: {
      type: SchemaType.OBJECT,
      description: 'Any entities extracted from the message that match the intent\'s required context fields. Keys are the entity names, values are the extracted strings.',
      properties: {
        // Since we don't know the exact keys ahead of time, we just ask for an object.
        // The LLM will return a map of extracted keys.
      }
    }
  },
  required: ['extractedEntities']
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { message: string; availableIntents: { id: string; description: string; expectedEntities: string[] }[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { message, availableIntents } = body

  if (!message || !availableIntents) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: `You are a strict intent classifier for an operations platform. 
Classify the user's message into one of the available intents.
If the message does not match any intent, return an empty string for the intent.
Also extract any relevant details from the user's message that map to the "expectedEntities" for that intent.

Available Intents:
${availableIntents.map(i => `- ID: ${i.id}\n  Description: ${i.description}\n  Expected Entities: ${i.expectedEntities.join(', ')}`).join('\n\n')}
`,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: intentSchema,
        temperature: 0,
      }
    })

    const result = await model.generateContent(message)
    const text = result.response.text()
    const parsed = JSON.parse(text)

    return NextResponse.json(parsed)
  } catch (err) {
    console.error('Intent Detection Error:', err)
    return NextResponse.json({ intent: null, extractedEntities: {} })
  }
}
