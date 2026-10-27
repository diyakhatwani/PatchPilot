const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");

require("dotenv").config({
    path: path.join(__dirname, ".env")
});

const Lead = require("./models/Lead");
const app = express();
const PORT = process.env.PORT || 3101;
const emailTransporter =
    process.env.EMAIL_USER && process.env.EMAIL_PASS
        ? nodemailer.createTransport({
              service: "gmail",
              auth: {
                  user: process.env.EMAIL_USER,
                  pass: process.env.EMAIL_PASS
              }
          })
        : null;
const mongoURI =
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/salesphere";

const stableVersion = require("./package.json").version;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));




const dataFolder = path.join(__dirname, "data");

if (!fs.existsSync(dataFolder)) {
    fs.mkdirSync(dataFolder, { recursive: true });
}

const leadsCacheFile = path.join(
    dataFolder,
    "leads-cache.json"
);

const pendingOperationsFile = path.join(
    dataFolder,
    "pending-lead-operations.json"
);

const incidentFile = path.join(
    dataFolder,
    "incidents.json"
);
const emailQueueFile = path.join(
    dataFolder,
    "pending-email-operations.json"
);

function readJsonFile(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) {
            return fallback;
        }

        return JSON.parse(
            fs.readFileSync(filePath, "utf8")
        );
    } catch (error) {
        console.error(
            `Unable to read ${path.basename(filePath)}:`,
            error.message
        );

        return fallback;
    }
}

function writeJsonFile(filePath, data) {
    const temporaryFile = `${filePath}.tmp`;

    fs.writeFileSync(
        temporaryFile,
        JSON.stringify(data, null, 2),
        "utf8"
    );

    fs.renameSync(temporaryFile, filePath);
}

let cachedLeads = readJsonFile(
    leadsCacheFile,
    []
);

let pendingLeadOperations = readJsonFile(
    pendingOperationsFile,
    []
);

let incidents = readJsonFile(
    incidentFile,
    []
);
let pendingEmailOperations = readJsonFile(
    emailQueueFile,
    []
);

if (!Array.isArray(pendingEmailOperations)) {
    pendingEmailOperations = [];
}
if (!Array.isArray(cachedLeads)) {
    cachedLeads = [];
}

if (!Array.isArray(pendingLeadOperations)) {
    pendingLeadOperations = [];
}

if (!Array.isArray(incidents)) {
    incidents = [];
}

function saveLeadsCache() {
    try {
        writeJsonFile(leadsCacheFile, cachedLeads);
    } catch (error) {
        console.error(
            "Lead cache save failed:",
            error.message
        );
    }
}

function savePendingOperations() {
    try {
        writeJsonFile(
            pendingOperationsFile,
            pendingLeadOperations
        );
    } catch (error) {
        console.error(
            "Pending operation queue save failed:",
            error.message
        );
    }
}

function saveIncidents() {
    try {
        incidents = incidents.slice(-100);

        writeJsonFile(incidentFile, incidents);
    } catch (error) {
        console.error(
            "Incident history save failed:",
            error.message
        );
    }
}
function savePendingEmailOperations() {
    try {
        writeJsonFile(
            emailQueueFile,
            pendingEmailOperations
        );
    } catch (error) {
        console.error(
            "Pending email queue save failed:",
            error.message
        );
    }
}


function isMongoAvailable() {
    return mongoose.connection.readyState === 1;
}

function findCachedLead(id) {
    return cachedLeads.find(
        (lead) => String(lead._id) === String(id)
    );
}

function updateCachedLead(lead) {
    const id = String(lead._id);

    const index = cachedLeads.findIndex(
        (item) => String(item._id) === id
    );

    if (index >= 0) {
        cachedLeads[index] = {
            ...cachedLeads[index],
            ...lead
        };
    } else {
        cachedLeads.unshift(lead);
    }

    saveLeadsCache();
}

function removeCachedLead(id) {
    cachedLeads = cachedLeads.filter(
        (lead) => String(lead._id) !== String(id)
    );

    saveLeadsCache();
}

function queueLeadOperation(operation) {
    pendingLeadOperations.push({
        ...operation,
        queuedAt: new Date().toISOString()
    });

    savePendingOperations();
}

function getPendingCreateIds() {
    return new Set(
        pendingLeadOperations
            .filter(
                (operation) => operation.type === "create"
            )
            .map((operation) => String(operation.id))
    );
}

function getPendingDeleteIds() {
    return new Set(
        pendingLeadOperations
            .filter(
                (operation) => operation.type === "delete"
            )
            .map((operation) => String(operation.id))
    );
}

function getConfirmedCachedLeads() {
    const pendingCreateIds = getPendingCreateIds();
    const pendingDeleteIds = getPendingDeleteIds();

    return cachedLeads.filter((lead) => {
        const id = String(lead._id);

        return (
            !pendingCreateIds.has(id) &&
            !pendingDeleteIds.has(id)
        );
    });
}



