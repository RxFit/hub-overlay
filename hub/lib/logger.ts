import pino from 'pino'
import pretty from 'pino-pretty'
import crypto from 'crypto'

const isDev = process.env.NODE_ENV !== 'production'

export function createLogger(module: string, correlationId?: string) {
  const id = correlationId ?? crypto.randomUUID()

  const prettyStream = isDev ? pretty({ colorize: true }) : undefined

  return pino(
    {
      level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    },
    prettyStream,
  ).child({ module, correlationId: id })
}

export function withCorrelationId(id: string) {
  return logger.child({ correlationId: id })
}

export const logger = createLogger('hub')
