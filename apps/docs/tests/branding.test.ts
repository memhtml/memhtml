import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { inflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"

import {
  APPLE_TOUCH_SIZE,
  GRID,
  ICO_SIZES,
  ICON_PNG_SIZE,
  MARK,
  markArtifacts,
  markRaster,
  markSvg,
  PALETTE
} from "../src/branding/mark.ts"
import {
  DESCRIPTION_BUDGET,
  INK_SECONDARY,
  ogAlt,
  ogCard,
  ogSlug,
  TITLE_BUDGET
} from "../src/branding/og-card.ts"

/**
 * The mark, its committed artifacts, and the social card.
 *
 * The artifacts are compared as PIXELS, not as bytes. A byte comparison would fail the moment a
 * different zlib packed the same image differently, which is a false drift; a pixel comparison fails
 * only when the committed icon stops drawing the current mark, which is the drift worth catching. The
 * PNG is decoded here rather than by the module under test, so a broken encoder cannot agree with
 * itself.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const asset = (file: string): Uint8Array => new Uint8Array(readFileSync(join(root, "public", file)))

interface Decoded {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
}

/** An RGBA8 PNG with a single IDAT and no interlacing — which is all `markPng` emits. */
const decodePng = (bytes: Uint8Array): Decoded => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  let at = 8
  let header: Decoded | undefined
  const data: Array<Uint8Array> = []
  while (at < bytes.length) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    const payload = bytes.subarray(at + 8, at + 8 + length)
    if (type === "IHDR") {
      const bitDepth = payload[8]
      const colorType = payload[9]
      const interlace = payload[12]
      expect({ bitDepth, colorType, interlace }).toEqual({
        bitDepth: 8,
        colorType: 6,
        interlace: 0
      })
      header = {
        width: view.getUint32(at + 8),
        height: view.getUint32(at + 12),
        pixels: new Uint8Array(0)
      }
    }
    if (type === "IDAT") data.push(payload)
    at += length + 12
  }
  if (header === undefined) throw new Error("no IHDR")

  const raw = new Uint8Array(inflateSync(Buffer.concat(data)))
  const stride = header.width * 4
  const pixels = new Uint8Array(stride * header.height)
  for (let y = 0; y < header.height; y += 1) {
    // Every scanline in these images uses filter type 0, so the row is copied straight out.
    expect(raw[y * (stride + 1)]).toBe(0)
    pixels.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride)
  }
  return { ...header, pixels }
}

const colorAt = ({ width, pixels }: Decoded, x: number, y: number): string => {
  const at = (y * width + x) * 4
  const hex = (channel: number | undefined): string =>
    (channel ?? 0).toString(16).padStart(2, "0").toUpperCase()
  return `#${hex(pixels[at])}${hex(pixels[at + 1])}${hex(pixels[at + 2])}`
}

describe("the mark", () => {
  it("draws every rectangle on whole units of the grid", () => {
    for (const rect of MARK) {
      for (const value of [rect.x, rect.y, rect.w, rect.h]) {
        expect(Number.isInteger(value)).toBe(true)
      }
      expect(rect.x + rect.w).toBeLessThanOrEqual(GRID)
      expect(rect.y + rect.h).toBeLessThanOrEqual(GRID)
      // Nothing thinner than two units, or it is a hairline at favicon size.
      expect(Math.min(rect.w, rect.h)).toBeGreaterThanOrEqual(2)
    }
  })

  /*
   * Every color the mark and the card use has to be one `rfc.css` measured a ratio for. A fourth
   * value invented here would be the one color on the site with no contrast figure behind it.
   */
  it("uses only the palette rfc.css measured", () => {
    const css = readFileSync(join(root, "src", "styles", "rfc.css"), "utf8")
    for (const value of [...Object.values(PALETTE), INK_SECONDARY]) {
      expect(css).toContain(value.toLowerCase())
    }
    expect(new Set(MARK.map((rect) => rect.fill))).toEqual(new Set(Object.values(PALETTE)))
  })

  it("covers every pixel of a 16px raster, so nothing shows through", () => {
    const raster = markRaster(GRID)
    for (let at = 3; at < raster.length; at += 4) expect(raster[at]).toBe(255)
  })

  it("names each stroke", () => {
    expect(MARK.map((rect) => rect.role)).toEqual([
      "ground",
      "document name",
      "status line",
      "masthead rule"
    ])
  })
})

