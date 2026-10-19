import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { askHeadFor } from "../src/head-client.js"
import {
  headEndpoint,
  headPipeName,
  headSocketPath,
  socketPathMax,
  socketPathTooLong
} from "../src/head-protocol.js"

/**
 * The client half of the head server (`head-client.ts`) against listeners that misbehave on
 * purpose, and the endpoint each platform derives (`head-protocol.ts`).
 *
 * The rule under test is the phase rule: an ask that ends before its connection completed is
 * `no-server` whatever the errno, because no byte of the request reached a server; one that ends
 * after it is `lost`, because the server may have read the request. Every listener here is a real
 * Unix socket; the errno each case reaches is the one the kernel gives for that shape on Linux.
 *
 * Mutations, each run once with the change applied and the named case red:
 * - `head-client.ts` `askHeadFor`: read the connect phase by errno again (`no-server` only for
 *   `ENOENT`, `ECONNREFUSED`, and the connect timeout) -> "is no-server when the connect fails with
 *   any errno" (`ENOTDIR` and `EACCES` answer `lost`).
 * - `head-client.ts` `socketAgent`: never set `dialed.connected` -> "is lost, not no-server, when the
 *   listener hangs up after the connect" (every case answers `no-server`).
 * - `head-client.ts` `askHeadFor`: drop the `socketPathTooLong` check -> "never dials a socket path
 *   past the platform's limit" (`detail` is `EINVAL`).
 * - `head-protocol.ts` `socketPathTooLong`: count `path.length` instead of UTF-8 bytes -> "counts
 *   bytes, not characters".
 */

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const dirs: Array<string> = []
const servers: Array<Server> = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "memhtml-head-client-"))
  dirs.push(dir)
  return dir
}

/** A store root whose `.memhtml/head.sock` is exactly `bytes` long. */
const rootWithSocketOf = async (bytes: number): Promise<string> => {
  const base = await scratch()
  const suffix = "/.memhtml/head.sock"
  const pad = bytes - base.length - 1 - suffix.length
  if (pad < 1) throw new Error(`a ${String(bytes)}-byte socket path does not fit under ${base}`)
  const root = join(base, "d".repeat(pad))
  await mkdir(root, { recursive: true })
  expect(Buffer.byteLength(headSocketPath(root))).toBe(bytes)
  return root
}

/** A listener on `root`'s socket that does `onConnection` with every connection. */
const listen = async (root: string, onConnection: (socket: Socket) => void): Promise<string> => {
  const socket = headSocketPath(root)
  await mkdir(join(root, ".memhtml"), { recursive: true })
  const server = createServer(onConnection)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  return socket
}

const Anything = Schema.Unknown

const ask = (root: string, route: "status" | "exec" = "status") =>
  run(
    askHeadFor({
      root,
      route,
      schema: Anything,
      ...(route === "exec" ? { body: { id: "s1", script: "true", lang: "bash" } } : {})
    })
  )

describe("the connect phase", () => {
  it("is no-server with no socket file, and with nothing listening at the path", async () => {
    const root = await scratch()
    expect(await ask(root)).toEqual({ kind: "no-server", detail: "ENOENT" })
    // Nothing that accepts at the path (here a directory): the connect is refused.
    await mkdir(headSocketPath(root), { recursive: true })
    expect(await ask(root, "exec")).toEqual({ kind: "no-server", detail: "ECONNREFUSED" })
  })

  it("is no-server when the connect fails with any errno", async () => {
    // `.memhtml` is a regular file, so the connect fails with ENOTDIR before it reaches anything.
    const notDir = await scratch()
    await writeFile(join(notDir, ".memhtml"), "not a directory")
    expect(await ask(notDir)).toEqual({ kind: "no-server", detail: "ENOTDIR" })
    expect(await ask(notDir, "exec")).toEqual({ kind: "no-server", detail: "ENOTDIR" })

    // A live listener whose socket file this user may not write: the connect fails with EACCES.
    // Root bypasses the mode, so the case says nothing there.
    if (process.getuid?.() !== 0) {
      const locked = await scratch()
      let accepted = 0
      const socket = await listen(locked, (connection) => {
        accepted += 1
        connection.destroy()
      })
      await chmod(socket, 0o000)
      expect(await ask(locked, "exec")).toEqual({ kind: "no-server", detail: "EACCES" })
      expect(accepted).toBe(0)
    }
  })

  it("never dials a socket path past the platform's limit", async () => {
    const max = socketPathMax()
    if (max === null) return
    // 127 bytes: past Linux's 107 and the 108 a NUL-less path could take, so the kernel refuses
    // the connect with EINVAL if it is ever made.
    const root = await rootWithSocketOf(127)
    for (const route of ["status", "exec"] as const) {
      expect(await ask(root, route)).toEqual({
        kind: "no-server",
        detail: `socket path is 127 bytes, past the ${String(max)} this platform allows`
      })
    }
  })

  it("dials a socket path at the limit", async () => {
    const max = socketPathMax()
    if (max === null) return
    const root = await rootWithSocketOf(max)
    await listen(root, (connection) => {
      connection.once("data", () =>
        connection.end(
          "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}"
        )
      )
    })
    expect(await ask(root)).toMatchObject({ kind: "answered", data: {} })
  })
})