let versionState = {
    currentVersion: stableVersion,
    stableVersion,
    status: "healthy",
    activeIncidentId: null,
    updatedAt: new Date().toISOString()
};

let chaosModeUntil = 0;
let activeMongoIncidentId = null;

let reconnectTimer = null;
let reconnectDelay = 1000;
let isConnecting = false;
let isSyncingOperations = false;
let recoveryVerificationRunning = false;

function addIncidentEvent(incident, event, details) {
    if (!Array.isArray(incident.events)) {
        incident.events = [];
    }

    incident.events.push({
        event,
        details,
        timestamp: new Date().toISOString()
    });

    incident.updatedAt = new Date().toISOString();

    saveIncidents();
}

function updateIncidentStatus(
    incident,
    status,
    details
) {
    incident.status = status;
    incident.updatedAt = new Date().toISOString();

    addIncidentEvent(
        incident,
        status,
        details
    );
}

function updateVersionState(status) {
    versionState.status = status;
    versionState.updatedAt = new Date().toISOString();
}

function isDatabaseReady() {
    return isMongoAvailable();
}

// ==================================================
// OFFLINE QUEUE AUTOMATIC SYNCHRONIZATION
// ==================================================

async function syncPendingLeadOperations() {
    if (
        isSyncingOperations ||
        !isMongoAvailable() ||
        pendingLeadOperations.length === 0
    ) {
        return;
    }

    isSyncingOperations = true;

    try {
        while (
            pendingLeadOperations.length > 0 &&
            isMongoAvailable()
        ) {
            const operation = pendingLeadOperations[0];
            const id = String(operation.id);

            if (operation.type === "create") {
                const leadData = {
                    ...operation.data,
                    _id: id
                };

                await Lead.updateOne(
                    { _id: id },
                    {
                        $setOnInsert: leadData
                    },
                    {
                        upsert: true,
                        runValidators: true,
                        timestamps: false
                    }
                );
            } else if (operation.type === "update") {
                const updateData = {
                    ...operation.data
                };

                delete updateData._id;
                delete updateData.createdAt;
                delete updateData.updatedAt;
                delete updateData.__v;

                const updatedLead =
                    await Lead.findByIdAndUpdate(
                        id,
                        { $set: updateData },
                        {
                            new: true,
                            runValidators: true,
                            timestamps: true
                        }
                    );

                if (!updatedLead) {
                    throw new Error(
                        `Lead ${id} was not found during synchronization.`
                    );
                }
            } else if (operation.type === "delete") {
                await Lead.deleteOne({
                    _id: id
                });
            } else {
                throw new Error(
                    `Unknown queued operation: ${operation.type}`
                );
            }

            // Remove from queue only after database operation succeeds.
            pendingLeadOperations.shift();
            savePendingOperations();

            console.log(
                `Offline operation synchronized: ${operation.type} (${id})`
            );
        }

        // Refresh confirmed cache only when every queued operation
        // has successfully synchronized.
        if (
            pendingLeadOperations.length === 0 &&
            isMongoAvailable()
        ) {
            cachedLeads = await Lead.find()
                .sort({ createdAt: -1 })
                .lean();

            saveLeadsCache();

            console.log(
                "Offline queue synchronized. Lead cache refreshed."
            );
        }
    } catch (error) {
        console.error(
            "Automatic synchronization paused; queued changes retained:",
            error.message
        );
    } finally {
        isSyncingOperations = false;
    }
}


app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "index.html")
    );
});

app.get("/healthz", (req, res) => {
    res.json({
        app: "SaleSphere",
        status: "running",
        time: new Date().toISOString()
    });
});

app.get("/readyz", (req, res) => {
    const connected = isDatabaseReady();

    res.status(connected ? 200 : 503).json({
        app: "SaleSphere",
        database: connected
            ? "connected"
            : "disconnected",
        ready: connected
    });
});

app.get("/api/system/version", (req, res) => {
    res.set("Cache-Control", "no-store");

    res.json({
        name: "SaleSphere",
        environment: "Controlled self-healing demo",
        ...versionState
    });
});

app.get("/api/system/version/health", (req, res) => {
    const healthy =
        versionState.status === "healthy" &&
        versionState.currentVersion ===
            versionState.stableVersion &&
        isDatabaseReady();

    res.status(healthy ? 200 : 503).json({
        healthy,
        currentVersion: versionState.currentVersion,
        stableVersion: versionState.stableVersion,
        databaseReady: isDatabaseReady(),
        status: versionState.status,
        checkedAt: new Date().toISOString()
    });
});

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
        previousVersion: versionState.stableVersion,
        failedVersion: `${versionState.stableVersion}-candidate`,
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
        "Controlled unhealthy candidate release selected for the resilience test."
    );

    return res.status(202).json({
        success: true,
        message: "Bad release injected. Automatic recovery has started.",
        incidentId: incident.id,
        version: versionState.currentVersion,
        status: versionState.status
    });
});

