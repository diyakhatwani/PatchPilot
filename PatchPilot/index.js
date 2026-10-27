
const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 4000;
const APP_PORT = 3101;

const RELEASES_DIR = path.join(__dirname, "releases");
const STABLE_VERSION = "1.0.0";
const CANDIDATE_VERSION = "1.1.0";
const INCIDENT_FILE = path.join(__dirname, "incidents.json");

app.use(express.json());

let activeChild = null;
let activeVersion = null;
let busy = false;
let incidents = [];

try {
    if (fs.existsSync(INCIDENT_FILE)) {
        incidents = JSON.parse(fs.readFileSync(INCIDENT_FILE, "utf8"));
        if (!Array.isArray(incidents)) incidents = [];
    }
} catch {
    incidents = [];
}

function saveIncidents() {
    fs.writeFileSync(INCIDENT_FILE, JSON.stringify(incidents, null, 2));
}

function logEvent(incident, event, details) {
    incident.events.push({
        event,
        details,
        time: new Date().toISOString()
    });

    saveIncidents();
}

function releasePath(version) {
    const releasesRoot = path.resolve(RELEASES_DIR);
    const folder = path.resolve(releasesRoot, version);

    if (!folder.startsWith(releasesRoot + path.sep)) {
        throw new Error("Invalid release path.");
    }

    if (!fs.existsSync(path.join(folder, "server.js"))) {
        throw new Error(`server.js not found for release ${version}.`);
    }

    return folder;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function startRelease(version, injectFailure = false) {
    return new Promise((resolve, reject) => {
        let folder;

        try {
            folder = releasePath(version);
        } catch (error) {
            reject(error);
            return;
        }

        const child = spawn(process.execPath, ["server.js"], {
            cwd: folder,
            env: {
                ...process.env,
                PORT: String(APP_PORT),
                ...(injectFailure
                    ? { PATCHPILOT_TEST_FAILURE: "1" }
                    : { PATCHPILOT_TEST_FAILURE: "0" })
            },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
        });

        child.stdout.on("data", data => {
            console.log(
                `[SaleSphere ${version}] ${data.toString().trim()}`
            );
        });

        child.stderr.on("data", data => {
            console.error(
                `[SaleSphere ${version}] ${data.toString().trim()}`
            );
        });

        child.once("error", error => {
            if (activeChild === child) {
                activeChild = null;
                activeVersion = null;
            }

            reject(error);
        });

        child.once("spawn", () => {
            activeChild = child;
            activeVersion = version;

            console.log(
                `Started SaleSphere ${version} (PID ${child.pid})`
            );

            resolve(child);
        });

        child.once("exit", (code, signal) => {
            console.log(
                `[SaleSphere ${version}] exited: code=${code}, signal=${signal}`
            );

            if (activeChild === child) {
                activeChild = null;
                activeVersion = null;
            }
        });
    });
}

async function stopRelease() {
    const child = activeChild;

    if (!child) return;

    await new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }

        const timeout = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill();
            }
        }, 3000);

        child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
        });

        child.kill();
    });

    if (activeChild === child) {
        activeChild = null;
        activeVersion = null;
    }
}

async function checkHealth() {
    try {
        const response = await fetch(
            `http://127.0.0.1:${APP_PORT}/healthz`,
            { signal: AbortSignal.timeout(1500) }
        );

        return {
            healthy: response.ok,
            statusCode: response.status
        };
    } catch {
        return {
            healthy: false,
            statusCode: null
        };
    }
}

async function waitForHealth(attempts = 15) {
    for (let i = 0; i < attempts; i++) {
        const result = await checkHealth();

        if (result.healthy) return result;

        await wait(1000);
    }

    return checkHealth();
}

async function recoverToStable(incident) {
    await stopRelease();
    await wait(500);

    await startRelease(STABLE_VERSION, false);

    const result = await waitForHealth(15);

    if (!result.healthy) {
        incident.status = "recovery_failed";

        logEvent(
            incident,
            "Recovery failed",
            "Stable release did not pass /healthz. Check the release server, MongoDB configuration and logs."
        );

        return false;
    }

    incident.status = "recovered";
    incident.recoveredAt = new Date().toISOString();
    incident.restoredVersion = STABLE_VERSION;

    logEvent(
        incident,
        "Recovered",
        `Stable release ${STABLE_VERSION} is running. Health check returned HTTP ${result.statusCode}.`
    );

    return true;
}

