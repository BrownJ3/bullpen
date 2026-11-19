// Start: route to the right page and connect.
// Plain scripts sharing one global scope, loaded in order by index.html (no build step).

// ---------- start ----------
const routed = location.hash.match(/^#\/t\/([\w-]+)/);
if (routed) state.threadId = routed[1];

if (location.hash === "#/teams") state.view = "teams";
if (location.hash === "#/artifacts") state.view = "artifacts";
if (location.hash.startsWith("#/a/")) { state.view = "artifact"; state.artifactId = location.hash.slice(4); }
renderMain();
connect();