app.post("/api/system/unrecoverable-chaos", (req, res) => {
    const now = new Date().toISOString();

    const incident = {
        id: `LIMIT-${Date.now()}`,
        type: "Trusted Backup Unavailable",
        status: "unrecovered",
        startedAt: now,
        detectedAt: now,
        diagnosedAt: null,
        actionAt: null,
        recoveredAt: null,
        detectionTimeMs: 0,
        recoveryTimeMs: null,
        recoveryAvailable: false,
        reason: "No trusted backup is available to restore the affected component.",
        events: []
    };

    incidents.push(incident);

    addIncidentEvent(
        incident,
        "Detected",
        "PatchPilot detected a simulated unrecoverable failure."
    );

    incident.diagnosedAt = new Date().toISOString();

    addIncidentEvent(
        incident,
        "Diagnosed",
        "Diagnosis complete: no trusted backup is available."
    );

    incident.actionAt = new Date().toISOString();

    addIncidentEvent(
        incident,
        "Recovery Blocked",
        "Automatic recovery was safely stopped because a trusted backup is unavailable. No customer data was changed."
    );

    incident.updatedAt = new Date().toISOString();

    saveIncidents();

    return res.status(201).json({
        success: true,
        message: "Failure diagnosed. Automatic recovery is unavailable.",
        incident
    });
});

app.get("/api/system/incidents", (req, res) => {
    res.set("Cache-Control", "no-store");

    res.json({
        incidents: [...incidents].reverse(),
        recoveries: incidents.filter(
            (incident) =>
                String(incident.status).toLowerCase() === "recovered"
        ).length
    });
});


setInterval(() => {
    const incident = incidents.find(
        (item) =>
            item.id === versionState.activeIncidentId
    );

    if (!incident) {
        return;
    }


    if (!incident.detectedAt) {
        incident.detectedAt = new Date().toISOString();

        incident.detectionTimeMs =
            Date.now() -
            new Date(incident.startedAt).getTime();

        incident.status = "detected";

        addIncidentEvent(
            incident,
            "Detected",
            "Candidate release failed the version health gate."
        );

        updateVersionState("detected");
        return;
    }

   
    if (!incident.diagnosedAt) {
        incident.diagnosedAt = new Date().toISOString();

        addIncidentEvent(
            incident,
            "Diagnosed",
            "Unhealthy candidate identified. Previous stable release is available."
        );

        updateVersionState("recovering");
        return;
    }

    // 3. Recover automatically
    if (!incident.actionAt) {
        incident.actionAt = new Date().toISOString();

        versionState.currentVersion =
            incident.previousVersion;

        incident.status = "rollback_in_progress";

        addIncidentEvent(
            incident,
            "Action taken",
            `Restored the stable release ${incident.previousVersion} in the demo version manager.`
        );

        updateVersionState("verifying");
        return;
    }

    
    if (!incident.recoveredAt) {
        const versionRestored =
            versionState.currentVersion ===
            incident.previousVersion;

        if (
            !versionRestored ||
            !isDatabaseReady()
        ) {
            updateVersionState("verifying");
            return;
        }

        incident.recoveredAt =
            new Date().toISOString();

        incident.recoveryTimeMs =
            Date.now() -
            new Date(incident.startedAt).getTime();

        incident.status = "recovered";

        addIncidentEvent(
            incident,
            "Recovered",
            "Stable version restored and database readiness check passed."
        );

        versionState.activeIncidentId = null;

        updateVersionState("healthy");
        saveIncidents();
    }
}, 1000);

function prepareFollowUpDate(value) {
    if (
        value === undefined ||
        value === null ||
        value === ""
    ) {
        return null;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new Error(
            "Please provide a valid follow-up date."
        );
    }

    return date;
}

function prepareLeadData(body) {
    const {
        customerName,
        companyName,
        email,
        phone,
        interest,
        status,
        followUpDate,
        notes
    } = body;

    if (
        typeof customerName !== "string" ||
        !customerName.trim() ||
        typeof companyName !== "string" ||
        !companyName.trim() ||
        typeof interest !== "string" ||
        !interest.trim()
    ) {
        throw new Error(
            "Customer name, company name and interest are required."
        );
    }

    const allowedStatuses = [
        "New",
        "Contacted",
        "Qualified",
        "Proposal",
        "Won",
        "Lost"
    ];

    const cleanStatus =
        typeof status === "string" && status.trim()
            ? status.trim()
            : "New";

    if (!allowedStatuses.includes(cleanStatus)) {
        throw new Error(
            "Please provide a valid lead status."
        );
    }

    return {
        customerName: customerName.trim(),
        companyName: companyName.trim(),
        email:
            typeof email === "string"
                ? email.trim().toLowerCase()
                : "",
        phone:
            typeof phone === "string"
                ? phone.trim()
                : "",
        interest: interest.trim(),
        status: cleanStatus,
        followUpDate: prepareFollowUpDate(followUpDate),
        notes:
            typeof notes === "string"
                ? notes.trim()
                : ""
    };
}

