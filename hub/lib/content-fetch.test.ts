import { describe, it, expect } from 'vitest'
import { isPrivateAddress } from '@/lib/content-fetch'

describe('isPrivateAddress (SSRF guard)', () => {
  it('blocks IPv4 loopback and private ranges', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('10.1.2.3')).toBe(true)
    expect(isPrivateAddress('192.168.0.1')).toBe(true)
    expect(isPrivateAddress('172.16.0.1')).toBe(true)
    expect(isPrivateAddress('172.31.255.255')).toBe(true)
    expect(isPrivateAddress('0.0.0.0')).toBe(true)
  })

  it('blocks the cloud metadata / link-local range', () => {
    expect(isPrivateAddress('169.254.169.254')).toBe(true)
  })

  it('blocks CGNAT 100.64.0.0/10', () => {
    expect(isPrivateAddress('100.64.0.1')).toBe(true)
    expect(isPrivateAddress('100.127.255.255')).toBe(true)
    // outside the /10 is public
    expect(isPrivateAddress('100.128.0.1')).toBe(false)
  })

  it('allows ordinary public IPv4', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('1.1.1.1')).toBe(false)
    expect(isPrivateAddress('172.32.0.1')).toBe(false) // just outside 172.16/12
  })

  it('blocks IPv6 loopback, unique-local, link-local', () => {
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('fd00::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
  })

  it('blocks IPv4-mapped IPv6 that wraps a private IP (bypass attempt)', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateAddress('[::ffff:169.254.169.254]')).toBe(true)
  })

  it('allows a public IPv6 address', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
  })
})