describe("the committed artifacts still draw the mark", () => {
  it("ships one file per declared artifact", () => {
    for (const { file } of markArtifacts()) {
      expect(asset(file).length).toBeGreaterThan(0)
    }
  })

  it("keeps favicon.svg byte-identical to the generator", () => {
    expect(readFileSync(join(root, "public", "favicon.svg"), "utf8")).toBe(markSvg())
  })

  it.for([
    { file: `icon-${ICON_PNG_SIZE}.png`, size: ICON_PNG_SIZE },
    { file: "apple-touch-icon.png", size: APPLE_TOUCH_SIZE }
  ])("draws the mark in $file", ({ file, size }) => {
    const decoded = decodePng(asset(file))
    expect([decoded.width, decoded.height]).toEqual([size, size])
    expect([...decoded.pixels]).toEqual([...markRaster(size)])
  })

  it("carries one PNG per declared size in favicon.ico, in order", () => {
    const ico = asset("favicon.ico")
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength)
    expect(view.getUint16(0, true)).toBe(0)
    expect(view.getUint16(2, true)).toBe(1)
    expect(view.getUint16(4, true)).toBe(ICO_SIZES.length)

    ICO_SIZES.forEach((size, at) => {
      const entry = 6 + at * 16
      expect(ico[entry]).toBe(size)
      expect(ico[entry + 1]).toBe(size)
      expect(view.getUint16(entry + 6, true)).toBe(32)
      const offset = view.getUint32(entry + 12, true)
      const length = view.getUint32(entry + 8, true)
      const decoded = decodePng(ico.subarray(offset, offset + length))
      expect([decoded.width, decoded.height]).toEqual([size, size])
      expect([...decoded.pixels]).toEqual([...markRaster(size)])
    })
  })

  /*
   * The three colors, read out of the raster at the coordinate each stroke owns.
   *
   * This is the check that would fail on a mark that encodes and decodes perfectly and draws the
   * wrong thing — a transposed rectangle, a swapped fill, a red band that lost its bleed.
   */
  it("puts paper at the corner, ink on the rules, and red across the whole foot", () => {
    const decoded = decodePng(asset(`icon-${ICON_PNG_SIZE}.png`))
    const unit = ICON_PNG_SIZE / GRID
    const center = (rect: { x: number; y: number; w: number; h: number }): [number, number] => [
      Math.round((rect.x + rect.w / 2) * unit),
      Math.round((rect.y + rect.h / 2) * unit)
    ]

    expect(colorAt(decoded, 0, 0)).toBe(PALETTE.paper)
    for (const rect of MARK.slice(1)) {
      const [x, y] = center(rect)
      expect(colorAt(decoded, x, y)).toBe(rect.fill)
    }
    // The foot bleeds: both bottom corners are red, not paper.
    const bottom = ICON_PNG_SIZE - 1
    expect(colorAt(decoded, 0, bottom)).toBe(PALETTE.normative)
    expect(colorAt(decoded, bottom, bottom)).toBe(PALETTE.normative)
  })
})

describe("the social card", () => {
  it("slugs the root page by name rather than to a bare extension", () => {
    expect(ogSlug("")).toBe("index.png")
    expect(ogSlug("internals/the-index")).toBe("internals/the-index.png")
  })

  it("states the brand line on the root card and nowhere else", () => {
    const root = ogCard({ id: "index", title: "memhtml", description: "Memory for agents." })
    expect(root.description).toContain("MEANING · MEMORY · MARKUP")
    for (const id of ["learn/tutorial/install", "internals/the-index", "glossary"]) {
      expect(ogCard({ id, title: "x", description: "y" }).description).not.toContain("MEANING")
    }
  })

  it("names the tier and the path in the running foot", () => {
    const card = ogCard({
      id: "internals/the-index",
      title: "The index",
      description: "Two planes."
    })
    expect(card.description).toContain("memhtml · Internals")
    expect(card.description).toContain("/internals/the-index/")
  })

  it("keeps a card free of a gradient, a border radius and a background image", () => {
    const card = ogCard({ id: "learn", title: "Learn", description: "Tutorials." })
    // A single stop is a flat fill; two or more would be the gradient this direction refuses.
    expect(card.bgGradient).toHaveLength(1)
    expect(card.bgImage).toBeUndefined()
    expect(card.border?.side).toBe("block-end")
  })

  it("trims an over-long title and description at a word boundary", () => {
    const long = "the write path and every ordering constraint it imposes on a batch of memories "
    const card = ogCard({ id: "internals/x", title: long.repeat(2), description: long.repeat(4) })
    expect(card.title.length).toBeLessThanOrEqual(TITLE_BUDGET + 1)
    expect(card.title.endsWith("…")).toBe(true)
    expect(card.title).not.toMatch(/ …$/)
    const abstract = card.description?.split("\n\n")[0] ?? ""
    expect(abstract.length).toBeLessThanOrEqual(DESCRIPTION_BUDGET + 1)
    expect(abstract.endsWith("…")).toBe(true)
  })

  it("leaves a title and description inside budget untouched", () => {
    const card = ogCard({ id: "glossary", title: "Glossary", description: "The vocabulary." })
    expect(card.title).toBe("Glossary")
    expect(card.description).toContain("The vocabulary.")
    expect(card.description).not.toContain("…")
  })

  it("describes the card rather than repeating the site name in the alt text", () => {
    expect(ogAlt("Four-arm retrieval")).toContain("Four-arm retrieval")
    expect(ogAlt("Four-arm retrieval")).toMatch(/paper|rule/)
  })
})