function isValidationError(error) {
    return (
        error &&
        ["ValidationError", "CastError"].includes(error.name)
    );
}
// create lead
app.post("/api/leads", async (req, res) => {
    let leadData;

    try {
        leadData = prepareLeadData(req.body);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    if (isMongoAvailable()) {
        try {
            const lead = await Lead.create(leadData);

            updateCachedLead(lead.toObject());

            return res.status(201).json({
                message: "Lead created successfully.",
                lead,
                pendingSync: false
            });
        } catch (error) {
            if (isValidationError(error)) {
                return res.status(400).json({
                    error: error.message
                });
            }

            console.error(
                "MongoDB create failed:",
                error.message
            );

            if (isMongoAvailable()) {
                return res.status(503).json({
                    error: "MongoDB could not confirm saving this lead. Please retry."
                });
            }
        }
    }

   
    try {
        const id =
            new mongoose.Types.ObjectId().toString();

        const now = new Date().toISOString();

        const localLead = {
            ...leadData,
            _id: id,
            createdAt: now,
            updatedAt: now,
            __v: 0
        };

        updateCachedLead(localLead);

        queueLeadOperation({
            type: "create",
            id,
            data: localLead
        });

        return res.status(202).json({
            message: "Lead saved locally. It will sync automatically when MongoDB reconnects.",
            lead: localLead,
            pendingSync: true
        });
    } catch (error) {
        console.error(
            "Local lead save failed:",
            error.message
        );

        return res.status(500).json({
            error: "Lead could not be saved locally. Check the server data folder permissions."
        });
    }
});

// rcovry
const apiRecoveryState = {
    status: "Healthy",
    stage: "idle",
    message: "API is operating normally.",
    incidentId: null,
    failureUntil: 0,
    incidents: []
};

app.get("/api/system/api-recovery-status", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
        status: apiRecoveryState.status,
        stage: apiRecoveryState.stage,
        message: apiRecoveryState.message,
        incidentId: apiRecoveryState.incidentId,
        incidents: [...apiRecoveryState.incidents].reverse().slice(0, 10)
    });
});

app.post("/api/system/api-failure", (req, res) => {
    if (apiRecoveryState.status === "Recovering") {
        return res.status(409).json({
            success: false,
            error: "API recovery test is already running."
        });
    }

    const incident = {
        id: "API-" + Date.now(),
        type: "API Failure Recovery",
        status: "Recovering",
        startedAt: new Date().toISOString(),
        recoveredAt: null,
        recoveryTimeMs: null
    };

    apiRecoveryState.incidentId = incident.id;
    apiRecoveryState.status = "Recovering";
    apiRecoveryState.stage = "detected";
    apiRecoveryState.message = "API failure detected. PatchPilot is diagnosing.";
    apiRecoveryState.failureUntil = Date.now() + 7000;
    apiRecoveryState.incidents.push(incident);

    setTimeout(() => {
        if (apiRecoveryState.incidentId !== incident.id) return;
        apiRecoveryState.stage = "recovery_in_progress";
        apiRecoveryState.message = "PatchPilot is restoring API availability.";
    }, 1800);

    setTimeout(() => {
        if (apiRecoveryState.incidentId !== incident.id) return;
        apiRecoveryState.failureUntil = 0;
        apiRecoveryState.status = "Healthy";
        apiRecoveryState.stage = "recovered";
        apiRecoveryState.message = "API recovery completed. Verification is ready.";
        incident.status = "Recovered";
        incident.recoveredAt = new Date().toISOString();
        incident.recoveryTimeMs = Date.now() - Number(incident.id.slice(4));
    }, 7000);

    return res.status(202).json({
        success: true,
        incidentId: incident.id,
        message: "Controlled API failure injected."
    });
});

app.get("/api/leads", async (req, res) => {
    res.set("Cache-Control", "no-store");

    if (Date.now() < apiRecoveryState.failureUntil) {
        return res.status(503).json({
            error: "Controlled API failure. PatchPilot recovery is in progress.",
            incidentId: apiRecoveryState.incidentId
        });
    }
    try {
        const pendingCreateIds = getPendingCreateIds();
        const pendingDeleteIds = getPendingDeleteIds();

        if (isMongoAvailable()) {
            const databaseLeads = await Lead.find()
                .sort({ createdAt: -1 })
                .lean();

            const confirmedLeads = databaseLeads.filter(
                (lead) => {
                    const id = String(lead._id);

                    return (
                        !pendingCreateIds.has(id) &&
                        !pendingDeleteIds.has(id)
                    );
                }
            );

            res.set("X-Data-Source", "mongodb");

            return res.json(confirmedLeads);
        }

        
        const confirmedCachedLeads =
            getConfirmedCachedLeads();

        res.set("X-Data-Source", "cache");

        return res.json(confirmedCachedLeads);
    } catch (error) {
        console.error(
            "Customer leads read failed:",
            error.message
        );

        return res.status(503).json({
            error: "Customer leads could not be verified. Please retry."
        });
    }
});