describe("after the connect", () => {
  it("is lost, not no-server, when the listener hangs up after the connect", async () => {
    // Hangs up once the request arrived: a server that died mid-request.
    const afterRead = await scratch()
    await listen(afterRead, (connection) => {
      connection.once("data", () => connection.destroy())
    })
    expect((await ask(afterRead, "exec")).kind).toBe("lost")

    // Hangs up on accept, before reading: the request may already sit in its buffer, so the
    // client cannot know it was not read.
    const onAccept = await scratch()
    await listen(onAccept, (connection) => connection.destroy())
    expect((await ask(onAccept, "exec")).kind).toBe("lost")

    // Answers bytes that are not HTTP.
    const garbage = await scratch()
    await listen(garbage, (connection) => {
      connection.once("data", () => connection.end("not http at all\r\n\r\n"))
    })
    expect((await ask(garbage, "exec")).kind).toBe("lost")
  })

  it("is refused when a server answers another status", async () => {
    const root = await scratch()
    const body = JSON.stringify({ apiVersion: "1", error: "no", code: "ERR_UNKNOWN_COMMAND" })
    await listen(root, (connection) => {
      connection.once("data", () =>
        connection.end(
          `HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`
        )
      )
    })
    expect(await ask(root, "exec")).toEqual({ kind: "refused", status: 404, body })
  })
})

describe("the endpoint each platform derives", () => {
  it("is .memhtml/head.sock inside the store on POSIX platforms", () => {
    for (const platform of ["linux", "darwin", "freebsd"] as const) {
      expect(headEndpoint("/srv/stores/alpha", platform)).toEqual({
        path: "/srv/stores/alpha/.memhtml/head.sock",
        kind: "socket"
      })
    }
  })

  it("is a named pipe from the SHA-256 of the resolved store path under win32", () => {
    // The expected digests were computed outside this code: `printf '%s' 'C:\stores\alpha' | sha256sum`.
    expect(headPipeName("C:\\stores\\alpha")).toBe("\\\\.\\pipe\\memhtml-f361d9e424335352")
    expect(headEndpoint("C:\\stores\\alpha", "win32")).toEqual({
      path: "\\\\.\\pipe\\memhtml-f361d9e424335352",
      kind: "pipe"
    })
    expect(headSocketPath("D:\\stores\\beta", "win32")).toBe(
      "\\\\.\\pipe\\memhtml-2eca2654168d400d"
    )
    // Spellings that resolve to the same store derive the same pipe; client and server agree.
    for (const spelling of [
      "C:/stores/alpha",
      "C:\\stores\\alpha\\",
      "C:\\stores\\beta\\..\\alpha",
      "C:\\stores\\.\\alpha"
    ]) {
      expect(headPipeName(spelling), spelling).toBe("\\\\.\\pipe\\memhtml-f361d9e424335352")
    }
  })

  it("has no length limit for a pipe, however deep the store", () => {
    const deep = `C:\\${"nested\\".repeat(40)}store`
    const endpoint = headEndpoint(deep, "win32")
    expect(endpoint.path).toHaveLength("\\\\.\\pipe\\memhtml-".length + 16)
    expect(socketPathTooLong(endpoint, "win32")).toBeNull()
    expect(socketPathMax("win32")).toBeNull()
  })
})

describe("the socket path limit", () => {
  it("is sun_path less its NUL: 107 bytes on Linux, 103 on macOS and the BSDs", () => {
    expect(socketPathMax("linux")).toBe(107)
    expect(socketPathMax("android")).toBe(107)
    expect(socketPathMax("darwin")).toBe(103)
    expect(socketPathMax("freebsd")).toBe(103)
    expect(socketPathMax("openbsd")).toBe(103)
  })

  it("is judged per platform", () => {
    const at = (bytes: number) => ({ path: `/${"s".repeat(bytes - 1)}`, kind: "socket" as const })
    expect(socketPathTooLong(at(107), "linux")).toBeNull()
    expect(socketPathTooLong(at(108), "linux")).toEqual({ bytes: 108, max: 107 })
    expect(socketPathTooLong(at(103), "darwin")).toBeNull()
    expect(socketPathTooLong(at(104), "darwin")).toEqual({ bytes: 104, max: 103 })
  })

  it("counts bytes, not characters", () => {
    // 100 characters, 110 bytes: each "é" is two bytes in UTF-8.
    const path = `/${"é".repeat(10)}${"s".repeat(89)}`
    expect(path).toHaveLength(100)
    expect(Buffer.byteLength(path)).toBe(110)
    expect(socketPathTooLong({ path, kind: "socket" }, "linux")).toEqual({ bytes: 110, max: 107 })
  })
})
