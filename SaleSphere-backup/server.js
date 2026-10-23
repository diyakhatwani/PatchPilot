
    const express = require("express");
    const mongoose = require("mongoose");
    const path = require("path");
    const fs = require("fs");
    require("dotenv").config();

    const Lead = require("./models/Lead");

    const app = express();
    // ---------- SELF-HEALING VERSION MANAGER ----------

const stableVersion = require("./package.json").version;
const dataFolder = path.join(__dirname, "data");
const incidentFile = path.join(dataFolder, "self-healing-incidents.json");

if (!fs.existsSync(dataFolder)) {
    fs.mkdirSync(dataFolder, { recursive: true });
}

let incidents = [];

try {
    if (fs.existsSync(incidentFile)) {
        incidents = JSON.parse(fs.readFileSync(incidentFile, "utf8"));
        if (!Array.isArray(incidents)) incidents = [];
    }
} catch (error) {
    console.error("Incident history could not be loaded:", error.message);
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
        console.error("Incident history could not be saved:", error.message);
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

// Current release information
app.get("/api/system/version", (req, res) => {
    res.json({
        name: "SaleSphere",
        environment: "Controlled self-healing demo",
        ...versionState
    });
});

// Check whether the selected release passes its health gate
app.get("/api/system/version/health", (req, res) => {
    const healthy =
        versionState.status === "healthy" &&
        versionState.currentVersion === versionState.stableVersion;

    res.status(healthy ? 200 : 503).json({
        healthy,
        currentVersion: versionState.currentVersion,
        stableVersion: versionState.stableVersion,
        status: versionState.status,
        checkedAt: new Date().toISOString()
    });
});

// Inject a controlled bad release
app.post("/api/system/version/chaos", (req, res) => {
    if (versionState.activeIncidentId) {
        return res.status(409).json({
            error: "A version recovery is already in progress."
        });
    }

    const now = new Date().toISOString();

    const incident = {
        id: `VERSION-${Date.now()}`,
        type: "Automatic Version Rollback",
        status: "injected",
        previousVersion: versionState.stableVersion,
        failedVersion: "2.0.0-bad",
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

    addIncidentEvent(
        incident,
        "Injected",
        "Controlled bad release selected for the resilience test."
    );

    versionState.currentVersion = incident.failedVersion;
    versionState.activeIncidentId = incident.id;
    versionState.updatedAt = now;
    updateVersionState("failed");

    // The watchdog will detect and recover this failure automatically.
    res.status(202).json({
        message: "Bad release injected. Automatic recovery has started.",
        incidentId: incident.id,
        version: versionState.currentVersion,
        status: versionState.status
    });
});

// Return incident history
app.get("/api/system/incidents", (req, res) => {
    res.json({
        incidents: [...incidents].reverse(),
        recoveries: incidents.filter(
            incident => incident.status === "recovered"
        ).length
    });
});

// Watchdog: detect, diagnose, rollback and verify
setInterval(() => {
    const incident = incidents.find(
        item => item.id === versionState.activeIncidentId
    );

    if (!incident) return;

    // Stage 1: detect the failed release
    if (!incident.detectedAt) {
        incident.detectedAt = new Date().toISOString();
        incident.detectionTimeMs =
            Date.now() - new Date(incident.startedAt).getTime();

        incident.status = "detected";

        addIncidentEvent(
            incident,
            "Detected",
            "Version health gate failed for the candidate release."
        );

        updateVersionState("detected");
        return;
    }

    // Stage 2: diagnose the cause
    if (!incident.diagnosedAt) {
        incident.diagnosedAt = new Date().toISOString();

        addIncidentEvent(
            incident,
            "Diagnosed",
            "Candidate release is marked unhealthy; the previous stable release is available."
        );

        updateVersionState("recovering");
        return;
    }

    // Stage 3: automatically roll back
    if (!incident.actionAt) {
        incident.actionAt = new Date().toISOString();

        versionState.currentVersion = versionState.stableVersion;
        incident.status = "rollback_in_progress";

        addIncidentEvent(
            incident,
            "Action taken",
            `Automatically restored release ${versionState.stableVersion}.`
        );

        updateVersionState("verifying");
        return;
    }

    // Stage 4: verify recovery
    if (!incident.recoveredAt) {
        const healthPassed =
            versionState.currentVersion === versionState.stableVersion;

        if (!healthPassed) {
            updateVersionState("failed");
            return;
        }

        incident.recoveredAt = new Date().toISOString();
        incident.recoveryTimeMs =
            Date.now() - new Date(incident.startedAt).getTime();

        incident.status = "recovered";

        addIncidentEvent(
            incident,
            "Recovered",
            "Stable version restored and version health check passed."
        );

        versionState.activeIncidentId = null;
        updateVersionState("healthy");
    }
}, 1000);

// ---------- END SELF-HEALING VERSION MANAGER ----------
    const PORT = process.env.PORT || 3000;

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.static(path.join(__dirname, "public")));

    // Home route
    app.get("/", (req, res) => {
        res.sendFile(path.join(__dirname, "public", "index.html"));
    });

    // Application health
    app.get("/healthz", (req, res) => {
        res.json({
            app: "SaleSphere",
            status: "running",
            time: new Date().toISOString()
        });
    });

    // Database health
    app.get("/readyz", (req, res) => {
        const databaseConnected = mongoose.connection.readyState === 1;

        res.status(databaseConnected ? 200 : 503).json({
            app: "SaleSphere",
            database: databaseConnected ? "connected" : "disconnected",
            ready: databaseConnected
        });
    });

    // Prepare and validate follow-up date
    function prepareFollowUpDate(value) {
        if (value === undefined || value === null || value === "") {
            return null;
        }

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            throw new Error("Please provide a valid follow-up date.");
        }

        return date;
    }

    // Create a lead
    app.post("/api/leads", async (req, res) => {
        try {
            const {
                customerName,
                companyName,
                email,
                phone,
                interest,
                status,
                followUpDate,
                notes
            } = req.body;

            if (
                !customerName?.trim() ||
                !companyName?.trim() ||
                !interest?.trim()
            ) {
                return res.status(400).json({
                    error: "Customer name, company name and interest are required."
                });
            }

            const lead = await Lead.create({
                customerName: customerName.trim(),
                companyName: companyName.trim(),
                email: email?.trim() || "",
                phone: phone?.trim() || "",
                interest: interest.trim(),
                status: status || "New",
                followUpDate: prepareFollowUpDate(followUpDate),
                notes: notes?.trim() || ""
            });

            res.status(201).json({
                message: "Lead created successfully",
                lead
            });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Get all leads
    app.get("/api/leads", async (req, res) => {
        try {
            const leads = await Lead.find().sort({ createdAt: -1 });
            res.json(leads);
        } catch (error) {
            res.status(500).json({
                error: "Unable to load leads from the database."
            });
        }
    });

    // Update a lead
    app.put("/api/leads/:id", async (req, res) => {
        try {
            const {
                customerName,
                companyName,
                email,
                phone,
                interest,
                status,
                followUpDate,
                notes
            } = req.body;

            if (
                !customerName?.trim() ||
                !companyName?.trim() ||
                !interest?.trim()
            ) {
                return res.status(400).json({
                    error: "Customer name, company name and interest are required."
                });
            }

            const updatedData = {
                customerName: customerName.trim(),
                companyName: companyName.trim(),
                email: email?.trim() || "",
                phone: phone?.trim() || "",
                interest: interest.trim(),
                status: status || "New",
                followUpDate: prepareFollowUpDate(followUpDate),
                notes: notes?.trim() || ""
            };

            const lead = await Lead.findByIdAndUpdate(
                req.params.id,
                updatedData,
                {
                    new: true,
                    runValidators: true
                }
            );

            if (!lead) {
                return res.status(404).json({
                    error: "Lead not found."
                });
            }

            res.json({
                message: "Lead updated successfully",
                lead
            });
        } catch (error) {
            const isInvalidId = error.name === "CastError";

            res.status(isInvalidId ? 400 : 400).json({
                error: error.message
            });
        }
    });
    // Add activity to a customer lead
app.post("/api/leads/:id/activities", async (req, res) => {
    try {
        const { type, description } = req.body;

        const allowedTypes = [
            "Call",
            "Email",
            "Meeting",
            "Note",
            "Other"
        ];

        if (!description || !description.trim()) {
            return res.status(400).json({
                error: "Activity description is required."
            });
        }

        if (type && !allowedTypes.includes(type)) {
            return res.status(400).json({
                error: "Invalid activity type."
            });
        }

        const lead = await Lead.findById(req.params.id);

        if (!lead) {
            return res.status(404).json({
                error: "Customer lead not found."
            });
        }

        lead.activities.push({
            type: type || "Note",
            description: description.trim(),
            createdAt: new Date()
        });

        await lead.save();

        res.status(201).json({
            message: "Activity saved successfully.",
            activity: lead.activities[lead.activities.length - 1]
        });
    } catch (error) {
        const statusCode = error.name === "CastError" ? 400 : 500;

        res.status(statusCode).json({
            error: statusCode === 400
                ? "Invalid customer ID."
                : "Unable to save activity."
        });
    }
});

    // Delete a lead
    app.delete("/api/leads/:id", async (req, res) => {
        try {
            const lead = await Lead.findByIdAndDelete(req.params.id);

            if (!lead) {
                return res.status(404).json({
                    error: "Lead not found."
                });
            }

            res.json({
                message: "Lead deleted successfully"
            });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Start server after connecting to MongoDB
    async function startServer() {
        try {
            await mongoose.connect(
                process.env.MONGODB_URI ||
                "mongodb://127.0.0.1:27017/salesphere",
                { serverSelectionTimeoutMS: 5000 }
            );

            console.log("MongoDB connected successfully");

            app.listen(PORT, () => {
                console.log(`SaleSphere running at http://localhost:${PORT}`);
            });
        } catch (error) {
            console.error("Startup failed:", error.message);
            process.exitCode = 1;
        }
    }

    startServer();
