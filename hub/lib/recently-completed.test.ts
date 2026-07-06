import { describe, it, expect } from 'vitest'
import {
  addRecentlyCompleted,
  removeRecentlyCompleted,
  MAX_RECENTLY_COMPLETED,
  type CompletedTaskEntry,
} from './recently-completed'

const entry = (id: string, title = `Task ${id}`, listId = 'L1'): CompletedTaskEntry => ({
  id,
  title,
  listId,
})

describe('addRecentlyCompleted', () => {
  it('adds an entry to an empty list', () => {
    expect(addRecentlyCompleted([], entry('a'))).toEqual([entry('a')])
  })

  it('prepends new entries (newest first)', () => {
    const list = addRecentlyCompleted([entry('a')], entry('b'))
    expect(list.map(e => e.id)).toEqual(['b', 'a'])
  })

  it('de-dupes by id, moving the re-completed task to the front', () => {
    const list = addRecentlyCompleted([entry('a'), entry('b')], entry('a', 'Updated'))
    expect(list.map(e => e.id)).toEqual(['a', 'b'])
    expect(list[0].title).toBe('Updated')
    expect(list).toHaveLength(2)
  })

  it('caps the list at MAX_RECENTLY_COMPLETED, dropping the oldest', () => {
    let list: CompletedTaskEntry[] = []
    for (let i = 0; i < MAX_RECENTLY_COMPLETED + 2; i++) {
      list = addRecentlyCompleted(list, entry(String(i)))
    }
    expect(list).toHaveLength(MAX_RECENTLY_COMPLETED)
    // newest kept, oldest ('0','1') dropped
    expect(list[0].id).toBe(String(MAX_RECENTLY_COMPLETED + 1))
    expect(list.some(e => e.id === '0')).toBe(false)
  })

  it('does not mutate the input list', () => {
    const input = [entry('a')]
    addRecentlyCompleted(input, entry('b'))
    expect(input).toEqual([entry('a')])
  })
})

describe('removeRecentlyCompleted', () => {
  it('removes the matching entry', () => {
    const list = removeRecentlyCompleted([entry('a'), entry('b')], 'a')
    expect(list.map(e => e.id)).toEqual(['b'])
  })

  it('is a no-op when the id is absent', () => {
    const list = [entry('a')]
    expect(removeRecentlyCompleted(list, 'zzz')).toEqual(list)
  })

  it('does not mutate the input list', () => {
    const input = [entry('a'), entry('b')]
    removeRecentlyCompleted(input, 'a')
    expect(input).toHaveLength(2)
  })
})
