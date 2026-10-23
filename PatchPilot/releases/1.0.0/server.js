
    const express = require("express");
    const mongoose = require("mongoose");
    const path = require("path");
        require("dotenv").config();

    const Lead = require("./models/Lead");

    const app = express();
    
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
    
    // Application health
    
app.get("/healthz", (req, res) => {
    if (process.env.PATCHPILOT_TEST_FAILURE === "1") {
        return res.status(503).json({
            status: "unhealthy",
            version: require("./package.json").version,
            message: "Candidate release health check failed"
        });
    }

    return res.status(200).json({
        status: "healthy",
        version: require("./package.json").version
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
