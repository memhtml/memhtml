import type { Loader, LoaderContext } from "astro/loaders"
import { describe, expect, it } from "vitest"

import { commandSlug, TIER } from "../src/loaders/pages.js"
import { loadReference, withReference } from "../src/loaders/reference.js"
import { collectRegistry, type Registry } from "../src/loaders/registry.js"

/**
 * The loader driven against a fake content store.
 *
 * The store is the only boundary Astro owns here: everything this loader does, it does by calling
 * `store.set` once per page. So a fake store is the whole contract, and a page lost between the
 * generator and the store is a failure in this file rather than a missing route noticed in a browser.
 *
 * The mutation lock is the point of the file. Appending a synthetic member to a registry must move
 * what the loader stores — otherwise every count on every page is decoration, and a probe asserting
 * a total would be asserting one the loader is free to ignore.
 */

const registry = collectRegistry()

/**
 * What the loader hands the store, declared here rather than imported.
 *
 * `astro:content`'s `DataEntry` is the type a PAGE receives at runtime and carries neither `digest`
 * nor `rendered`; the store's own entry type is internal to Astro. Naming the fields under assertion
 * keeps the fake honest about the shape the loader actually writes.
 */
interface StoredEntry {
  readonly id: string
  readonly data: Record<string, unknown>
  readonly filePath?: string | undefined
  readonly body?: string | undefined
  readonly digest?: number | string | undefined
  readonly rendered?: { readonly html: string } | undefined
}

interface Fake {
  readonly context: LoaderContext
  readonly stored: Map<string, StoredEntry>
}

const fakeContext = (): Fake => {
  const stored = new Map<string, StoredEntry>()
  const context = {
    collection: "docs",
    store: {
      set: (entry: StoredEntry) => {
        stored.set(entry.id, entry)
        return true
      },
      get: (key: string) => stored.get(key),
      keys: () => [...stored.keys()],
      values: () => [...stored.values()],
      entries: () => [...stored.entries()],
      has: (key: string) => stored.has(key),
      delete: (key: string) => stored.delete(key),
      clear: () => stored.clear(),
      addModuleImport: () => undefined
    },
    meta: {
      get: () => undefined,
      set: () => undefined,
      has: () => false,
      delete: () => undefined
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      options: {},
      label: "test",
      fork: () => context.logger
    },
    config: { base: "/memhtml" },
    parseData: async ({ data }: { data: Record<string, unknown> }) => data,
    renderMarkdown: async (content: string) => ({
      html: `<p>${content.length}</p>`,
      metadata: { headings: [], imagePaths: [], frontmatter: {} }
    }),
    generateDigest: (value: Record<string, unknown> | string) =>
      `digest-${JSON.stringify(value).length}`
    // The fake stands in for Astro's own context, whose surface is wider than this loader touches.
  } as unknown as LoaderContext
  return { context, stored }
}

const syntheticCommand = {
  name: "synthetic probe",
  summary: "A registry member that exists only inside this test.",
  args: [],
  flags: [],
  responseTypes: ["cli.manifest"]
} as const

const withSyntheticCommand = (base: Registry): Registry => ({
  ...base,
  commands: [...base.commands, syntheticCommand]
})

describe("the loader stores one entry per page", () => {
  it("gives every stored entry a non-empty filePath and rendered content", async () => {
    const { context, stored } = fakeContext()
    const pages = await loadReference(context, registry)

    expect(stored.size).toBe(pages.length)
    for (const entry of stored.values()) {
      expect(entry.filePath).toBeTruthy()
      expect(entry.filePath?.startsWith("src/content/docs/")).toBe(true)
      expect(entry.body).toBeTruthy()
      expect(entry.rendered?.html).toBeTruthy()
      expect(entry.digest).toBeTruthy()
      expect(entry.data.title).toBeTruthy()
      // No file exists to edit; the page names its registry instead.
      expect(entry.data.editUrl).toBe(false)
    }
  })

  it("stores the ids the generator declared, and no others", async () => {
    const { context, stored } = fakeContext()
    const pages = await loadReference(context, registry)
    expect([...stored.keys()].sort()).toEqual(pages.map((one) => one.id).sort())
  })
})

describe("the mutation lock", () => {
  it("stores one more page when a command joins the registry", async () => {
    const before = fakeContext()
    await loadReference(before.context, registry)

    const after = fakeContext()
    await loadReference(after.context, withSyntheticCommand(registry))

    expect(after.stored.size).toBe(before.stored.size + 1)
    expect(after.stored.has(`${TIER}/commands/${commandSlug(syntheticCommand.name)}`)).toBe(true)
    expect(before.stored.has(`${TIER}/commands/${commandSlug(syntheticCommand.name)}`)).toBe(false)
  })

  it("restates the new command count in the prose that quotes it", async () => {
    const { context, stored } = fakeContext()
    await loadReference(context, withSyntheticCommand(registry))
    const overview = stored.get(TIER)?.body ?? ""
    expect(overview).toContain(`accepts ${registry.commands.length + 1} commands`)
    expect(overview).not.toContain(`accepts ${registry.commands.length} commands`)
  })

  it("adds a row rather than a page when a member joins a tabulated registry", async () => {
    const grown: Registry = {
      ...registry,
      sleepPhases: [
        ...registry.sleepPhases,
        {
          name: "synthetic-phase",
          index: registry.sleepPhases.length + 1,
          commits: true,
          callsModel: false,
          blocks: []
        }
      ]
    }
    const before = fakeContext()
    await loadReference(before.context, registry)
    const after = fakeContext()
    await loadReference(after.context, grown)

    expect(after.stored.size).toBe(before.stored.size)
    const rows = (body: string) => body.split("\n").filter((line) => line.startsWith("| ")).length
    expect(rows(after.stored.get(`${TIER}/sleep-phases`)?.body ?? "")).toBe(
      rows(before.stored.get(`${TIER}/sleep-phases`)?.body ?? "") + 1
    )
    expect(after.stored.get(`${TIER}/sleep-phases`)?.body).toContain("synthetic-phase")
  })
})

describe("composition with Starlight's own loader", () => {
  /**
   * A stand-in for Astro's glob loader, whose real behavior is the hazard: it deletes every store
   * key it did not touch, so a generated entry written before it would be swept as a removed file.
   */
  const sweepingDocsLoader = (): Loader => ({
    name: "fake-glob",
    load: async (context) => {
      for (const key of context.store.keys()) context.store.delete(key)
      context.store.set({
        id: "index",
        data: { title: "Introduction" },
        filePath: "src/content/docs/index.mdx",
        body: "authored"
      })
    }
  })

  it("survives the file loader's sweep of untouched entries", async () => {
    const { context, stored } = fakeContext()
    await withReference(sweepingDocsLoader()).load(context)

    expect(stored.has("index")).toBe(true)
    expect(stored.size).toBeGreaterThan(registry.commands.length)
    expect(stored.has(TIER)).toBe(true)
  })
})
