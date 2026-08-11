import { describe, expect, it } from "vitest"

import {
  COMMIT_SUBJECT_MAX,
  commitSubject,
  parseCatFileBatch,
  parseDiffNameStatus,
  parseLsTree,
  parseStatusPorcelainV2,
  parseTrailerLog,
  provenanceTrailers,
  TRAILER_FIELD_CHAR
} from "../src/plumbing.js"

/**
 * The `-z` formats, pinned against bytes captured from the git binary on 2026-08-02. These are
 * the assertions the integration tier cannot make: an integration test proves the command works
 * today, and these prove the parser survives a truncated, empty, or malformed stream — which is
 * exactly what a killed subprocess's half-written pipe looks like.
 */

/** Build a NUL-joined stream the way git does: every field terminated, not separated. */
const nulTerminated = (...fields: ReadonlyArray<string>): string =>
  fields.map((field) => `${field}\0`).join("")

describe("parseLsTree", () => {
  it("reads mode, type, sha, and path off a tab-delimited row", () => {
    const output = nulTerminated(
      "100644 blob 45b983be36b73c0788dc9cbcb76cbb80fc7bb057\tareas/oncall/a.html",
      "100644 blob e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\tprojects/x/b.html"
    )
    expect(parseLsTree(output)).toEqual([
      {
        mode: "100644",
        objectType: "blob",
        sha: "45b983be36b73c0788dc9cbcb76cbb80fc7bb057",
        path: "areas/oncall/a.html"
      },
      {
        mode: "100644",
        objectType: "blob",
        sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
        path: "projects/x/b.html"
      }
    ])
  })

  it("keeps a path containing a space and a path containing a newline intact", () => {
    // The tab is what makes a space-bearing path parseable; -z is what makes a newline-bearing
    // one parseable. Both are legal on every filesystem git runs on.
    const output = nulTerminated(
      "100644 blob aaaa\tareas/on call/a b.html",
      "100644 blob bbbb\tareas/x/we\nird.html"
    )
    expect(parseLsTree(output).map((entry) => entry.path)).toEqual([
      "areas/on call/a b.html",
      "areas/x/we\nird.html"
    ])
  })

  it("is empty for an empty tree and drops a row with no tab", () => {
    expect(parseLsTree("")).toEqual([])
    expect(parseLsTree("100644 blob aaaa areas/x.html\0")).toEqual([])
  })
})

describe("parseDiffNameStatus", () => {
  it("reads a mixed diff where the rename costs three fields, not two", () => {
    // Captured verbatim from `git diff --name-status -M -z` on 2026-08-02. A parser that read
    // fields pairwise would attribute `b/one-renamed.html` to a nonexistent next change.
    const output = nulTerminated(
      "D",
      "a/three.html",
      "M",
      "a/two.html",
      "A",
      "b/new.html",
      "R100",
      "a/one.html",
      "b/one-renamed.html"
    )
    expect(parseDiffNameStatus(output)).toEqual([
      { kind: "deleted", path: "a/three.html", fromPath: null, similarity: null },
      { kind: "modified", path: "a/two.html", fromPath: null, similarity: null },
      { kind: "added", path: "b/new.html", fromPath: null, similarity: null },
      {
        kind: "renamed",
        path: "b/one-renamed.html",
        fromPath: "a/one.html",
        similarity: 100
      }
    ])
  })

  it("carries a below-100 rename score rather than rounding it to a rename-or-not flag", () => {
    // An archive that also stamps its head in the same commit scores below 100 (measured 59-87
    // on real memory files). The score is data so a caller can report it; no code gates on 100.
    const output = nulTerminated("R059", "areas/x/m.html", "archive/2026/areas/x/m.html")
    expect(parseDiffNameStatus(output)[0]).toEqual({
      kind: "renamed",
      path: "archive/2026/areas/x/m.html",
      fromPath: "areas/x/m.html",
      similarity: 59
    })
  })

  it("reads a copy as its own kind with both paths", () => {
    const output = nulTerminated("C085", "areas/x/a.html", "areas/y/a.html")
    expect(parseDiffNameStatus(output)[0]?.kind).toBe("copied")
    expect(parseDiffNameStatus(output)[0]?.fromPath).toBe("areas/x/a.html")
  })

  it("does not read a rename's destination as the next change's status letter", () => {
    // The field arithmetic made observable. A rename costs THREE fields; consuming two leaves
    // the destination path to be read as a status, and a status letter is a single UPPERCASE
    // char — so any path starting with A/M/D/R/C/T becomes a phantom change whose "path" is the
    // real next status. `README.html` is committed at the repo root by `memhtml init`, so this is
    // the ordinary case rather than a contrived one.
    const output = nulTerminated("R100", "README.html", "Docs.html", "M", "areas/x/two.html")
    expect(parseDiffNameStatus(output)).toEqual([
      {
        kind: "renamed",
        path: "Docs.html",
        fromPath: "README.html",
        similarity: 100
      },
      { kind: "modified", path: "areas/x/two.html", fromPath: null, similarity: null }
    ])
  })

  it("stops cleanly on a stream truncated mid-rename instead of inventing a path", () => {
    const output = nulTerminated("A", "a.html", "R100", "b.html")
    expect(parseDiffNameStatus(output)).toEqual([
      { kind: "added", path: "a.html", fromPath: null, similarity: null }
    ])
  })

  it("is empty for no changes and skips an unknown status letter", () => {
    expect(parseDiffNameStatus("")).toEqual([])
    expect(parseDiffNameStatus(nulTerminated("X", "a.html"))).toEqual([])
  })
})

