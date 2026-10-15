import assert from 'node:assert/strict'

// Failure codes belong in the user's diagnostic Tooltip, not the main status.
export async function failureTooltip(page, code) {
  await page.locator('[data-nexus-voice] .nx-info').hover()
  const tooltip = page.getByRole('tooltip').filter({ hasText: code })
  await tooltip.waitFor()
  assert.ok((await tooltip.textContent()).includes(code))
  await page.mouse.move(0, 0)
}
