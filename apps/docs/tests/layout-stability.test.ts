import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AUDITED_PAGES, BASE, DIST_DIR, LAYOUT_SHIFT_CEILING } from "../src/gates.js"
import { type StaticSite, serveStatic } from "./static-server.js"

/**
 * Layout stability, measured where the viewport cannot change under the measurement.
 *
 * ## Why this exists beside the Lighthouse budget rather than inside it
 *
 * Cumulative Layout Shift is the one metric in the performance category that Lighthouse cannot
 * measure reliably on a loaded machine, because it competes with Lighthouse's OWN viewport
 * emulation. Measured 2026-08-14 on `/internals/the-memory-file-format/`: three runs of one
 * unchanged page, identical `screenEmulation` (1350x940) and host `benchmarkIndex` (1075-1176),
 * scored `1, 1, 0.81` — the odd one out carrying `CLS 0.427` with `TBT 0 ms` and `LCP 324 ms`, so
 * every metric that describes the page was perfect. The shift it recorded is attributed to
 * Starlight's table-of-contents container with a bounding box 1335px wide ending at x=2370, which
 * does not fit inside the 1350px viewport it claims to have been measured in: the geometry belongs
 * to the pre-emulation window, and the resize to the emulated viewport was counted as a shift.
 * Under CPU contention that resize lands after first paint often enough to fail a blocking gate —
 * observed on CI (`memhtml/memhtml` run 31843605723) and reproduced locally on two pinned cores.
 *
 * So the composite score is asserted `optimistic` in `lighthouserc.json` — contention can only
 * depress a static page's score, never inflate it — and layout stability is asserted HERE instead,
 * with the viewport fixed before the first navigation so no emulation can race the paint. Same
 * remedy the `scrollable-region-focusable` flake got in `tests/a11y.test.ts`, and for the same
 * reason: a blocking gate cannot hold a measurement that flips on an unchanged page.
 *
 * The ceiling is not a suppression. `LAYOUT_SHIFT_CEILING` is the Core Web Vitals "good" threshold,
 * and every page here measures 0 today, so a real shift — an image without dimensions, a late
 * stylesheet, a web font that changes metrics — fails this gate on the first run rather than on the
 * one run in three where Lighthouse happens to notice.
 */

const dist = join(fileURLToPath(new URL("..", import.meta.url)), DIST_DIR)

/** The viewport Lighthouse's desktop preset emulates, set BEFORE any navigation. */
const VIEWPORT = { width: 1350, height: 940 }

/**
 * How long the page is watched after it goes quiet.
 *
 * A shift that arrives with a late resource is the defect this gate is for, so the observer has to
 * outlive `networkidle` — a probe that stopped there would measure only the shifts that beat the
 * network.
 */
const SETTLE_MS = 1_500

let site: StaticSite
let browser: Browser
const shifts = new Map<string, number>()

beforeAll(async () => {
  site = await serveStatic(dist, BASE)
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: VIEWPORT })
  for (const path of AUDITED_PAGES) {
    const page = await context.newPage()
    /**
     * The observer is installed as an init script, so it is running before the document's first
     * byte. Registering it after `goto` would miss every shift that happened during load, which is
     * all of the ones worth catching.
     *
     * `hadRecentInput` entries are dropped for the reason the metric drops them: a shift the user
     * asked for by clicking is not a layout defect. Nothing here clicks, so this only guards
     * against a future case that does.
     */
    await page.addInitScript(() => {
      const w = window as unknown as { __shift: number }
      w.__shift = 0
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            value: number
            hadRecentInput: boolean
          }
          if (!shift.hadRecentInput) w.__shift += shift.value
        }
      }).observe({ type: "layout-shift", buffered: true })
    })
    await page.goto(`${site.origin}${path}`, { waitUntil: "networkidle" })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(SETTLE_MS)
    shifts.set(path, await page.evaluate(() => (window as unknown as { __shift: number }).__shift))
    await page.close()
  }
  await context.close()
}, 300_000)

afterAll(async () => {
  await browser?.close()
  await site?.close()
})

describe("no audited page shifts its layout while it loads", () => {
  it.each([...AUDITED_PAGES])("holds %s under the Core Web Vitals ceiling", (path) => {
    const measured = shifts.get(path)
    expect(measured, `${path} was never measured`).toBeDefined()
    expect(measured, `${path} shifted ${measured}`).toBeLessThan(LAYOUT_SHIFT_CEILING)
  })

  /**
   * Every page measured, and the probe proved capable of seeing a shift at all.
   *
   * A `PerformanceObserver` that silently failed to register — a renamed entry type, a browser
   * without the API — would report 0 for every page and pass forever. So the observer is exercised
   * against a page that shifts on purpose, and its verdict is asserted to exceed the ceiling the
   * real pages sit under.
   */
  it("registers a shift when one happens, so a zero means stability", async () => {
    const context = await browser.newContext({ viewport: VIEWPORT })
    const page = await context.newPage()
    /**
     * The observer ships INSIDE the fixture here, not through `addInitScript`.
     *
     * `setContent` lands on `about:blank`, which runs no init script, so a probe written the way the
     * page loop above is written would read `undefined` and this case would fail for a reason that
     * says nothing about layout shift. The loop's own use of `addInitScript` is proven by the four
     * cases above: an init script that never ran leaves `__shift` undefined, and
     * `toBeLessThan` throws on undefined rather than passing.
     *
     * The fixture is the shape of the defect this gate exists to catch — an element that gains height
     * after paint and pushes the content below it down.
     */
    await page.setContent(
      `<body style="margin:0">
         <script>
           window.__shift = 0
           new PerformanceObserver((list) => {
             for (const entry of list.getEntries()) window.__shift += entry.value
           }).observe({ type: "layout-shift", buffered: true })
         </script>
         <div id="pusher"></div>
         <p style="height:600px;background:#eee">content that gets pushed</p>
         <script>
           requestAnimationFrame(() => {
             setTimeout(() => {
               document.getElementById("pusher").style.height = "400px"
             }, 100)
           })
         </script>
       </body>`
    )
    await page.waitForTimeout(600)
    const measured = await page.evaluate(() => (window as unknown as { __shift: number }).__shift)
    await context.close()
    expect(measured).toBeGreaterThan(LAYOUT_SHIFT_CEILING)
  }, 60_000)
})