describe("parseStatusPorcelainV2", () => {
  it("reads a worktree modification with both HEAD and index shas", () => {
    const output = nulTerminated(
      "1 .M N... 100644 100644 100644 23aa521dbeaf130f206e2d0c728ae3f64ca51341 23aa521dbeaf130f206e2d0c728ae3f64ca51341 a/two.html"
    )
    expect(parseStatusPorcelainV2(output)).toEqual([
      {
        kind: "changed",
        path: "a/two.html",
        fromPath: null,
        xy: ".M",
        headSha: "23aa521dbeaf130f206e2d0c728ae3f64ca51341",
        indexSha: "23aa521dbeaf130f206e2d0c728ae3f64ca51341",
        oursSha: null,
        theirsSha: null
      }
    ])
  })

  it("consumes a rename's original path from the NEXT NUL field", () => {
    // The trap this format sets: a `2 ` record spans two NUL fields. A parser that read one
    // field per record would report the original path as its own untracked entry, and every
    // subsequent record would be misaligned.
    const output = nulTerminated(
      "1 .M N... 100644 100644 100644 23aa521d 23aa521d a/two.html",
      "2 R. N... 100644 100644 100644 5626abf0 5626abf0 R100 b/one-again.html",
      "b/one-renamed.html",
      "? untr.html"
    )
    expect(parseStatusPorcelainV2(output)).toEqual([
      {
        kind: "changed",
        path: "a/two.html",
        fromPath: null,
        xy: ".M",
        headSha: "23aa521d",
        indexSha: "23aa521d",
        oursSha: null,
        theirsSha: null
      },
      {
        kind: "renamed",
        path: "b/one-again.html",
        fromPath: "b/one-renamed.html",
        xy: "R.",
        headSha: "5626abf0",
        indexSha: "5626abf0",
        oursSha: null,
        theirsSha: null
      },
      {
        kind: "untracked",
        path: "untr.html",
        fromPath: null,
        xy: "",
        headSha: null,
        indexSha: null,
        oursSha: null,
        theirsSha: null
      }
    ])
  })

  it("reads an unmerged record's ours and theirs stage shas into their OWN fields", () => {
    const output = nulTerminated(
      "u UU N... 100644 100644 100644 100644 13ceda207b642cbb fa24d1bf8d89719b 8f0701469ff5d450 areas/x/f.html"
    )
    expect(parseStatusPorcelainV2(output)).toEqual([
      {
        kind: "unmerged",
        path: "areas/x/f.html",
        fromPath: null,
        xy: "UU",
        // A merge stage is NOT a HEAD/index pair. Reusing headSha for "our stage-2 blob" would
        // let a caller read a conflict's stage sha as the committed content and believe it.
        headSha: null,
        indexSha: null,
        oursSha: "fa24d1bf8d89719b",
        theirsSha: "8f0701469ff5d450"
      }
    ])
  })

  it("reads an all-zero sha as no object rather than as a sha", () => {
    const output = nulTerminated(
      "1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 abc123 areas/x/new.html"
    )
    expect(parseStatusPorcelainV2(output)[0]?.headSha).toBeNull()
    expect(parseStatusPorcelainV2(output)[0]?.indexSha).toBe("abc123")
  })

  it("keeps a path containing spaces whole", () => {
    const output = nulTerminated("1 .M N... 100644 100644 100644 aaa bbb areas/on call/a b c.html")
    expect(parseStatusPorcelainV2(output)[0]?.path).toBe("areas/on call/a b c.html")
  })

  it("does not re-read a rename's original path as its own record", () => {
    // The consumed field made observable. A filename may legally begin with `? `, and without
    // consuming the rename's second field that path would be re-read as its own marker — so an
    // archived memory's ORIGINAL path would surface as an untracked file, and `requireCleanTree`
    // would refuse a tree that is in fact clean.
    const output = nulTerminated(
      "2 R. N... 100644 100644 100644 5626abf0 5626abf0 R100 archive/2026/areas/x/? decoy.html",
      "? decoy.html",
      "1 .M N... 100644 100644 100644 aaa bbb areas/x/real.html"
    )
    expect(parseStatusPorcelainV2(output).map((entry) => [entry.kind, entry.path])).toEqual([
      ["renamed", "archive/2026/areas/x/? decoy.html"],
      ["changed", "areas/x/real.html"]
    ])
  })

  it("distinguishes ignored from untracked", () => {
    const output = nulTerminated("? untr.html", "! .memhtml/index.db")
    expect(parseStatusPorcelainV2(output).map((entry) => entry.kind)).toEqual([
      "untracked",
      "ignored"
    ])
  })

  it("is empty on a clean tree and drops a record with too few fields", () => {
    expect(parseStatusPorcelainV2("")).toEqual([])
    expect(parseStatusPorcelainV2(nulTerminated("1 .M N... 100644"))).toEqual([])
  })
})

