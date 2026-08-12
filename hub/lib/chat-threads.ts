/**
 * Google Chat thread grouping (PURE, client-safe).
 *
 * Google Chat's official UI collapses each thread into its starter message in
 * the main conversation, with a "N replies" affordance that opens the thread.
 * The Chat API, however, returns `spaces.messages.list` FLAT: thread replies
 * are interleaved with thread starters in plain createTime order, and the only
 * structure offered is each message's `thread.name` (plus the output-only
 * `threadReply` flag on replies).
 *
 * This module rebuilds the official UI's shape from that flat page: one group
 * per thread, in the order the threads started, each with its root message and
 * its in-page replies. It is deliberately free of React/`next/*` imports so the
 * panel, tests and any server-side consumer can share it (same rule as
 * lib/chat-spaces.ts).
 */

/** The subset of the Chat API `Message` resource that grouping needs. */
export interface ThreadableMessage {
  name: string
  createTime: string
  thread?: { name?: string }
  /** Output-only Chat API flag: true when the message replies inside a thread. */
  threadReply?: boolean
}

export interface ThreadGroup<M extends ThreadableMessage> {
  /**
   * Thread resource name ("spaces/x/threads/y"), or null when Google sent no
   * thread on the message (defensive — list responses normally always have one).
   * Null-thread messages can be displayed but not replied to in-thread.
   */
  threadName: string | null
  /** The thread starter — or, see `rootMissing`, its oldest IN-PAGE message. */
  root: M
  /** In-page replies, oldest first. */
  replies: M[]
  /**
   * True when the real thread starter is older than the fetched page, so
   * `root` is actually a reply standing in for it. The UI should offer
   * "View thread" (which fetches the complete thread) rather than presenting
   * this message as the start of the conversation.
   */
  rootMissing: boolean
}

/**
 * Collapse a chronological (oldest-first) message page into thread groups,
 * ordered by when each thread first appears in the page.
 *
 * Messages that share a `thread.name` join one group; the first seen becomes
 * the root. A message with no thread name gets a group of its own — it can
 * never accept replies, but it must still render.
 */
export function groupMessagesByThread<M extends ThreadableMessage>(
  messages: M[]
): ThreadGroup<M>[] {
  const groups: ThreadGroup<M>[] = []
  const byThread = new Map<string, ThreadGroup<M>>()

  for (const msg of messages) {
    const threadName = msg.thread?.name?.trim() || null
    const existing = threadName ? byThread.get(threadName) : undefined
    if (existing) {
      existing.replies.push(msg)
      continue
    }
    const group: ThreadGroup<M> = {
      threadName,
      root: msg,
      replies: [],
      // If the oldest in-page message of this thread is itself a reply, the
      // true starter fell off the page window.
      rootMissing: msg.threadReply === true,
    }
    groups.push(group)
    if (threadName) byThread.set(threadName, group)
  }

  return groups
}

/** Total replies a group shows in its "N replies" chip. */
export function threadReplyCount(group: ThreadGroup<ThreadableMessage>): number {
  // A stand-in root is itself a reply the chip must count, or a thread whose
  // starter scrolled off would claim one reply fewer than it shows.
  return group.replies.length + (group.rootMissing ? 1 : 0)
}

/** createTime of the group's most recent message (drives "Last reply …"). */
export function threadLastActivity(group: ThreadGroup<ThreadableMessage>): string {
  const last = group.replies[group.replies.length - 1]
  return (last ?? group.root).createTime
}

/**
 * Whether the reply-in-thread affordance applies to a space at all.
 *
 * Google only supports `messageReplyOption` in NAMED spaces; DMs and group
 * chats are flat conversations where the official UI offers no per-message
 * thread either. `spaceThreadingState` is authoritative when present
 * (THREADED_MESSAGES / GROUPED_MESSAGES organize by thread or topic;
 * UNTHREADED_MESSAGES is flat); older cached space objects without it fall
 * back to the spaceType discriminator.
 */
export function spaceSupportsThreadReplies(space: {
  spaceType?: string
  spaceThreadingState?: string
}): boolean {
  const threading = (space.spaceThreadingState ?? '').trim().toUpperCase()
  if (threading === 'THREADED_MESSAGES' || threading === 'GROUPED_MESSAGES') return true
  if (threading === 'UNTHREADED_MESSAGES') return false
  return (space.spaceType ?? '').trim().toUpperCase() === 'SPACE'
}
