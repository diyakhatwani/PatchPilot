
const express = require("express");

const app = express();
const PORT = 4000;

app.use(express.json());

const system = {
    currentVersion: "1.0.0",
    stableVersion: "1.0.0",
    status: "Healthy",
    incidents: [],
    lastRecovery: "No recovery performed yet"
};

function logIncident(details) {
    system.incidents.unshift({
        time: new Date().toISOString(),
        ...details
    });
}

// Home page
app.get("/", (req, res) => {
    res.send(`
        <h1>PatchPilot</h1>
        <p>Self-Healing Software Controller</p>
        <p>Current Version: ${system.currentVersion}</p>
        <p>System Status: ${system.status}</p>
        <p>Stable Version: ${system.stableVersion}</p>
        <p><a href="/api/health">Check Health</a></p>
        <p><a href="/api/system">View System Status</a></p>
        <p><a href="/api/incidents">View Incidents</a></p>
        <form action="/api/test-version-failure" method="post">
            <button type="submit">Test Faulty Version + Auto-Recovery</button>
        </form>
    `);
});

// PatchPilot controller health
app.get("/api/health", (req, res) => {
    res.json({
        controller: "PatchPilot",
        status: "Healthy",
        time: new Date().toISOString()
    });
});

// Current system information
app.get("/api/system", (req, res) => {
    res.json(system);
});

// Incident history
app.get("/api/incidents", (req, res) => {
    res.json(system.incidents);
});

// Controlled prototype test:
// simulate a faulty release, detect it, restore the stable state,
// and verify the simulated state.
app.post("/api/test-version-failure", (req, res) => {
    const previousStableVersion = system.stableVersion;

    // Simulate candidate release activation
    system.currentVersion = "1.1.0";
    system.status = "Unhealthy";

    logIncident({
        type: "Version Health Check Failure",
        failedVersion: "1.1.0",
        diagnosis: "Controlled test: candidate release marked unhealthy",
        action: "Automatic rollback to last known stable version",
        recoveryStatus: "Recovering"
    });

    // Prototype state rollback (not source-code/deployment rollback)
    system.currentVersion = previousStableVersion;
    system.status = "Healthy";
    system.lastRecovery = new Date().toISOString();

    // Verify the restored simulated state
    const recovered =
        system.currentVersion === system.stableVersion &&
        system.status === "Healthy";

    system.incidents[0].recoveryStatus =
        recovered ? "Recovered (simulation verified)" : "Recovery failed";

    system.incidents[0].verification = recovered
        ? "Version state and controller status match the stable state"
        : "Stable state verification failed";

    res.json({
        message: recovered
            ? "Controlled recovery test completed"
            : "Recovery verification failed",
        failedVersion: "1.1.0",
        restoredVersion: system.currentVersion,
        status: system.status,
        recovered,
        note: "This prototype restores simulated version state only; it does not roll back SaleSphere source code or deployment."
    });
});

app.listen(PORT, () => {
    console.log(`PatchPilot running at http://localhost:${PORT}`);
});
