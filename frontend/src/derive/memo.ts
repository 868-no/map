// The worker's memo of built views (UTF-8 JSON bytes), kept apart from the
// worker so tests need no WebAssembly. Entries are keyed by data revision,
// kind, window and filters. A snapshot at reference density is several MB
// and every live rebuild is a new revision, so entries of older revisions
// are dropped and the total is capped.

export class ViewMemo {
  private entries = new Map<string, { revision: string; kind: string; body: Uint8Array }>()
  private bytes = 0

  constructor(private maxBytes: number) {}

  /** The view for key, built by make unless held; entries of other revisions go. */
  remember(key: string, revision: string, kind: string, make: () => Uint8Array): Uint8Array {
    const hit = this.entries.get(key)
    if (hit !== undefined) return hit.body
    const body = make()
    for (const [k, x] of this.entries) {
      if (x.revision !== revision || this.bytes + body.length > this.maxBytes) this.drop(k)
    }
    this.entries.set(key, { revision, kind, body })
    this.bytes += body.length
    return body
  }

  /**
   * Drops the views of one kind, so they are built again. The kind is kept
   * beside each entry, not parsed from its key: keys embed filter names
   * strangers chose, which may hold any separator.
   */
  forget(kind: string) {
    for (const [k, x] of this.entries) if (x.kind === kind) this.drop(k)
  }

  clear() {
    this.entries.clear()
    this.bytes = 0
  }

  get size() {
    return this.entries.size
  }

  private drop(k: string) {
    const x = this.entries.get(k)
    if (!x) return
    this.entries.delete(k)
    this.bytes -= x.body.length
  }
}
