import { describe, expect, it } from 'vitest'
import { handleUsageDashboard } from '../src/routes/usage-dashboard-ui'

describe('usage dashboard UI', () => {
  it('renders the Logs and Activity product surface without embedding a token', async () => {
    const response = handleUsageDashboard()
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(html).toContain('Usage truth,')
    expect(html).toContain('Usage by model')
    expect(html).toContain('Usage by provider')
    expect(html).toContain('Logs')
    expect(html).toContain("let token=''")
    expect(html).not.toMatch(/ADMIN_TOKEN\s*=/)
    const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1]
    expect(script).toBeTruthy()
    expect(() => new Function(script!)).not.toThrow()
  })
})