app.get("/api/leads/offline", (req, res) => {
    const pendingLeads = new Map();

    for (const operation of pendingLeadOperations) {
        const id = String(operation.id);

        if (operation.type === "create") {
            pendingLeads.set(id, {
                ...operation.data,
                _id: id
            });
        } else if (operation.type === "update") {
            const existingLead = pendingLeads.get(id);

            if (existingLead) {
                pendingLeads.set(id, {
                    ...existingLead,
                    ...operation.data,
                    _id: id
                });
            }
        } else if (operation.type === "delete") {
            pendingLeads.delete(id);
        }
    }

    const offlineLeads =
        Array.from(pendingLeads.values()).map(
            (lead) => ({
                ...lead,
                syncStatus: "Pending Sync"
            })
        );

    res.set("Cache-Control", "no-store");

    return res.json(offlineLeads);
});

// ==================================================
// UPDATE LEAD
// ==================================================

app.put("/api/leads/:id", async (req, res) => {
    let updatedData;

    try {
        updatedData = prepareLeadData(req.body);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    const leadId = String(req.params.id);

    if (!mongoose.isValidObjectId(leadId)) {
        return res.status(400).json({
            error: "Invalid lead ID."
        });
    }

    if (isMongoAvailable()) {
        try {
            const updatedLead =
                await Lead.findByIdAndUpdate(
                    leadId,
                    updatedData,
                    {
                        new: true,
                        runValidators: true
                    }
                );

            if (!updatedLead) {
                return res.status(404).json({
                    error: "Lead not found."
                });
            }

            updateCachedLead(updatedLead.toObject());

            return res.json({
                message: "Lead updated successfully.",
                lead: updatedLead,
                pendingSync: false
            });
        } catch (error) {
            if (isValidationError(error)) {
                return res.status(400).json({
                    error: error.message
                });
            }

            console.error(
                "MongoDB update failed:",
                error.message
            );

            if (isMongoAvailable()) {
                return res.status(503).json({
                    error: "MongoDB could not confirm this update. Please retry."
                });
            }
        }
    }

    const existingLead = findCachedLead(leadId);

    if (!existingLead) {
        return res.status(404).json({
            error: "Lead is not available in the local cache."
        });
    }

    const updatedLead = {
        ...existingLead,
        ...updatedData,
        updatedAt: new Date().toISOString()
    };

    updateCachedLead(updatedLead);

    queueLeadOperation({
        type: "update",
        id: leadId,
        data: updatedData
    });

    return res.status(202).json({
        message: "Lead updated locally. Changes will sync automatically.",
        lead: updatedLead,
        pendingSync: true
    });
});

// cst Activity
app.post(
    "/api/leads/:id/activities",
    async (req, res) => {
        try {
            const { type, description } = req.body;

            const allowedTypes = [
                "Call",
                "Email",
                "Meeting",
                "Note",
                "Other"
            ];

            if (
                typeof description !== "string" ||
                !description.trim()
            ) {
                return res.status(400).json({
                    error: "Activity description is required."
                });
            }

            if (
                type &&
                !allowedTypes.includes(type)
            ) {
                return res.status(400).json({
                    error: "Invalid activity type."
                });
            }

            if (!isMongoAvailable()) {
                return res.status(503).json({
                    error: "Customer activities require an active database connection. Your lead data is still available in the local cache."
                });
            }

            const lead = await Lead.findById(
                req.params.id
            );

            if (!lead) {
                return res.status(404).json({
                    error: "Customer lead not found."
                });
            }

            if (!Array.isArray(lead.activities)) {
                lead.activities = [];
            }

            lead.activities.push({
                type: type || "Note",
                description: description.trim(),
                createdAt: new Date()
            });

            await lead.save();

            return res.status(201).json({
                message: "Activity saved successfully.",
                activity:
                    lead.activities[
                        lead.activities.length - 1
                    ]
            });
        } catch (error) {
            const statusCode =
                error.name === "CastError" ? 400 : 500;

            return res.status(statusCode).json({
                error:
                    statusCode === 400
                        ? "Invalid customer ID."
                        : "Unable to save activity."
            });
        }
    }
);
// delete
app.delete("/api/leads/:id", async (req, res) => {
    const leadId = String(req.params.id);

    if (!mongoose.isValidObjectId(leadId)) {
        return res.status(400).json({
            error: "Invalid lead ID."
        });
    }

    if (isMongoAvailable()) {
        try {
            const deletedLead =
                await Lead.findByIdAndDelete(leadId);

            if (!deletedLead) {
                return res.status(404).json({
                    error: "Lead not found."
                });
            }

            removeCachedLead(leadId);

            return res.json({
                message: "Lead deleted successfully.",
                pendingSync: false
            });
        } catch (error) {
            console.error(
                "MongoDB delete failed:",
                error.message
            );

            if (isMongoAvailable()) {
                return res.status(503).json({
                    error: "MongoDB could not confirm this deletion. Please retry."
                });
            }
        }
    }

    const existingLead = findCachedLead(leadId);

    if (!existingLead) {
        return res.status(404).json({
            error: "Lead is not available in the local cache."
        });
    }

    removeCachedLead(leadId);

    queueLeadOperation({
        type: "delete",
        id: leadId
    });

    return res.status(202).json({
        message: "Lead removed locally. Deletion will sync automatically when MongoDB reconnects.",
        pendingSync: true
    });
});

//  db Cache 
app.get(
    "/api/system/data-status",
    async (req, res) => {
        const connected = isMongoAvailable();

        
        if (
            connected &&
            pendingLeadOperations.length === 0
        ) {
            try {
                cachedLeads = await Lead.find()
                    .sort({ createdAt: -1 })
                    .lean();

                saveLeadsCache();
            } catch (error) {
                console.error(
                    "Status check could not refresh cache:",
                    error.message
                );
            }
        }

        res.set("Cache-Control", "no-store");

        res.json({
            app: "SaleSphere",
            database: isMongoAvailable()
                ? "Connected"
                : "Disconnected",
            databaseConnected: isMongoAvailable(),
            cacheAvailable: Array.isArray(cachedLeads),
            cachedLeadCount: getConfirmedCachedLeads().length,
            pendingSyncCount: pendingLeadOperations.length,
            recoveryMode: !isMongoAvailable()
                ? "Recovering"
                : pendingLeadOperations.length > 0
                    ? "Syncing"
                    : "Healthy"
        });
    }
);


app.post(
    "/api/system/database/chaos",
    async (req, res) => {
        if (process.env.NODE_ENV === "production") {
            return res.status(403).json({
                error: "Failure injection is disabled in production."
            });
        }

        const isLocalRequest = [
            "127.0.0.1",
            "::1",
            "::ffff:127.0.0.1"
        ].includes(req.ip);

        if (!isLocalRequest) {
            return res.status(403).json({
                error: "Only localhost can inject a demo failure."
            });
        }

        if (activeMongoIncidentId) {
            return res.status(409).json({
                error: "A database recovery is already in progress.",
                incidentId: activeMongoIncidentId
            });
        }

        if (!isMongoAvailable()) {
            return res.status(409).json({
                error: "MongoDB is already disconnected or reconnecting."
            });
        }

        const incident = {
            id: new mongoose.Types.ObjectId().toString(),
            type: "MongoDB Connection Failure",
            status: "Detected",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            recoveryTimeMs: null,
            events: []
        };

        incidents.push(incident);
        activeMongoIncidentId = incident.id;

        addIncidentEvent(
            incident,
            "Detected",
            "Controlled MongoDB connection failure requested from the local demo."
        );

        addIncidentEvent(
            incident,
            "Diagnosing",
            "Connection state checked; automatic recovery policy selected."
        );

        chaosModeUntil = Date.now() + 8000;

        addIncidentEvent(
            incident,
            "Recovering",
            "SaleSphere will retry the MongoDB connection automatically."
        );

        try {
            await mongoose.disconnect();

            // Schedule after the intentional disconnect.
            scheduleReconnect();

            return res.status(202).json({
                message: "Controlled failure injected. Automatic recovery has started.",
                incidentId: incident.id,
                status: incident.status,
                recoveryExpectedInSeconds: 8
            });
        } catch (error) {
            chaosModeUntil = 0;

            updateIncidentStatus(
                incident,
                "Recovery Failed",
                error.message
            );

            activeMongoIncidentId = null;

            return res.status(500).json({
                error: "Failure injection could not complete.",
                incidentId: incident.id
            });
        }
    }
);

// ==================================================
// MONGODB CONNECTION AND AUTOMATIC RECONNECT
// NOTE: Only ONE connectMongoDB function is defined.
// ==================================================

function scheduleReconnect() {
    if (
        reconnectTimer ||
        isConnecting ||
        isMongoAvailable()
    ) {
        return;
    }

    const remainingChaosDelay = Math.max(
        0,
        chaosModeUntil - Date.now()
    );

    const delay = Math.max(
        reconnectDelay,
        remainingChaosDelay
    );

    console.log(
        `MongoDB reconnect scheduled in ${(delay / 1000).toFixed(1)} seconds.`
    );

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connectMongoDB();
    }, delay);

    reconnectDelay = Math.min(
        reconnectDelay * 2,
        15000
    );
}