describe("parseCatFileBatch", () => {
  /** The exact framing git writes: `<sha> <type> <size>\n<size bytes>\n`. */
  const framed = (entries: ReadonlyArray<readonly [string, string]>): Uint8Array =>
    Buffer.concat(
      entries.map(([sha, body]) =>
        Buffer.concat([
          Buffer.from(`${sha} blob ${Buffer.byteLength(body)}\n`, "utf8"),
          Buffer.from(body, "utf8"),
          Buffer.from("\n", "utf8")
        ])
      )
    )

  it("reads every blob body out of one stream", () => {
    const blobs = parseCatFileBatch(
      framed([
        ["aaa", "one"],
        ["bbb", "two"]
      ])
    )
    expect([...blobs.keys()]).toEqual(["aaa", "bbb"])
    expect(Buffer.from(blobs.get("aaa") ?? new Uint8Array()).toString("utf8")).toBe("one")
  })

  it("frames by BYTE length, so a multibyte body does not shift the next header", () => {
    // A memory file carries em dashes. Applying a byte length to string indices would put the
    // next header's offset one byte early per multibyte char, and every later blob would be
    // garbage — silently, because the shas would still parse.
    const blobs = parseCatFileBatch(
      framed([
        ["aaa", "a — dash and an emoji 🜛 in the body"],
        ["bbb", "the next blob, intact"]
      ])
    )
    expect(Buffer.from(blobs.get("aaa") ?? new Uint8Array()).toString("utf8")).toBe(
      "a — dash and an emoji 🜛 in the body"
    )
    expect(Buffer.from(blobs.get("bbb") ?? new Uint8Array()).toString("utf8")).toBe(
      "the next blob, intact"
    )
  })

  it("skips a missing object and keeps reading the ones that follow", () => {
    // `cat-file --batch` answers `<sha> missing` and exits 0, probed live. A missing object is
    // a gap in the map, never a failure: the indexer asks for shas it read from a diff.
    const stream = Buffer.concat([
      Buffer.from("deadbeef missing\n", "utf8"),
      framed([["aaa", "still here"]])
    ])
    const blobs = parseCatFileBatch(stream)
    expect(blobs.has("deadbeef")).toBe(false)
    expect(Buffer.from(blobs.get("aaa") ?? new Uint8Array()).toString("utf8")).toBe("still here")
  })

  it("reads a zero-length blob as an empty body rather than as absent", () => {
    const blobs = parseCatFileBatch(framed([["e69de29", ""]]))
    expect(blobs.has("e69de29")).toBe(true)
    expect(blobs.get("e69de29")?.length).toBe(0)
  })

  it("is empty for an empty stream and stops on a truncated header", () => {
    expect(parseCatFileBatch(new Uint8Array())).toEqual(new Map())
    expect(parseCatFileBatch(Buffer.from("aaa blob 12", "utf8"))).toEqual(new Map())
  })

  it("stops on a non-numeric size instead of looping", () => {
    expect(parseCatFileBatch(Buffer.from("aaa blob notanumber\nbody\n", "utf8"))).toEqual(new Map())
  })
})

