#!/usr/bin/env node
import { NodeRuntime, NodeStdio } from "@effect/platform-node"
import { Layer } from "effect"

import { layerServer } from "./server.js"

/**
 * The stdio entry point. stdout belongs to the MCP framing from here on: every log in the graph is
 * already routed to stderr by `layerServer`, and nothing in this file writes.
 *
 * `Layer.launch` runs the server for the process's lifetime rather than building the layer and
 * returning — the transport IS the program, and a built-then-released layer would close stdin out
 * from under the client mid-session.
 */
Layer.launch(layerServer().pipe(Layer.provide(NodeStdio.layer))).pipe(NodeRuntime.runMain)
