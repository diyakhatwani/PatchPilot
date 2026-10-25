
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
require("dotenv").config({
    path: path.join(__dirname, ".env")
});

const Lead = require("./models/Lead");

const app = express();
const PORT = process.env.PORT || 3101;

// ---------- MIDDLEWARE ----------

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- SELF-HEALING VERSION MANAGER ----------

const stableVersion = require("./package.json").version;
const dataFolder = path.join(__dirname, "data");

if (!fs.existsSync(dataFolder)) {
    fs.mkdirSync(dataFolder, { recursive: true });
}




const leadsCacheFile = path.join(dataFolder, "leads-cache.json");
const pendingOperationsFile = path.join(
    dataFolder,
    "pending-lead-operations.json"
);

function readJsonFile(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) {
            return fallback;
        }

        const content = fs.readFileSync(filePath, "utf8");
        return JSON.parse(content);
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

let cachedLeads = readJsonFile(leadsCacheFile, []);
let pendingLeadOperations = readJsonFile(
    pendingOperationsFile,
    []
);

if (!Array.isArray(cachedLeads)) cachedLeads = [];
if (!Array.isArray(pendingLeadOperations)) {
    pendingLeadOperations = [];
}

function saveLeadsCache() {
    writeJsonFile(leadsCacheFile, cachedLeads);
}

function savePendingOperations() {
    writeJsonFile(
        pendingOperationsFile,
        pendingLeadOperations
    );
}

function isMongoAvailable() {
    return mongoose.connection.readyState === 1;
}

function findCachedLead(id) {
    return cachedLeads.find(
        (lead) => String(lead._id) === String(id)
    );
}
function mergePendingOperationsIntoLeads(databaseLeads) {
    const mergedLeads = databaseLeads.map(lead => ({
        ...lead
    }));

    for (const operation of pendingLeadOperations) {
        const id = String(operation.id);

        if (operation.type === "create") {
            const existingIndex = mergedLeads.findIndex(
                lead => String(lead._id) === id
            );

            const localLead = {
                ...operation.data,
                _id: id
            };

            if (existingIndex >= 0) {
                mergedLeads[existingIndex] = {
                    ...mergedLeads[existingIndex],
                    ...localLead
                };
            } else {
                mergedLeads.unshift(localLead);
            }

        } else if (operation.type === "update") {
            const index = mergedLeads.findIndex(
                lead => String(lead._id) === id
            );

            if (index >= 0) {
                mergedLeads[index] = {
                    ...mergedLeads[index],
                    ...operation.data
                };
            }

        } else if (operation.type === "delete") {
            const index = mergedLeads.findIndex(
                lead => String(lead._id) === id
            );

            if (index >= 0) {
                mergedLeads.splice(index, 1);
            }
        }
    }

    return mergedLeads;
}
function updateCachedLead(lead) {
    const id = String(lead._id);
    const index = cachedLeads.findIndex(
        (item) => String(item._id) === id
    );

    if (index >= 0) {
        cachedLeads[index] = lead;
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


// ---------- AUTOMATIC OFFLINE QUEUE SYNC ----------

let isSyncingOperations = false;



async function syncPendingLeadOperations() {
    if (
        isSyncingOperations ||
        mongoose.connection.readyState !== 1 ||
        pendingLeadOperations.length === 0
    ) {
        return;
    }

    isSyncingOperations = true;

    try {
        while (
            pendingLeadOperations.length > 0 &&
            mongoose.connection.readyState === 1
        ) {
            const operation = pendingLeadOperations[0];

            if (operation.type === "create") {
                const leadData = {
                    ...operation.data,
                    _id: operation.id
                };

                // Preserve original timestamps without conflicting
                // with Mongoose's automatic timestamp updates.
                await Lead.updateOne(
                    { _id: operation.id },
                    { $setOnInsert: leadData },
                    {
                        upsert: true,
                        runValidators: true,
                        timestamps: false
                    }
                );

            } else if (operation.type === "update") {
                const updateData = { ...operation.data };

                delete updateData._id;
                delete updateData.createdAt;
                delete updateData.updatedAt;
                delete updateData.__v;

                const updatedLead = await Lead.findByIdAndUpdate(
                    operation.id,
                    { $set: updateData },
                    {
                        new: true,
                        runValidators: true,
                        timestamps: true
                    }
                );

                if (!updatedLead) {
                    throw new Error(
                        `Lead ${operation.id} was not found during sync.`
                    );
                }

            } else if (operation.type === "delete") {
                await Lead.deleteOne({ _id: operation.id });

            } else {
                throw new Error(
                    `Unknown queued operation: ${operation.type}`
                );
            }

            // Remove only after the database operation succeeds.
            pendingLeadOperations.shift();
            savePendingOperations();

            console.log(
                `Offline operation synced: ${operation.type}`
            );
        }

        if (
            pendingLeadOperations.length === 0 &&
            mongoose.connection.readyState === 1
        ) {
            cachedLeads = await Lead.find()
                .sort({ createdAt: -1 })
                .lean();

            saveLeadsCache();

            console.log(
                "SaleSphere cache refreshed. All queued changes synced."
            );
        }

    } catch (error) {
        console.error(
            "Automatic sync paused:",
            error.message
        );

    } finally {
        isSyncingOperations = false;
    }
}
// Retry queued changes while the database is connected.
setInterval(() => {
    if (
        mongoose.connection.readyState === 1 &&
        pendingLeadOperations.length > 0
    ) {
        syncPendingLeadOperations();
    }
}, 5000);
if (!fs.existsSync(dataFolder)) {
    fs.mkdirSync(dataFolder, { recursive: true });
}
const incidentFile = path.join(dataFolder, "incidents.json");
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

function updateIncidentStatus(incident, status, details) {
    incident.status = status;
    incident.updatedAt = new Date().toISOString();

    addIncidentEvent(incident, status, details);
}


function updateVersionState(status) {
    versionState.status = status;
    versionState.updatedAt = new Date().toISOString();
}

function isDatabaseReady() {
    return mongoose.connection.readyState === 1;
}

// ---------- HOME ----------

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "index.html")
    );
});

