
/* ---------- SELF-HEALING VERSION MANAGER ---------- */

// Keep the known-good version fixed for this demo.
const stableVersion = "1.0.0";
const failedRelease = "1.1.0-bad";

const dataFolder = path.join(__dirname, "data");
const incidentFile = path.join(
    dataFolder,
    "self-healing-incidents.json"
);

if (!fs.existsSync(dataFolder)) {
    fs.mkdirSync(dataFolder, { recursive: true });
}

let incidents = [];

try {
    if (fs.existsSync(incidentFile)) {
        incidents = JSON.parse(
            fs.readFileSync(incidentFile, "utf8")
        );

        if (!Array.isArray(incidents)) {
            incidents = [];
        }
    }
} catch (error) {
    console.error("Incident history load failed:", error.message);
    incidents = [];
}

let versionState = {
    currentVersion: stableVersion,
    stableVersion,
    status: "healthy",
    activeIncidentId: null,
    updatedAt: new Date().toISOString()
};

function saveIncidents() {
    try {
        fs.writeFileSync(
            incidentFile,
            JSON.stringify(incidents.slice(-100), null, 2)
        );
    } catch (error) {
        console.error("Incident history save failed:", error.message);
    }
}

function addIncidentEvent(incident, event, details) {
    incident.events.push({
        event,
        details,
        timestamp: new Date().toISOString()
    });

    saveIncidents();
}

function updateVersionState(status) {
    versionState.status = status;
    versionState.updatedAt = new Date().toISOString();
}

function isDatabaseReady() {
    return mongoose.connection.readyState === 1;
}

// ---------- VERSION ENDPOINTS ----------

app.get("/api/system/version", (req, res) => {
    res.json({
        name: "SaleSphere",
        environment: "Controlled self-healing demo",
        ...versionState
    });
});

app.get("/api/system/version/health", (req, res) => {
    const healthy =
        versionState.status === "healthy" &&
        versionState.currentVersion === stableVersion &&
        isDatabaseReady();

    res.status(healthy ? 200 : 503).json({
        healthy,
        currentVersion: versionState.currentVersion,
        stableVersion,
        databaseReady: isDatabaseReady(),
        status: versionState.status,
        checkedAt: new Date().toISOString()
    });
});

// ---------- CHAOS / FAILURE INJECTION ----------

app.post("/api/system/version/chaos", (req, res) => {
    if (versionState.activeIncidentId) {
        return res.status(409).json({
            success: false,
            error: "A version recovery is already in progress."
        });
    }

    if (!isDatabaseReady()) {
        return res.status(503).json({
            success: false,
            error: "Database is not ready. Test was not started."
        });
    }

    const now = new Date().toISOString();

    const incident = {
        id: `VERSION-${Date.now()}`,
        type: "Automatic Version Rollback",
        status: "injected",

        // The candidate release fails; stable release remains 1.0.0.
        previousVersion: stableVersion,
        failedVersion: failedRelease,

        startedAt: now,
        detectedAt: null,
        diagnosedAt: null,
        actionAt: null,
        recoveredAt: null,

        detectionTimeMs: null,
        recoveryTimeMs: null,

        events: []
    };

    incidents.push(incident);

    versionState.currentVersion = incident.failedVersion;
    versionState.activeIncidentId = incident.id;

    updateVersionState("failed");

    addIncidentEvent(
        incident,
        "Injected",
        `Controlled bad release ${failedRelease} selected for the resilience test.`
    );

    return res.status(202).json({
        success: true,
        message: "Bad release injected. Automatic recovery has started.",
        incidentId: incident.id,
        failedVersion: incident.failedVersion,
        stableVersion,
        version: versionState.currentVersion,
        status: versionState.status
    });
});

// ---------- INCIDENT HISTORY ----------

app.get("/api/system/incidents", (req, res) => {
    res.json({
        incidents: [...incidents].reverse(),
        recoveries: incidents.filter(
            incident => incident.status === "recovered"
        ).length
    });
});

// ---------- AUTOMATIC WATCHDOG ----------

const watchdog = setInterval(() => {
    const incident = incidents.find(
        item => item.id === versionState.activeIncidentId
    );

    if (!incident) return;

    // Stage 1: Detect the failed release.
    if (!incident.detectedAt) {
        incident.detectedAt = new Date().toISOString();

        incident.detectionTimeMs =
            Date.now() - new Date(incident.startedAt).getTime();

        incident.status = "detected";

        addIncidentEvent(
            incident,
            "Detected",
            `Watchdog detected unhealthy release ${incident.failedVersion}.`
        );

        updateVersionState("detected");
        return;
    }

    // Stage 2: Diagnose and identify the stable target.
    if (!incident.diagnosedAt) {
        incident.diagnosedAt = new Date().toISOString();

        addIncidentEvent(
            incident,
            "Diagnosed",
            `Unhealthy release identified. Recovery target: ${incident.previousVersion}.`
        );

        updateVersionState("recovering");
        return;
    }

    // Stage 3: Automatically restore the stable release.
    if (!incident.actionAt) {
        incident.actionAt = new Date().toISOString();

        versionState.currentVersion = incident.previousVersion;
        incident.status = "rollback_in_progress";

        addIncidentEvent(
            incident,
            "Action taken",
            `Automatically restored stable release ${incident.previousVersion}.`
        );

        updateVersionState("verifying");
        return;
    }

    // Stage 4: Verify the restored version and database.
    if (!incident.recoveredAt) {
        const versionRestored =
            versionState.currentVersion === stableVersion;

        const databaseReady = isDatabaseReady();

        if (!versionRestored || !databaseReady) {
            updateVersionState("verifying");
            return;
        }

        incident.recoveredAt = new Date().toISOString();

        incident.recoveryTimeMs =
            Date.now() - new Date(incident.startedAt).getTime();

        incident.status = "recovered";

        addIncidentEvent(
            incident,
            "Recovered",
            `Recovery verified. Failed version: ${incident.failedVersion}. Restored version: ${stableVersion}.`
        );

        versionState.activeIncidentId = null;

        updateVersionState("healthy");
        saveIncidents();
    }
}, 1000);

// ---------- END SELF-HEALING VERSION MANAGER ----------
