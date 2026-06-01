'use client'

import { useState, useEffect } from 'react'

/**
 * Animated number display component.
 * Counts up to the target value with an ease-out cubic animation.
 * Supports formatted values like "$1,234k" (prefix + number + suffix).
 */
export function AnimatedNumber({ value, delay = 0 }: { value: string; delay?: number }) {
  const [visible, setVisible] = useState(false)
  const [displayed, setDisplayed] = useState('0')

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay)
    return () => clearTimeout(t)
  }, [delay])

  useEffect(() => {
    if (!visible) return
    const numMatch = value.match(/^(\$?)(\d[\d,]*)(.*)$/)
    if (!numMatch) { setDisplayed(value); return }
    const prefix = numMatch[1]
    const rawNum = parseInt(numMatch[2].replace(/,/g, ''), 10)
    const suffix = numMatch[3]
    if (isNaN(rawNum) || rawNum === 0) { setDisplayed(value); return }
    const duration = 900
    const startTime = performance.now()
    const tick = (now: number) => {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      const current = Math.round(eased * rawNum)
      const formatted = prefix + current.toLocaleString() + suffix
      setDisplayed(formatted)
      if (progress < 1) requestAnimationFrame(tick)
      else setDisplayed(value)
    }
    requestAnimationFrame(tick)
  }, [visible, value])

  return (
    <span
      className="animated-number"
      aria-label={value}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(8px)',
      }}
    >
      {displayed}
    </span>
  )
}