async function verifyMongoRecovery() {
    if (
        !activeMongoIncidentId ||
        recoveryVerificationRunning
    ) {
        return;
    }

    const incident = incidents.find(
        (item) => item.id === activeMongoIncidentId
    );

    if (!incident) {
        activeMongoIncidentId = null;
        chaosModeUntil = 0;
        return;
    }

    recoveryVerificationRunning = true;

    try {
        if (!isMongoAvailable()) {
            throw new Error(
                "MongoDB is not connected yet."
            );
        }

        await Lead.countDocuments();

        if (pendingLeadOperations.length > 0) {
            await syncPendingLeadOperations();
        }

        if (pendingLeadOperations.length > 0) {
            throw new Error(
                "Pending lead operations are still waiting to sync."
            );
        }

        cachedLeads = await Lead.find()
            .sort({ createdAt: -1 })
            .lean();

        saveLeadsCache();

        updateIncidentStatus(
            incident,
            "Verifying",
            "MongoDB query succeeded and all queued lead operations are synchronized."
        );

        incident.recoveryTimeMs =
            Date.now() -
            new Date(incident.createdAt).getTime();

        updateIncidentStatus(
            incident,
            "Recovered",
            "Database verification passed and all queued lead operations are synchronized."
        );

        activeMongoIncidentId = null;
        chaosModeUntil = 0;

        console.log(
            "SELF-HEALING VERIFIED: SaleSphere database recovery succeeded."
        );
    } catch (error) {
        console.error(
            "Database recovery verification failed:",
            error.message
        );

        if (incident.status !== "Verification Failed") {
            updateIncidentStatus(
                incident,
                "Verification Failed",
                error.message
            );
        }

        
    } finally {
        recoveryVerificationRunning = false;
    }
}

