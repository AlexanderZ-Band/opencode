// Subprocess integration tests for `opencode serve`. Spawns the real CLI in
// headless mode and exercises it over HTTP — this is the only test tier that
// catches bugs spanning argv → server boot → routing → instance loading.
//
// `serve` is long-lived: the harness returns a handle (url/port/kill/exited)
// and kills the process when the test scope closes. The OS-assigned port is
// parsed off the "listening on http://..." line.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

describe("opencode serve (subprocess)", () => {
  // Smoke test: server starts, binds a port, and /global/health responds.
  // If this fails, all other serve tests likely will too — debug here first.
  cliIt.live(
    "starts, binds a port, and serves /global/health",
    ({ opencode }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve()
        expect(server.port).toBeGreaterThan(0)
        expect(server.url).toMatch(/^http:\/\//)

        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${server.url}/global/health`)
        expect(res.status).toBe(200)
        // GlobalHealth schema is { success: true, ... } | { success: false, error }.
        // We don't lock in further shape here — any 200 with parseable JSON is
        // enough proof the routing + auth-bypass + instance loading is alive.
        const body = yield* res.json
        expect(body).toBeDefined()
      }),
    60_000,
  )

  // The scope-close finalizer must actually terminate the child. Without this
  // test a regression in the kill path (e.g. a future refactor that forgets
  // to wire the finalizer) would leak processes on every test run.
  cliIt.live(
    "kills the subprocess on scope close",
    ({ opencode }) =>
      Effect.gen(function* () {
        // Inner scope so we can observe `.exited` resolving after it closes.
        const exitedPromise = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* opencode.serve()
            // Capture the Promise, not the resolved value — scope closes after
            // this gen returns, at which point the finalizer kills the child.
            return server.exited
          }),
        )
        // After scope close: finalizer fired, process must have exited.
        const code = yield* Effect.promise(() => exitedPromise)
        // Bun reports the exit code; SIGTERM-killed processes return non-null
        // (typically 143 on POSIX). We just require resolution within a sane
        // window — anything else means the kill didn't take.
        expect(typeof code === "number" || code === null).toBe(true)
      }),
    60_000,
  )

  cliIt.live(
    "keeps symlinked workdirs inside while prompting for true external paths",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const workspace = path.join(home, "workspace")
        const alias = path.join(home, "workspace-link")
        const external = path.join(home, "external")
        const inside = path.join(alias, "inside.txt")
        const outside = path.join(external, "secret.txt")

        yield* Effect.promise(async () => {
          await fs.mkdir(workspace)
          await fs.mkdir(external)
          await Bun.write(path.join(workspace, "inside.txt"), "inside")
          await Bun.write(outside, "secret")
          await fs.symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir")
        })

        const server = yield* opencode.serve({
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              permission: { read: "allow", external_directory: "ask" },
            }),
          },
        })
        const remote = ["--attach", server.url, "--dir", alias, "--"]

        yield* llm.tool("read", { filePath: inside })
        yield* llm.text("read inside workspace")
        const insideResult = yield* opencode.run("read the workspace file", { extraArgs: remote })

        opencode.expectExit(insideResult, 0)
        expect(insideResult.stderr).not.toContain("permission requested: external_directory")
        expect(yield* llm.calls).toBeGreaterThanOrEqual(2)

        yield* llm.reset
        yield* llm.tool("read", { filePath: outside })
        yield* llm.text("external request rejected")
        const outsideResult = yield* opencode.run("read the external file", { extraArgs: remote })

        opencode.expectExit(outsideResult, 0)
        expect(outsideResult.stderr).toContain("permission requested: external_directory")
      }),
    60_000,
  )
})
