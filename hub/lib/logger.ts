import pino from 'pino'
import crypto from 'crypto'

const isDev = process.env.NODE_ENV !== 'production'

export function createLogger(module: string, correlationId?: string) {
  const id = correlationId ?? crypto.randomUUID()

  return pino({
    level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    ...(isDev
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  }).child({ module, correlationId: id })
}

export function withCorrelationId(id: string) {
  return logger.child({ correlationId: id })
}

export const logger = createLogger('hub')
