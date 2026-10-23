const mongoose = require("mongoose");

const activitySchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ["Call", "Email", "Meeting", "Note", "Other"],
        default: "Note"
    },
    description: {
        type: String,
        required: true,
        trim: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const leadSchema = new mongoose.Schema(
    {
        customerName: {
            type: String,
            required: true,
            trim: true
        },
        companyName: {
            type: String,
            required: true,
            trim: true
        },
        email: {
            type: String,
            trim: true,
            lowercase: true
        },
        phone: {
            type: String,
            trim: true,
            default: ""
        },
        interest: {
            type: String,
            required: true,
            trim: true
        },
        status: {
            type: String,
            enum: ["New", "Contacted", "Negotiation", "Won", "Lost"],
            default: "New"
        },
        followUpDate: {
            type: Date,
            default: null
        },
        notes: {
            type: String,
            trim: true,
            default: ""
        },
        activities: {
            type: [activitySchema],
            default: []
        }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Lead", leadSchema);