'use client'

export interface ChatWelcomeProps {
  userName?: string
}

export function ChatWelcome({ userName }: ChatWelcomeProps) {
  return (
    <div className="chat-welcome chat-welcome--animate" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', flex: 1, gap: '12px', padding: '48px 24px',
      textAlign: 'center',
    }}>
      <div className="chat-message-avatar chat-message-avatar-ai"
        style={{ width: 52, height: 52, fontSize: '1.3rem' }}>✦</div>
      <h3 style={{
        fontFamily: 'var(--font-display)', fontSize: '1.15rem',
        fontWeight: 800, color: 'var(--text-primary)', margin: 0,
        letterSpacing: '-0.02em',
      }}>
        {userName ? `Hey ${userName.split(' ')[0]} 👋` : 'Hey there 👋'}
      </h3>
      <p style={{
        fontFamily: 'var(--font-chat)', fontSize: 'var(--text-sm)',
        color: 'var(--text-muted)',
        maxWidth: '300px', lineHeight: 1.6, margin: 0,
      }}>
        I'm your business co-pilot. Ask me anything about your workspace.
      </p>
    </div>
  )
}
