//! Device roles as nodes report them (Meshtastic's role names, from
//! NodeInfo and map reports), and the sets of them the rules go by. Each set
//! is named for what it means to a rule; some have the same members today
//! (fixed and zero-cost), but they answer different questions, so a change
//! to one need not change the other.

/// Roles whose job is to relay for others: routers, which rebroadcast
/// everything they hear (reliability, the router review and link drop in
/// health, the signal-to-distance model).
pub fn is_router(role: &str) -> bool {
    matches!(role, "ROUTER" | "ROUTER_LATE")
}

/// Roles that keep the mesh together, so their silence is worth a warning
/// (health).
pub fn is_infra(role: &str) -> bool {
    matches!(role, "ROUTER" | "ROUTER_LATE" | "ROUTER_CLIENT" | "REPEATER")
}

/// Roles that may relay without spending a hop (Meshtastic's
/// favourite-router "0-cost" rule).
pub fn is_zero_cost(role: &str) -> bool {
    matches!(role, "ROUTER" | "ROUTER_LATE" | "CLIENT_BASE")
}

/// Roles that sit in one place: routers and base stations.
pub fn is_fixed(role: &str) -> bool {
    matches!(role, "ROUTER" | "ROUTER_LATE" | "CLIENT_BASE")
}

/// Roles that never rebroadcast: a relay byte can never mean them.
pub fn is_silent(role: &str) -> bool {
    role == "CLIENT_MUTE"
}

/// A base station's role (the Regions panel counts them).
pub fn is_base(role: &str) -> bool {
    role == "CLIENT_BASE"
}
