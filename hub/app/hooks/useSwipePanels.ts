import { useRef, useCallback } from 'react'

export interface SwipePanelsProps {
  mobileLeftOpen: boolean
  mobileRightOpen: boolean
  handleClosePanels: () => void
  handleMobileTab: (tab: 'command' | 'execution' | 'chat') => void
}

export function useSwipePanels({
  mobileLeftOpen,
  mobileRightOpen,
  handleClosePanels,
  handleMobileTab,
}: SwipePanelsProps) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const swipeDirRef = useRef<'left' | 'right' | null>(null)
  const isSwipingRef = useRef(false)
  const leftPanelRef = useRef<HTMLElement>(null)
  const rightPanelRef = useRef<HTMLElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const SWIPE_COMMIT = 104 // px to commit open/close (~30% more bail room)

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    const target = e.target as HTMLElement
    // Skip swipe tracking inside the chat interaction zone
    if (
      target.closest('.chat-suggestions') ||
      target.closest('.chat-input-area') ||
      target.closest('.quoted-reply-chip') ||
      target.closest('.doc-filter-tabs') ||
      target.closest('.section-row')
    ) {
      touchStartRef.current = null
      return
    }
    touchStartRef.current = { x: touch.clientX, y: touch.clientY }
    swipeDirRef.current = null
    isSwipingRef.current = false
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return
    const touch = e.touches[0]
    const dx = touch.clientX - touchStartRef.current.x
    const dy = touch.clientY - touchStartRef.current.y

    // Lock direction on first significant movement
    if (!swipeDirRef.current) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
      if (Math.abs(dy) > Math.abs(dx)) {
        // Vertical scroll — abort swipe tracking
        touchStartRef.current = null
        return
      }
      swipeDirRef.current = dx > 0 ? 'right' : 'left'
      isSwipingRef.current = true
    }

    const screenW = window.innerWidth
    if (screenW > 640) return // Desktop — no drag

    // Determine what panel to show based on swipe + current state
    if (swipeDirRef.current === 'right') {
      if (mobileRightOpen && rightPanelRef.current) {
        // Closing right panel — drag it away
        const offset = Math.max(0, dx)
        rightPanelRef.current.style.transform = `translateX(${offset}px)`
        rightPanelRef.current.style.transition = 'none'
        if (backdropRef.current) {
          backdropRef.current.style.opacity = String(Math.max(0, 1 - offset / (screenW * 0.4)))
        }
      } else if (!mobileLeftOpen && leftPanelRef.current) {
        // Opening left panel — drag it in from -100%
        const progress = Math.min(dx / screenW, 1)
        const panelX = -screenW + (progress * screenW)
        leftPanelRef.current.style.transform = `translateX(${panelX}px)`
        leftPanelRef.current.style.transition = 'none'
        leftPanelRef.current.style.visibility = 'visible'
        if (backdropRef.current) {
          backdropRef.current.style.display = 'block'
          backdropRef.current.style.opacity = String(Math.min(progress * 1.5, 1))
        }
      }
    } else if (swipeDirRef.current === 'left') {
      if (mobileLeftOpen && leftPanelRef.current) {
        // Closing left panel — drag it away
        const offset = Math.min(0, dx)
        leftPanelRef.current.style.transform = `translateX(${offset}px)`
        leftPanelRef.current.style.transition = 'none'
        if (backdropRef.current) {
          backdropRef.current.style.opacity = String(Math.max(0, 1 - Math.abs(offset) / (screenW * 0.4)))
        }
      } else if (!mobileRightOpen && rightPanelRef.current) {
        // Opening right panel — drag it in from +100%
        const progress = Math.min(Math.abs(dx) / screenW, 1)
        const panelX = screenW - (progress * screenW)
        rightPanelRef.current.style.transform = `translateX(${panelX}px)`
        rightPanelRef.current.style.transition = 'none'
        rightPanelRef.current.style.visibility = 'visible'
        if (backdropRef.current) {
          backdropRef.current.style.display = 'block'
          backdropRef.current.style.opacity = String(Math.min(progress * 1.5, 1))
        }
      }
    }
  }, [mobileLeftOpen, mobileRightOpen])

  // Clear imperative inline backdrop styles so React's rendered values win again
  // (prevents a mid-drag display/opacity from desyncing after a gesture ends).
  const resetBackdropToReact = () => {
    if (backdropRef.current) {
      backdropRef.current.style.display = ''
      backdropRef.current.style.opacity = ''
    }
  }

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current || !isSwipingRef.current) {
      touchStartRef.current = null
      resetBackdropToReact()
      return
    }

    const touch = e.changedTouches[0]
    const dx = touch.clientX - touchStartRef.current.x
    const dir = swipeDirRef.current
    touchStartRef.current = null
    swipeDirRef.current = null
    isSwipingRef.current = false

    const screenW = window.innerWidth
    if (screenW > 640) return

    // Reset inline styles so CSS transitions take over
    const resetPanel = (el: HTMLElement | null) => {
      if (!el) return
      el.style.transform = ''
      el.style.transition = ''
      el.style.visibility = ''
    }
    // Let React's rendered backdrop style (page.tsx) become the source of truth
    // once the gesture ends; handleClosePanels/handleMobileTab below flip the
    // open flags that drive the rendered display/opacity.
    resetBackdropToReact()

    const absDx = Math.abs(dx)
    const committed = absDx > SWIPE_COMMIT

    if (dir === 'right') {
      if (mobileRightOpen && committed) {
        resetPanel(rightPanelRef.current)
        handleClosePanels()
      } else if (!mobileLeftOpen && committed) {
        resetPanel(leftPanelRef.current)
        handleMobileTab('command')
      } else {
        resetPanel(leftPanelRef.current)
        resetPanel(rightPanelRef.current)
      }
    } else if (dir === 'left') {
      if (mobileLeftOpen && committed) {
        resetPanel(leftPanelRef.current)
        handleClosePanels()
      } else if (!mobileRightOpen && committed) {
        resetPanel(rightPanelRef.current)
        handleMobileTab('execution')
      } else {
        resetPanel(leftPanelRef.current)
        resetPanel(rightPanelRef.current)
      }
    } else {
      resetPanel(leftPanelRef.current)
      resetPanel(rightPanelRef.current)
    }
  }, [mobileLeftOpen, mobileRightOpen, handleClosePanels, handleMobileTab])

  return {
    leftPanelRef,
    rightPanelRef,
    backdropRef,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  }
}
