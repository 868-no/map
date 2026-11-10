//! The views' TypeScript types (D-202): generated from the structs they are
//! serialised from, by ts-rs, into frontend/src/derive/views.gen.ts, which
//! is committed. Running the tests writes it; CI fails when the committed
//! file differs from what the structs generate.
//!
//! ts-rs reads the serde attributes, but a field serde leaves out
//! (`skip_serializing_if`) needs `optional` beside it to become `field?:`:
//! `ts(optional)` on an Option, `ts(as = "Option<_>", optional)` on any
//! other type. A string the UI narrows to its values gets them as
//! `ts(type = "'a' | 'b'")`. Integers are numbers, as serde_json writes
//! them. The ts attributes are for test builds only: the shipped wasm does
//! not depend on ts-rs.

use std::collections::BTreeMap;

use ts_rs::{Config, TS, TypeVisitor};

const OUT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/derive/views.gen.ts");

const HEADER: &str = "// Generated from the engine's view structs by ts-rs (frontend/engine/src/view_types.rs,
// D-202): run `scripts/wasm.sh test` to regenerate. Do not edit by hand.
";

/// Every type a view's output reaches, by TypeScript name, with its declaration.
struct Collect<'a> {
    cfg: &'a Config,
    decls: BTreeMap<String, String>,
}

impl TypeVisitor for Collect<'_> {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        // Primitives and std types declare nothing of their own.
        if T::output_path().is_none() {
            return;
        }
        let decl = format!("{}export {}", T::docs().unwrap_or_default(), T::decl(self.cfg));
        let name = T::ident(self.cfg);
        if let Some(seen) = self.decls.get(&name) {
            assert_eq!(seen, &decl, "two types are named {name} in TypeScript");
            return;
        }
        self.decls.insert(name, decl);
        T::visit_dependencies(self);
    }
}

/// The file's text: each type once, by name.
fn generate() -> String {
    let cfg = Config::new().with_large_int("number");
    let mut c = Collect { cfg: &cfg, decls: BTreeMap::new() };
    c.visit::<crate::views::Snapshot>();
    c.visit::<crate::views::Traffic>();
    c.visit::<crate::views::NodeDetail>();
    c.visit::<crate::packets::PacketLog>();
    c.visit::<crate::packets::PacketRoute>();
    c.visit::<crate::health::Health>();
    c.visit::<crate::reach::Reach>();
    c.visit::<crate::views::link::LinkHistory>();
    c.visit::<crate::watch::Watched>();
    c.visit::<crate::regions::RegionsView>();
    let mut out = HEADER.to_string();
    for decl in c.decls.values() {
        out.push('\n');
        // ts-rs leaves a space at the end of a line before a field's docs.
        for line in decl.lines() {
            out.push_str(line.trim_end());
            out.push('\n');
        }
    }
    out
}

#[test]
fn view_types_are_written() {
    let text = generate();
    // Written only when changed, so a dev server is not reloaded for nothing.
    if std::fs::read_to_string(OUT).ok().as_deref() != Some(text.as_str()) {
        std::fs::write(OUT, &text).expect("write views.gen.ts");
    }
}