app.get("/", (req, res) => {
    res.send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>PatchPilot</title>
      </head>
      <body style="font-family:Arial;max-width:800px;margin:40px auto">
        <h1>PatchPilot</h1>
        <p>Self-Healing Release Controller</p>
        <p>Controller port: ${PORT}</p>
        <p>SaleSphere app port: ${APP_PORT}</p>
        <p>Stable release: ${STABLE_VERSION}</p>
        <p>Test candidate: ${CANDIDATE_VERSION}</p>

        <button id="start">
          Run failure and automatic rollback test
        </button>

        <pre id="result">Checking controller...</pre>

        <p><a href="/api/status">System status JSON</a></p>
        <p><a href="/api/incidents">Incident history JSON</a></p>

        <script>
          async function refreshStatus() {
            try {
              const response = await fetch("/api/status");
              const data = await response.json();
              document.getElementById("result").textContent =
                JSON.stringify(data, null, 2);
            } catch (error) {
              document.getElementById("result").textContent =
                String(error);
            }
          }

          document.getElementById("start").onclick = async () => {
            const button = document.getElementById("start");
            const output = document.getElementById("result");

            button.disabled = true;
            output.textContent = "Testing candidate release and recovery...";

            try {
              const response = await fetch("/api/test-rollback", {
                method: "POST"
              });

              const data = await response.json();
              output.textContent = JSON.stringify(data, null, 2);
            } catch (error) {
              output.textContent = String(error);
            } finally {
              button.disabled = false;
              refreshStatus();
            }
          };

          refreshStatus();
        </script>
      </body>
      </html>
    `);
});

app.get("/api/status", async (req, res) => {
    res.json({
        controller: "PatchPilot",
        status: busy ? "recovering" : "ready",
        activeVersion,
        appPort: APP_PORT,
        health: await checkHealth()
    });
});

app.get("/api/incidents", (req, res) => {
    res.json([...incidents].reverse());
});

app.post("/api/test-rollback", async (req, res) => {
    if (busy) {
        return res.status(409).json({
            error: "A recovery test is already running."
        });
    }

    busy = true;

    const incident = {
        id: `PP-${Date.now()}`,
        type: "Candidate release health-check failure",
        candidateVersion: CANDIDATE_VERSION,
        stableVersion: STABLE_VERSION,
        status: "started",
        startedAt: new Date().toISOString(),
        events: []
    };

    incidents.push(incident);

    logEvent(
        incident,
        "Test started",
        "Starting candidate release with a controlled health-check failure."
    );

    try {
        await stopRelease();
        await wait(500);

        await startRelease(CANDIDATE_VERSION, true);

        const candidateHealth = await waitForHealth(12);

        if (candidateHealth.healthy) {
            incident.status = "unexpectedly_healthy";

            logEvent(
                incident,
                "Unexpected result",
                "Candidate passed its health check. Verify the failure condition in releases/1.1.0/server.js."
            );

            const recovered = await recoverToStable(incident);

            return res.status(500).json({
                message: "Candidate did not fail its health check. Stable release restoration was attempted.",
                candidateHealth,
                recovered,
                activeVersion,
                incident
            });
        }

        incident.detectedAt = new Date().toISOString();
        incident.failedStatusCode = candidateHealth.statusCode;
        incident.status = "failure_detected";

        logEvent(
            incident,
            "Failure detected",
            `Candidate health check failed: HTTP ${candidateHealth.statusCode ?? "unreachable"}.`
        );

        incident.diagnosis =
            "Candidate release failed its HTTP health check.";

        logEvent(incident, "Diagnosed", incident.diagnosis);

        logEvent(
            incident,
            "Rollback started",
            `Stopping candidate ${CANDIDATE_VERSION} and launching stable ${STABLE_VERSION}.`
        );

        const recovered = await recoverToStable(incident);

        return res.status(recovered ? 200 : 500).json({
            message: recovered
                ? "Automatic rollback completed and stable health was verified."
                : "Rollback was attempted, but stable health verification failed.",
            recovered,
            activeVersion,
            appUrl: `http://localhost:${APP_PORT}`,
            incident
        });
    } catch (error) {
        incident.status = "error";

        logEvent(
            incident,
            "Controller error",
            error.message
        );

        try {
            const recovered = await recoverToStable(incident);

            if (!recovered) {
                incident.status = "recovery_failed";
            }
        } catch (recoveryError) {
            incident.status = "recovery_failed";

            logEvent(
                incident,
                "Recovery error",
                recoveryError.message
            );
        }

        return res.status(500).json({
            error: error.message,
            activeVersion,
            incident
        });
    } finally {
        busy = false;
        saveIncidents();
    }
});

app.listen(PORT, async () => {
    console.log(`PatchPilot running at http://localhost:${PORT}`);
    console.log(`SaleSphere managed app uses port ${APP_PORT}`);

    try {
        await startRelease(STABLE_VERSION, false);

        const result = await waitForHealth(15);

        if (result.healthy) {
            console.log(
                `Stable release ${STABLE_VERSION} is healthy (HTTP ${result.statusCode}).`
            );
        } else {
            console.error(
                "Stable release started, but its health check failed. Check SaleSphere server logs and /healthz."
            );
        }
    } catch (error) {
        console.error(
            "Could not start stable SaleSphere release:",
            error.message
        );
    }
});
