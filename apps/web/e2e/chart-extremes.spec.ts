import { expect, test } from '@playwright/test'

test('charts at their extremes: no text leaves its chart, and they look as approved', async ({ page }) => {
  await page.goto('/e2e/fixtures/charts.html')
  await expect(page.getByTestId('case-residuals').locator('svg').first()).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const outside = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="case-"]')].flatMap((box) => {
      const name = box.getAttribute('data-testid')
      const svg = box.querySelector('svg[role="img"]')
      if (!svg) return [`${name}: no chart`]
      const frame = svg.getBoundingClientRect()
      return [...svg.querySelectorAll('text')].flatMap((text) => {
        const r = text.getBoundingClientRect()
        const inside =
          r.left >= frame.left - 1 &&
          r.right <= frame.right + 1 &&
          r.top >= frame.top - 1 &&
          r.bottom <= frame.bottom + 1
        return inside ? [] : [`${name}: "${text.textContent}"`]
      })
    }),
  )
  expect(outside).toEqual([])
  await expect(page).toHaveScreenshot('charts-extremes.png', { fullPage: true })
})
