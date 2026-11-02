import { describe, expect, it } from 'vitest'
// The engine's golden output (frontend/engine/tests/golden.rs): real views.
import golden from '../engine/tests/fixtures/mesh-12h/engine.json'
import type { NodeView, PacketLog, PacketRoute, SnapshotView, TrafficView } from '../src/derive/views'

// derive/views.ts mirrors the engine's Rust view structs by hand. This file
// is type-checked (npm run typecheck): every view in the golden fixture must
// fit the TypeScript types, so a field the engine renamed, dropped or
// retyped fails the build. JSON imports type strings as plain strings, so
// string unions are widened to string for the check; the meta block is the
// worker's own and absent from the engine's output.
// Index signatures allow undefined: JSON arrays of objects infer missing keys as `?: undefined`.
type Loose<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? Loose<U>[]
    : T extends object
      ? string extends keyof T
        ? { [k: string]: Loose<T[string & keyof T]> | undefined }
        : { [K in keyof T]: Loose<T[K]> }
      : T
type Body<T> = Loose<Omit<T, 'meta'>>

const snapshot: Body<SnapshotView> = golden.snapshot
const snapshot2: Body<SnapshotView> = golden.snapshot_position_nodeinfo
const traffic: Body<TrafficView> = golden.traffic
const nodes: Record<string, Body<NodeView>> = golden.nodes
const packetlogs: Record<string, Body<PacketLog>> = golden.packetlogs
const routes: Record<string, Body<PacketRoute>> = golden.routes

describe('engine view types', () => {
  it('the golden fixture covers every checked view', () => {
    expect(snapshot.nodes.length).toBeGreaterThan(0)
    expect(snapshot2.nodes.length).toBeGreaterThan(0)
    expect(traffic.buckets.length).toBeGreaterThan(0)
    for (const m of [nodes, packetlogs, routes]) expect(Object.keys(m).length).toBeGreaterThan(0)
  })
})
