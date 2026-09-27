import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { Tool } from "@/tool/tool"
import fs from "node:fs/promises"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { containsPath } from "../../src/project/instance-context"
import { InstanceState } from "../../src/effect/instance-state"
import { Filesystem } from "@/util/filesystem"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

function makeCtx() {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

const directoryLink = (target: string, link: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir")
      return link
    }),
    (created) => Effect.promise(() => fs.rm(created, { recursive: true, force: true })),
  )

describe("tool.assertExternalDirectory", () => {
  it.live("no-ops for empty target", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx)

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("no-ops for paths inside the instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, path.join(test.directory, "file.txt"))

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("treats symlinked workspace paths as inside the instance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const alias = yield* directoryLink(test.directory, `${test.directory}-link`)
      const { requests, ctx } = makeCtx()
      const existing = path.join(test.directory, "present.txt")
      const missing = path.join(test.directory, "planned", "file.txt")

      yield* Effect.promise(() => Bun.write(existing, "present"))
      yield* assertExternalDirectoryEffect(ctx, existing)
      yield* assertExternalDirectoryEffect(ctx, path.join(alias, "present.txt"))
      yield* assertExternalDirectoryEffect(ctx, missing)
      yield* assertExternalDirectoryEffect(ctx, path.join(alias, "planned", "file.txt"))

      expect(requests).toHaveLength(0)
      const instance = yield* InstanceState.context
      expect(
        containsPath(path.join(alias, "present.txt"), {
          ...instance,
          directory: path.join(test.directory, "nested"),
          worktree: test.directory,
        }),
      ).toBe(true)
    }),
  )

  it.instance("keeps true external paths external through workspace links", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const external = yield* tmpdirScoped()
      const alias = yield* directoryLink(external, path.join(test.directory, "external-link"))
      const target = path.join(external, "secret.txt")
      const { requests, ctx } = makeCtx()

      yield* Effect.promise(() => Bun.write(target, "secret"))
      yield* assertExternalDirectoryEffect(ctx, target)
      yield* assertExternalDirectoryEffect(ctx, path.join(alias, "secret.txt"))

      const expected = glob(path.join(external, "*"))
      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.patterns)).toEqual([[expected], [expected]])
      expect(requests.map((request) => request.metadata)).toEqual([
        { filepath: target, parentDir: external },
        { filepath: target, parentDir: external },
      ])
    }),
  )

  it.instance("asks with a single canonical glob", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside", "file.txt")
      const expected = glob(path.join(path.dirname(target), "*"))

      yield* assertExternalDirectoryEffect(ctx, target)

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.instance("uses target directory when kind=directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside")
      const expected = glob(path.join(target, "*"))

      yield* assertExternalDirectoryEffect(ctx, target, { kind: "directory" })

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.live("skips prompting when bypass=true", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, "/tmp/outside/file.txt", { bypass: true })

      expect(requests.length).toBe(0)
    }),
  )

  if (process.platform === "win32") {
    it.instance(
      "normalizes Windows path variants to one glob",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const outerTmp = yield* tmpdirScoped()
          yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))

          const target = path.join(outerTmp, "outside.txt")
          const root = path.parse(target).root
          const alt = `/${root[0].toLowerCase()}/${target.slice(root.length).replaceAll("\\", "/").toLowerCase()}`

          yield* assertExternalDirectoryEffect(ctx, alt)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(path.dirname(FSUtil.canonicalPath(target)), "*"))
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )

    it.instance(
      "uses drive root glob for root files",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const tmp = yield* TestInstance
          const root = path.parse(tmp.directory).root
          const target = path.join(root, "boot.ini")

          yield* assertExternalDirectoryEffect(ctx, target)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = path.join(root, "*")
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )
  }
})