async function connectMongoDB() {
    if (
        isConnecting ||
        isMongoAvailable()
    ) {
        return;
    }

    isConnecting = true;

    try {
        
        const remainingChaosDelay = Math.max(
            0,
            chaosModeUntil - Date.now()
        );

        if (remainingChaosDelay > 0) {
            await new Promise((resolve) => {
                setTimeout(resolve, remainingChaosDelay);
            });
        }

        await mongoose.connect(mongoURI, {
            serverSelectionTimeoutMS: 5000
        });

        console.log(
            "Connected database:",
            mongoose.connection.name
        );

        console.log(
            "Connected host:",
            mongoose.connection.host
        );

        console.log("MongoDB connected successfully.");

        reconnectDelay = 1000;

        // Synchronize pending offline operations first.
        if (pendingLeadOperations.length > 0) {
            await syncPendingLeadOperations();
        }

        
        if (
            activeMongoIncidentId &&
            pendingLeadOperations.length === 0
        ) {
            await verifyMongoRecovery();
        }

        
        if (
            pendingLeadOperations.length === 0 &&
            !activeMongoIncidentId &&
            isMongoAvailable()
        ) {
            cachedLeads = await Lead.find()
                .sort({ createdAt: -1 })
                .lean();

            saveLeadsCache();
        }
    } catch (error) {
        console.error(
            "MongoDB connection/recovery failed:",
            error.message
        );
    } finally {
        
        isConnecting = false;

        if (!isMongoAvailable()) {
            scheduleReconnect();
        } else if (
            pendingLeadOperations.length > 0
        ) {
            setTimeout(() => {
                if (isMongoAvailable()) {
                    void syncPendingLeadOperations();
                }
            }, 1000);
        }

        if (
            activeMongoIncidentId &&
            isMongoAvailable()
        ) {
            setTimeout(() => {
                void verifyMongoRecovery();
            }, 500);
        }
    }
}

let simulateNextEmailFailure = false;

const emailRecoveryState = {
    status: "Healthy",
    stage: "idle",
    message: "Email service is ready.",
    incidentId: null,
    detectedAt: null,
    recoveredAt: null,
    detectionTimeMs: null,
    recoveryTimeMs: null,
    lastResult: null
};

const emailWait = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

app.post("/api/system/email-failure", (req, res) => {
    simulateNextEmailFailure = true;

    res.json({
        success: true,
        message: "Email failure armed. Send a follow-up email to test recovery."
    });
});

app.get("/api/system/email-recovery-status", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ...emailRecoveryState });
});