// ---------- HEALTH ENDPOINTS ----------

// Application liveness
app.get("/healthz", (req, res) => {
    res.json({
        app: "SaleSphere",
        status: "running",
        time: new Date().toISOString()
    });
});

// Database readiness
app.get("/readyz", (req, res) => {
    const databaseConnected = isDatabaseReady();

    res.status(databaseConnected ? 200 : 503).json({
        app: "SaleSphere",
        database: databaseConnected
            ? "connected"
            : "disconnected",
        ready: databaseConnected
    });
});

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
        versionState.currentVersion === versionState.stableVersion &&
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

        previousVersion: versionState.stableVersion,
        failedVersion: `${versionState.stableVersion}`,

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
        "Controlled bad release selected for the resilience test."
    );

    return res.status(202).json({
        success: true,
        message: "Bad release injected. Automatic recovery has started.",
        incidentId: incident.id,
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

    // Stage 1: Detect
    if (!incident.detectedAt) {
        incident.detectedAt = new Date().toISOString();

        incident.detectionTimeMs =
            Date.now() - new Date(incident.startedAt).getTime();

        incident.status = "detected";

        addIncidentEvent(
            incident,
            "Detected",
            "Candidate release failed the version health gate."
        );

        updateVersionState("detected");
        return;
    }

    // Stage 2: Diagnose
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

    // Stage 3: Recover
    if (!incident.actionAt) {
        incident.actionAt = new Date().toISOString();

        versionState.currentVersion = incident.previousVersion;
        incident.status = "rollback_in_progress";

        addIncidentEvent(
            incident,
            "Action taken",
            `Restored the stable release ${incident.previousVersion} in the demo version manager.`
        );

        updateVersionState("verifying");
        return;
    }

    // Stage 4: Verify
    if (!incident.recoveredAt) {
        const versionRestored =
            versionState.currentVersion === incident.previousVersion;

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
            "Stable version restored and database readiness check passed."
        );

        versionState.activeIncidentId = null;

        updateVersionState("healthy");
        saveIncidents();
    }
}, 1000);

// ---------- END SELF-HEALING VERSION MANAGER ----------

// ---------- LEAD MANAGEMENT ----------

// Validate follow-up date
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

// Create lead


