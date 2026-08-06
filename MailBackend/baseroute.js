const indexRoute = require("./routes/index");
const auth = require("./routes/auth");
const tenant = require("./routes/tenant");
const form = require("./routes/form");
const submission = require("./routes/submission");
const publicRoute = require("./routes/public");

module.exports = function (app) {
    app.use("/", indexRoute);
    // Public, unauthenticated. Mounted first so it is never shadowed by an
    // admin route that happens to share a prefix.
    app.use("/api", publicRoute);
    app.use("/api", auth);
    app.use("/api", tenant);
    app.use("/api", form);
    app.use("/api", submission);
};