async function sendEmailWithSelfHealing(mailOptions) {
    if (!simulateNextEmailFailure) {
        await emailTransporter.sendMail(mailOptions);

        emailRecoveryState.status = "Healthy";
        emailRecoveryState.stage = "idle";
        emailRecoveryState.message = "Email sent successfully.";
        emailRecoveryState.lastResult = "sent";

        return { recovered: false, attempts: 1 };
    }

    simulateNextEmailFailure = false;

    const startedAt = Date.now();
    const incidentId = `EMAIL-${Date.now()}`;

    Object.assign(emailRecoveryState, {
        status: "Failed",
        stage: "detected",
        message: "Email delivery failure detected.",
        incidentId,
        detectedAt: new Date().toISOString(),
        recoveredAt: null,
        detectionTimeMs: 0,
        recoveryTimeMs: null,
        lastResult: null
    });

    emailRecoveryState.detectionTimeMs = Date.now() - startedAt;

    console.error(`[PatchPilot] ${incidentId}: Email failure detected.`);

    try {

        emailRecoveryState.stage = "detected";
        emailRecoveryState.status = "Failed";
        emailRecoveryState.message =
            "Email delivery failure detected. PatchPilot is investigating.";

        console.log(`[PatchPilot] ${incidentId}: Failure detected.`);

        await emailWait(300);

        emailRecoveryState.stage = "diagnosed";
        emailRecoveryState.message =
            "PatchPilot diagnosed the simulated email service failure.";

        console.log(`[PatchPilot] ${incidentId}: Diagnosed.`);

        await emailWait(300);

        emailRecoveryState.status = "Recovering";
        emailRecoveryState.stage = "recovering";
        emailRecoveryState.message =
            "PatchPilot is attempting automatic recovery.";

        console.log(`[PatchPilot] ${incidentId}: Recovery started.`);

        await emailTransporter.sendMail(mailOptions);

        Object.assign(emailRecoveryState, {
            status: "Healthy",
            stage: "recovered",
            message: "Email service recovered. Email sent successfully.",
            recoveredAt: new Date().toISOString(),
            recoveryTimeMs: Date.now() - startedAt,
            lastResult: "sent"
        });

        console.log(
            `[PatchPilot] ${incidentId}: Recovered in ${emailRecoveryState.recoveryTimeMs}ms.`
        );

        return { recovered: true, attempts: 2 };
    } catch (error) {
        Object.assign(emailRecoveryState, {
            status: "Failed",
            stage: "failed",
            message: `Automatic recovery failed: ${error.message}`,
            recoveryTimeMs: Date.now() - startedAt,
            lastResult: "failed"
        });

        console.error(`[PatchPilot] ${incidentId}: Recovery failed.`, error);

        throw error;
    }
}


app.post("/api/followups/:leadId/send-email", async (req, res) => {
    try {
        if (!emailTransporter) {
            return res.status(503).json({
                error: "Email is not configured. Please check the email settings."
            });
        }

        if (!isMongoAvailable()) {
            return res.status(503).json({
                error: "Database is temporarily unavailable. Please try again."
            });
        }

        const { leadId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(leadId)) {
            return res.status(400).json({
                error: "Invalid customer ID."
            });
        }

        const lead = await Lead.findById(leadId);

        if (!lead) {
            return res.status(404).json({
                error: "Customer not found."
            });
        }

        if (
            !lead.email ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)
        ) {
            return res.status(400).json({
                error: "Please add a valid email address for this customer."
            });
        }

        const recovery = await sendEmailWithSelfHealing({
            from: process.env.EMAIL_USER,
            to: lead.email,
            subject: `Follow-up Reminder from SaleSphere${lead.companyName ? ` - ${lead.companyName}` : ""}`,
            text: `Hello ${lead.customerName},

This is a follow-up reminder from SaleSphere.

${lead.companyName ? `Company: ${lead.companyName}\n` : ""}Interest: ${lead.interest || "Not specified"}
Status: ${lead.status || "New"}
${lead.followUpDate ? `Follow-up Date: ${String(lead.followUpDate).slice(0, 10)}\n` : ""}
We look forward to connecting with you.

Regards,
SaleSphere Team`
        });

        console.log(`Follow-up email sent to ${lead.email}`);

        return res.json({
    success: true,
    recovered: recovery.recovered,
    attempts: recovery.attempts,
    message: recovery.recovered
        ? `Email service recovered automatically. Email sent to ${lead.email}.`
        : `Follow-up email sent successfully to ${lead.email}.`
});
    } catch (error) {
        console.error("Follow-up email failed:", error.message);

        return res.status(500).json({
            error: "Email could not be sent. Please try again."
        });
    }
});

// ==================================================
// MONGODB CONNECTION EVENTS
// ==================================================

mongoose.connection.on("disconnected", () => {
    console.warn(
        "MongoDB disconnected. Automatic recovery started."
    );

    scheduleReconnect();
});

mongoose.connection.on("error", (error) => {
    console.error(
        "MongoDB connection error:",
        error.message
    );
});

mongoose.connection.on("connected", () => {
    console.log("MongoDB connection established.");
});


setInterval(async () => {
    if (!isMongoAvailable()) {
        return;
    }

    if (pendingLeadOperations.length > 0) {
        await syncPendingLeadOperations();
    }

    if (
        activeMongoIncidentId &&
        pendingLeadOperations.length === 0
    ) {
        await verifyMongoRecovery();
    }
}, 3000);


setInterval(() => {
    if (!isMongoAvailable()) {
        scheduleReconnect();
    }
}, 5000);


console.log(
    "MongoDB URI configured:",
    Boolean(process.env.MONGODB_URI)
);

console.log(
    "Atlas URI configured:",
    process.env.MONGODB_URI?.startsWith("mongodb+srv://") || false
);

console.log(
    "Using local fallback:",
    !process.env.MONGODB_URI
);

app.listen(PORT, () => {
    console.log(
        `SaleSphere running at http://localhost:${PORT}`
    );

    void connectMongoDB();
});