app.post("/api/leads", async (req, res) => {
    try {
        console.log("CREATE LEAD CHECK:", {
            mongoReadyState: mongoose.connection.readyState,
            database: mongoose.connection.name,
            collection: Lead.collection.name
        });

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

        const leadData = {
            customerName: customerName.trim(),
            companyName: companyName.trim(),
            email: email?.trim().toLowerCase() || "",
            phone: phone?.trim() || "",
            interest: interest.trim(),
            status: status || "New",
            followUpDate: prepareFollowUpDate(followUpDate),
            notes: notes?.trim() || ""
        };

        // Save directly to MongoDB when connected
        if (mongoose.connection.readyState === 1) {
            const lead = await Lead.create(leadData);

            updateCachedLead(lead.toObject());

            return res.status(201).json({
                message: "Lead created successfully.",
                lead,
                pendingSync: false
            });
        }

        // Save locally and queue for automatic sync when offline
        const id = new mongoose.Types.ObjectId().toString();

        const localLead = {
            ...leadData,
            _id: id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            __v: 0
        };

        updateCachedLead(localLead);

        queueLeadOperation({
            type: "create",
            id,
            data: localLead
        });

        return res.status(202).json({
            message: "Lead saved locally. It will sync automatically when the database reconnects.",
            lead: localLead,
            pendingSync: true
        });
    } catch (error) {
        console.error("Create lead failed:", error);

        return res.status(500).json({
            error: error.message || "Unable to create lead."
        });
    }
});


// Get leads

 // Get leads with automatic local-cache fallback
app.get("/api/leads", async (req, res) => {
    try {
        if (mongoose.connection.readyState === 1) {
            const databaseLeads = await Lead.find()
                .sort({ createdAt: -1 })
                .lean();

            cachedLeads = mergePendingOperationsIntoLeads(
                databaseLeads
            );

            saveLeadsCache();

            res.set("X-Data-Source", "mongodb");
            return res.json(cachedLeads);
        }

        res.set("X-Data-Source", "cache");
        return res.json(cachedLeads);

    } catch (error) {
        console.error(
            "Lead database read failed:",
            error.message
        );

        res.set("X-Data-Source", "cache");

        return res.json(cachedLeads);
    }
});
// Update lead

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
            email: email?.trim().toLowerCase() || "",
            phone: phone?.trim() || "",
            interest: interest.trim(),
            status: status || "New",
            followUpDate: prepareFollowUpDate(followUpDate),
            notes: notes?.trim() || ""
        };

        // Normal database update
        if (mongoose.connection.readyState === 1) {
            const updatedLead = await Lead.findByIdAndUpdate(
                req.params.id,
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
        }

        // Offline update: modify the cached lead
        const existingLead = findCachedLead(req.params.id);

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
            id: String(req.params.id),
            data: updatedData
        });

        return res.status(202).json({
            message: "Lead updated locally. Changes will sync automatically.",
            lead: updatedLead,
            pendingSync: true
        });
    } catch (error) {
        return res.status(400).json({
            error: error.message || "Unable to update lead."
        });
    }
});

       

// Add activity to a lead
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

// Delete lead

app.delete("/api/leads/:id", async (req, res) => {
    try {
        const leadId = String(req.params.id);

        // Normal delete when MongoDB is connected
        if (mongoose.connection.readyState === 1) {
            const deletedLead = await Lead.findByIdAndDelete(leadId);

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
        }

        // Offline delete using the local cache
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
    } catch (error) {
        return res.status(400).json({
            error: error.message || "Unable to delete lead."
        });
    }
});



app.get("/api/system/data-status", async (req, res) => {
    const databaseConnected =
        mongoose.connection.readyState === 1;

    if (databaseConnected) {
        try {
            const databaseLeads = await Lead.find()
                .sort({ createdAt: -1 })
                .lean();

            cachedLeads = mergePendingOperationsIntoLeads(
                databaseLeads
            );

            saveLeadsCache();

        } catch (error) {
            console.error(
                "Status check could not refresh cache:",
                error.message
            );
        }
    }

    const connected =
        mongoose.connection.readyState === 1;

    res.json({
        app: "SaleSphere",
        database: connected ? "Connected" : "Disconnected",
        databaseConnected: connected,
        cacheAvailable: Array.isArray(cachedLeads),
        cachedLeadCount: cachedLeads.length,
        pendingSyncCount: pendingLeadOperations.length,
        recoveryMode: !connected
            ? "Recovering"
            : pendingLeadOperations.length > 0
                ? "Syncing"
                : "Healthy"
    });
});




