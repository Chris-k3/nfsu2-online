//! The online host's tests: the JS's (web/test/online-*.test.mjs) case for case, driving the single-threaded core
//! with manual clocks, and cross-checks against the JS itself (cross.rs).

mod audit;
mod cross;
mod edge;
mod load;
mod lobby;
mod session;
mod thread;
mod vhost;
mod world;