describe("parseTrailerLog", () => {
  const record = (sha: string, ...values: ReadonlyArray<string>): string =>
    `\0${sha}${values.map((value) => `${TRAILER_FIELD_CHAR}${value}`).join("")}\n`

  it("pairs each commit with the trailer values it carries", () => {
    const output = [record("aaa", "integrity"), record("bbb", "dedup-merge"), record("ccc")].join(
      ""
    )
    expect(parseTrailerLog(output)).toEqual([
      { sha: "aaa", values: ["integrity"] },
      { sha: "bbb", values: ["dedup-merge"] },
      { sha: "ccc", values: [] }
    ])
  })

  it("reads a value containing commas as one value", () => {
    // `Memhtml-Counts` is JSON. A comma-separated field split would shred it into fragments.
    const counts = '{"candidates":31,"merged":7,"vetoed":4}'
    expect(parseTrailerLog(record("aaa", counts))).toEqual([{ sha: "aaa", values: [counts] }])
  })

  it("reads several values of one repeated key", () => {
    expect(parseTrailerLog(record("aaa", "one", "two"))).toEqual([
      { sha: "aaa", values: ["one", "two"] }
    ])
  })

  it("is empty for a range with no commits", () => {
    expect(parseTrailerLog("")).toEqual([])
    expect(parseTrailerLog("\0\n")).toEqual([])
  })
})

describe("commitSubject", () => {
  it("builds the memhtml(<op>): <subject> form", () => {
    expect(commitSubject("write", "Prod rollbacks drain the VIP")).toBe(
      "memhtml(write): Prod rollbacks drain the VIP"
    )
  })

  it("collapses a newline out of a title", () => {
    // A newline in `git commit -m` becomes a commit BODY, silently moving the title out of
    // `git log --oneline` — and a memory title is agent-supplied text.
    expect(commitSubject("write", "line one\nline two")).toBe("memhtml(write): line one line two")
  })

  it("caps a long subject with an ellipsis rather than wrapping", () => {
    const subject = commitSubject("write", "x".repeat(200))
    expect(subject.length).toBeLessThanOrEqual(`memhtml(write): `.length + COMMIT_SUBJECT_MAX)
    expect(subject.endsWith("…")).toBe(true)
  })

  it("names an empty title rather than emitting a bare scope", () => {
    expect(commitSubject("write", "   ")).toBe("memhtml(write): (untitled)")
  })
})

describe("provenanceTrailers", () => {
  it("emits only the keys the write actually carries", () => {
    expect(provenanceTrailers({ sessionId: "s1", promptId: "p1" })).toEqual({
      "Memhtml-Session": "s1",
      "Memhtml-Prompt": "p1"
    })
    expect(provenanceTrailers({ sessionId: "s1" })).toEqual({ "Memhtml-Session": "s1" })
    expect(provenanceTrailers({})).toEqual({})
  })

  it("treats an empty string as absent, so no empty trailer reaches a commit", () => {
    expect(provenanceTrailers({ sessionId: "", promptId: "" })).toEqual({})
  })
})