app.post("/api/system/database/chaos", async (req, res) => {
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

    if (mongoose.connection.readyState !== 1) {
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
        events: []
    };

    incidents.push(incident);

    addIncidentEvent(
        incident,
        "Detected",
        "Controlled MongoDB connection failure requested from the local demo."
    );

    addIncidentEvent(
        incident,
        "Diagnosing",
        "Checking MongoDB connection state and starting the recovery policy."
    );

    chaosModeUntil = Date.now() + 8000;

    addIncidentEvent(
        incident,
        "Recovering",
        "SaleSphere will retry the database connection automatically."
    );

    try {
        await mongoose.disconnect();

        return res.json({
            message: "Controlled failure injected.",
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

        return res.status(500).json({
            error: "Failure injection could not complete.",
            incidentId: incident.id
        });
    }
});

       

// ---------- START SERVER ----------


 // ---------- START SERVER + AUTO RECONNECT ----------

const mongoURI =
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/salesphere";

    console.log("Atlas URI loaded:", !!process.env.MONGODB_URI);
console.log("URI starts with Atlas:", process.env.MONGODB_URI?.startsWith("mongodb+srv://"));
console.log("Using local fallback:", mongoURI.startsWith("mongodb://127.0.0.1"));

let reconnectTimer = null;
let reconnectDelay = 1000;
let chaosModeUntil = 0;
let activeMongoIncidentId = null;
let isConnecting = false;

function scheduleReconnect() {
    if (reconnectTimer) return;

    const delay = Math.max(
    reconnectDelay,
    chaosModeUntil - Date.now()
);

    console.log(
        `SaleSphere will retry MongoDB connection in ${delay / 1000} seconds.`
    );

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectMongoDB();
    }, delay);

    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

async function connectMongoDB() {
    if (
        isConnecting ||
        mongoose.connection.readyState === 1
    ) {
        return;
    }

    isConnecting = true;

    try {
        await mongoose.connect(mongoURI, {
            serverSelectionTimeoutMS: 5000
        });

        console.log("Connected database:", mongoose.connection.name);
console.log("Connected host:", mongoose.connection.host);
        reconnectDelay = 1000;
console.log("MongoDB connected successfully");

// Sync offline changes before verifying recovery
if (pendingLeadOperations.length > 0) {
    await syncPendingLeadOperations();
}

// Verify the actual database connection and recovery
if (activeMongoIncidentId) {
    const incident = incidents.find(
        (item) => item.id === activeMongoIncidentId
    );

    if (incident) {
        try {
            await Lead.countDocuments();

            if (pendingLeadOperations.length === 0) {
                updateIncidentStatus(
                    incident,
                    "Verifying",
                    "MongoDB reconnected. Database read verification succeeded."
                );

                incident.recoveryTimeMs =
                    Date.now() -
                    new Date(incident.createdAt).getTime();

                updateIncidentStatus(
                    incident,
                    "Recovered",
                    "Database verification passed and all queued lead operations are synced."
                );

                console.log(
                    "SELF-HEALING VERIFIED: SaleSphere recovered successfully."
                );

                activeMongoIncidentId = null;
            } else {
                console.log(
                    "MongoDB is connected"
                );
            }
        } catch (verificationError) {
            console.error(
                "Recovery verification failed:",
                verificationError.message
            );

            updateIncidentStatus(
                incident,
                "Verification Failed",
                verificationError.message
            );
        }
    }
}
    } catch (error) {
        console.error(
            "MongoDB connection failed:",
            error.message
        );

        scheduleReconnect();
    } finally {
        isConnecting = false;
    }
}

mongoose.connection.on("disconnected", () => {
    console.warn("MongoDB disconnected. recovery started.");
    scheduleReconnect();
});

mongoose.connection.on("error", (error) => {
    console.error("MongoDB connection error:", error.message);
});

// Start the web server even when MongoDB is unavailable.
app.listen(PORT, () => {
    console.log(`SaleSphere running at http://localhost:${PORT}`);
    connectMongoDB();
});
