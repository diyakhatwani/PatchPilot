
import React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";

const API = "/api/leads";
const STABLE_VERSION = "1.0.0";
const CANDIDATE_VERSION = "1.1.0";

const EMPTY_LEAD = {
  customerName: "",
  companyName: "",
  email: "",
  phone: "",
  interest: "",
  status: "New",
  followUpDate: "",
};

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: "▦" },
  { id: "leads", label: "Customer Leads", icon: "♙" },
  { id: "followups", label: "Follow-ups", icon: "◷" },
  { id: "pipeline", label: "Sales Pipeline", icon: "▥" },
  { id: "health", label: "System Health", icon: "♥" },
  { id: "versions", label: "Version Manager", icon: "↻" },
  { id: "incidents", label: "Incidents", icon: "⚠" },
];

function getErrorMessage(data, fallback) {
  return data?.message || data?.error || fallback;
}

async function readResponse(response) {
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(getErrorMessage(data, "Request failed."));
  }

  return data;
}

function normaliseIncidents(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.incidents)) return data.incidents;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function StatusBadge({ value }) {
  const status = String(value || "Unknown");
  const normalised = status.toLowerCase().replace(/[\s_]+/g, "-");

  let tone = "neutral";

  if (
    ["healthy", "recovered", "delivered", "confirmed", "active", "success"].some(
      (item) => normalised.includes(item)
    )
  ) {
    tone = "success";
  } else if (
    ["failed", "error", "critical", "cancelled", "unhealthy"].some(
      (item) => normalised.includes(item)
    )
  ) {
    tone = "danger";
  } else if (
    ["pending", "recovering", "shipped", "progress", "warning", "restoring"].some(
      (item) => normalised.includes(item)
    )
  ) {
    tone = "warning";
  } else if (["new", "qualified"].includes(normalised)) {
    tone = "info";
  }

  return (
    <span className={`status-badge status-${tone}`}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function PageHeader({ title, subtitle, action }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action && <div className="page-header-action">{action}</div>}
    </div>
  );
}

function StatCard({ label, value, detail, icon, tone = "blue" }) {
  return (
    <article className="stat-card">
      <div className={`stat-icon ${tone}`}>{icon}</div>
      <div>
        <p>{label}</p>
        <h2>{value}</h2>
        {detail && <span>{detail}</span>}
      </div>
    </article>
  );
}

function EmptyState({ title, description }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">◷</div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

function LeadForm({ initialLead, onSave, onCancel, busy }) {
  const [form, setForm] = useState(() => ({
    ...EMPTY_LEAD,
    ...(initialLead || {}),
    followUpDate: initialLead?.followUpDate
      ? String(initialLead.followUpDate).slice(0, 10)
      : "",
  }));

  const updateField = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  };

  const submit = (event) => {
    event.preventDefault();
    onSave(form);
  };

  return (
    <form className="lead-form" onSubmit={submit}>
      <div className="form-grid">
        <label>
          Customer Name *
          <input
            name="customerName"
            value={form.customerName}
            onChange={updateField}
            placeholder="Enter customer name"
            required
          />
        </label>

        <label>
          Company Name
          <input
            name="companyName"
            value={form.companyName}
            onChange={updateField}
            placeholder="Enter company name"
          />
        </label>

        <label>
          Email
          <input
            name="email"
            type="email"
            value={form.email}
            onChange={updateField}
            placeholder="customer@example.com"
          />
        </label>

        <label>
          Phone
          <input
            name="phone"
            value={form.phone}
            onChange={updateField}
            placeholder="Enter phone number"
          />
        </label>

        <label>
          Product / Interest
          <input
            name="interest"
            value={form.interest}
            onChange={updateField}
            placeholder="e.g. 10 laptops"
          />
        </label>

        <label>
          Lead Status
          <select name="status" value={form.status} onChange={updateField}>
            {["New", "Contacted", "Qualified", "Proposal", "Won", "Lost"].map(
              (status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              )
            )}
          </select>
        </label>

        <label>
          Follow-up Date
          <input
            name="followUpDate"
            type="date"
            value={form.followUpDate}
            onChange={updateField}
          />
        </label>
      </div>

      <div className="form-actions">
        <button
          className="btn btn-light"
          type="button"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Saving..." : initialLead ? "Save Changes" : "Add Lead"}
        </button>
      </div>
    </form>
  );
}

function App() {
  const [activePage, setActivePage] = useState("dashboard");
  const [leads, setLeads] = useState([]);
  const [health, setHealth] = useState({
    app: "Checking",
    database: "Checking",
  });
  const [version, setVersion] = useState(null);
  const [incidents, setIncidents] = useState([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [leadModal, setLeadModal] = useState(null);
  const [profileLead, setProfileLead] = useState(null);
  const [activities, setActivities] = useState([]);
  const [activityText, setActivityText] = useState("");
  const [activityBusy, setActivityBusy] = useState(false);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [toast, setToast] = useState("");

  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState(
    "Ready to run a controlled self-healing test."
  );
  const [lastRecoveryResult, setLastRecoveryResult] = useState("");

  const [recoveryModal, setRecoveryModal] = useState(false);
  const [updateModal, setUpdateModal] = useState(false);
  const [recoveryStep, setRecoveryStep] = useState(0);
  const [recoveryIncident, setRecoveryIncident] = useState(null);
  const [recoveryPhase, setRecoveryPhase] = useState("idle");
  const [recoveryProgress, setRecoveryProgress] = useState(0);

  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3500);
  }, []);

  const loadLeads = useCallback(async () => {
    const response = await fetch(API);
    const data = await readResponse(response);
    setLeads(Array.isArray(data) ? data : data?.leads || []);
  }, []);

  const checkHealth = useCallback(async () => {
    const [appResult, dbResult] = await Promise.allSettled([
      fetch("/healthz"),
      fetch("/readyz"),
    ]);

    setHealth({
      app:
        appResult.status === "fulfilled" && appResult.value.ok
          ? "Healthy"
          : "Unhealthy",
      database:
        dbResult.status === "fulfilled" && dbResult.value.ok
          ? "Connected"
          : "Unavailable",
    });
  }, []);

  const loadSystemInfo = useCallback(async () => {
    const [statusResult, incidentResult] = await Promise.allSettled([
      fetch("/api/system/version"),
      fetch("/api/system/incidents"),
    ]);

    if (statusResult.status === "fulfilled" && statusResult.value.ok) {
      const data = await statusResult.value.json().catch(() => null);

      if (data) {
        setVersion((previous) => ({
          ...previous,
          ...data,
          currentVersion: data.currentVersion || STABLE_VERSION,
          stableVersion: STABLE_VERSION,
          status: data.status || "unknown",
        }));
      }
    }

    if (incidentResult.status === "fulfilled" && incidentResult.value.ok) {
      const data = await incidentResult.value.json().catch(() => []);
      setIncidents(normaliseIncidents(data));
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.allSettled([loadLeads(), checkHealth(), loadSystemInfo()]);
  }, [loadLeads, checkHealth, loadSystemInfo]);

  useEffect(() => {
    let mounted = true;

    const initialise = async () => {
      setLoading(true);

      try {
        await refreshAll();
      } catch (error) {
        if (mounted) notify(error.message || "Unable to load dashboard.");
      } finally {
        if (mounted) setLoading(false);
      }
    };

    initialise();

    const interval = window.setInterval(() => {
      refreshAll();
    }, 10000);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [refreshAll, notify]);

  const filteredLeads = useMemo(() => {
    const query = search.trim().toLowerCase();

    return leads.filter((lead) => {
      const matchesSearch =
        !query ||
        [
          lead.customerName,
          lead.companyName,
          lead.email,
          lead.phone,
          lead.interest,
        ].some((value) => String(value || "").toLowerCase().includes(query));

      const matchesStatus =
        statusFilter === "All" || lead.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [leads, search, statusFilter]);

  const totalLeads = leads.length;
  const wonLeads = leads.filter((lead) => lead.status === "Won").length;
  const activeLeads = leads.filter(
    (lead) => !["Won", "Lost"].includes(lead.status)
  ).length;

  const today = new Date().toISOString().slice(0, 10);

  const dueFollowUps = leads.filter((lead) => {
    if (!lead.followUpDate || ["Won", "Lost"].includes(lead.status)) {
      return false;
    }

    return String(lead.followUpDate).slice(0, 10) <= today;
  });

  const openAddLead = () => {
    setLeadModal({ mode: "add", lead: null });
  };

  const openEditLead = (lead) => {
    setLeadModal({ mode: "edit", lead });
  };

  const saveLead = async (formData) => {
    setSaving(true);

    try {
      const editingLead = leadModal?.mode === "edit" ? leadModal.lead : null;
      const url = editingLead ? `${API}/${editingLead._id}` : API;

      const response = await fetch(url, {
        method: editingLead ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      await readResponse(response);
      setLeadModal(null);
      await loadLeads();
      notify(
        editingLead
          ? "Lead updated successfully."
          : "Lead added successfully."
      );
    } catch (error) {
      notify(error.message || "Could not save lead.");
    } finally {
      setSaving(false);
    }
  };

  const deleteLead = async (lead) => {
    if (
      !window.confirm(
        `Delete lead for ${lead.customerName || "this customer"}?`
      )
    ) {
      return;
    }

    try {
      const response = await fetch(`${API}/${lead._id}`, {
        method: "DELETE",
      });

      await readResponse(response);
      setLeads((current) =>
        current.filter((item) => item._id !== lead._id)
      );

      if (profileLead?._id === lead._id) {
        setProfileLead(null);
      }

      notify("Lead deleted successfully.");
    } catch (error) {
      notify(error.message || "Could not delete lead.");
    }
  };

  const openProfile = async (lead) => {
    setProfileLead(lead);
    setActivities([]);
    setActivityText("");

    try {
      const response = await fetch(`${API}/${lead._id}/activities`);
      if (response.ok) {
        const data = await response.json().catch(() => []);
        setActivities(
          Array.isArray(data) ? data : data?.activities || []
        );
      }
    } catch {
      // Keep the customer profile usable if activity history is unavailable.
    }
  };

  const addActivity = async (event) => {
    event.preventDefault();

    if (!profileLead || !activityText.trim()) return;

    setActivityBusy(true);

    try {
      const response = await fetch(`${API}/${profileLead._id}/activities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: activityText.trim(),
          text: activityText.trim(),
        }),
      });

      const data = await readResponse(response);
      const activity = data?.activity || data;

      setActivities((current) => [activity, ...current]);
      setActivityText("");
      notify("Activity added.");
    } catch (error) {
      notify(error.message || "Could not add activity.");
    } finally {
      setActivityBusy(false);
    }
  };

  const runRecoveryTest = useCallback(async () => {
    if (recoveryBusy) return;

    const previousIds = new Set(
      incidents.map((item) => String(item.id || item._id))
    );

    const wait = (ms) =>
      new Promise((resolve) => window.setTimeout(resolve, ms));

    setRecoveryBusy(true);
    setRecoveryModal(true);
    setRecoveryStep(0);
    setRecoveryIncident(null);
    setRecoveryPhase("installing");
    setRecoveryProgress(0);
    setLastRecoveryResult("installing");
    setRecoveryMessage("Preparing candidate release 1.1.0...");

    try {
      for (let i = 0; i < 10; i += 1) {
        await wait(300);
        setRecoveryProgress((current) =>
          Math.min(current + 2, 20)
        );
      }

      setRecoveryPhase("activating");
      setRecoveryProgress(30);
      setRecoveryMessage(
        `Installation checks complete. Activating candidate release ${CANDIDATE_VERSION} and monitoring its health...`
      );
      setLastRecoveryResult("");

      const response = await fetch("/api/system/version/chaos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const result = await response.json().catch(() => ({}));

      let targetId =
        result?.incidentId ||
        result?.incident?.id ||
        result?.incident?._id ||
        null;

      if (!response.ok && response.status !== 409) {
        throw new Error(
          result?.message ||
            result?.error ||
            `Update could not start (HTTP ${response.status}).`
        );
      }

      if (response.status === 409) {
        setRecoveryMessage(
          "A recovery is already running. Reconnecting to its live progress..."
        );

        const existingResponse = await fetch("/api/system/incidents");

        if (existingResponse.ok) {
          const existingData = await existingResponse.json().catch(() => ({}));
          const existingList = normaliseIncidents(existingData);
          setIncidents(existingList);

          const active = existingList.find(
            (item) =>
              !["recovered", "failed", "error"].includes(
                String(item.status || "").toLowerCase()
              )
          );

          targetId = active?.id || active?._id || targetId;
        }

        if (!targetId) {
          throw new Error(
            result?.error ||
              "A recovery is already running, but its incident could not be found. Refresh the page and try again."
          );
        }
      }

      setRecoveryStep(1);
      setRecoveryProgress(40);
      setRecoveryPhase("failed");
      setRecoveryMessage(
        `Candidate release ${CANDIDATE_VERSION} activated. The watchdog is checking its health...`
      );

      let recoveredIncident = null;
      let latestVersion = null;
      let latestIncident = null;

      for (let attempt = 0; attempt < 30; attempt += 1) {
        const [versionResult, incidentsResult] = await Promise.allSettled([
          fetch("/api/system/version"),
          fetch("/api/system/incidents"),
        ]);

        if (
          versionResult.status === "fulfilled" &&
          versionResult.value.ok
        ) {
          latestVersion = await versionResult.value.json().catch(() => null);

          if (latestVersion) {
            setVersion({
              ...latestVersion,
              stableVersion: STABLE_VERSION,
            });

            if (latestVersion.status === "failed") {
              setRecoveryPhase("failed");
              setRecoveryProgress((current) =>
                Math.max(current, 45)
              );
              setRecoveryMessage(
                `Failure detected in candidate release ${CANDIDATE_VERSION}. Automatic recovery is being prepared...`
              );
            } else if (latestVersion.status === "detected") {
              setRecoveryPhase("diagnosing");
              setRecoveryProgress((current) =>
                Math.max(current, 55)
              );
              setRecoveryStep((current) => Math.max(current, 2));
              setRecoveryMessage(
                "Failure detected. The watchdog is diagnosing the root cause..."
              );
            } else if (latestVersion.status === "recovering") {
              setRecoveryPhase("rollback");
              setRecoveryProgress((current) =>
                Math.max(current, 72)
              );
              setRecoveryStep((current) => Math.max(current, 3));
              setRecoveryMessage(
                `Diagnosis complete. Rolling back to stable release ${STABLE_VERSION}...`
              );
            } else if (latestVersion.status === "verifying") {
              setRecoveryPhase("verifying");
              setRecoveryProgress((current) =>
                Math.max(current, 90)
              );
              setRecoveryStep((current) => Math.max(current, 4));
              setRecoveryMessage(
                `Stable release ${STABLE_VERSION} restored. Verifying application health...`
              );
            }
          }
        }

        if (
          incidentsResult.status === "fulfilled" &&
          incidentsResult.value.ok
        ) {
          const data = await incidentsResult.value.json().catch(() => ({}));
          const list = normaliseIncidents(data);
          setIncidents(list);

          const matched = targetId
            ? list.find(
                (item) => String(item.id || item._id) === String(targetId)
              )
            : null;

          const newIncident =
            matched ||
            list.find(
              (item) => !previousIds.has(String(item.id || item._id))
            ) ||
            null;

          if (newIncident) {
            latestIncident = newIncident;
            setRecoveryIncident(newIncident);

            if (newIncident.detectedAt) {
              setRecoveryStep((current) => Math.max(current, 2));
              setRecoveryPhase("diagnosing");
              setRecoveryProgress((current) =>
                Math.max(current, 55)
              );
              setRecoveryMessage(
                "Failure detected. The watchdog is diagnosing the incident..."
              );
            }

            if (newIncident.diagnosedAt) {
              setRecoveryStep((current) => Math.max(current, 3));
              setRecoveryPhase("rollback");
              setRecoveryProgress((current) =>
                Math.max(current, 72)
              );
              setRecoveryMessage(
                `Diagnosis complete. Restoring stable release ${STABLE_VERSION}...`
              );
            }

            if (newIncident.actionAt) {
              setRecoveryStep((current) => Math.max(current, 4));
              setRecoveryPhase("verifying");
              setRecoveryProgress((current) =>
                Math.max(current, 90)
              );
              setRecoveryMessage(
                `Rollback complete. Verifying stable release ${STABLE_VERSION}...`
              );
            }

            if (
              String(newIncident.status || "").toLowerCase() === "recovered"
            ) {
              recoveredIncident = newIncident;
              break;
            }

            if (
              ["failed", "error"].includes(
                String(newIncident.status || "").toLowerCase()
              )
            ) {
              throw new Error(
                newIncident.error ||
                  "The watchdog marked this recovery as failed. Check the incident details."
              );
            }
          }
        }

        await wait(600);
      }

      await Promise.allSettled([checkHealth(), loadSystemInfo()]);

      if (recoveredIncident) {
        const healthResponse = await fetch("/api/system/version/health");
        const healthResult = await healthResponse.json().catch(() => ({}));

        if (!healthResponse.ok || healthResult?.healthy !== true) {
          setRecoveryPhase("warning");
          setLastRecoveryResult("warning");
          setRecoveryMessage(
            `The rollback to ${STABLE_VERSION} was reported, but final health verification did not pass. ${
              healthResult?.databaseReady === false
                ? "The database is not ready, so the CRM is not fully healthy yet."
                : "Check System Health for details."
            }`
          );
          return;
        }

        setVersion((previous) => ({
          ...previous,
          ...(latestVersion || {}),
          currentVersion: STABLE_VERSION,
          stableVersion: STABLE_VERSION,
          status: "healthy",
        }));

        const time =
          typeof recoveredIncident.recoveryTimeMs === "number"
            ? ` Recovery time: ${recoveredIncident.recoveryTimeMs} ms.`
            : "";

        setRecoveryStep(5);
        setRecoveryProgress(100);
        setRecoveryPhase("recovered");
        setRecoveryMessage(
          `Recovery verified. Failed version: ${CANDIDATE_VERSION}. Restored version: ${STABLE_VERSION}.${time}`
        );
        setLastRecoveryResult("success");
        notify("Self-healing test recovered successfully.");
      } else {
        setRecoveryPhase("warning");
        setRecoveryProgress((current) => Math.max(current, 90));
        setLastRecoveryResult("warning");
        setRecoveryMessage(
          `The watchdog did not confirm recovery within 18 seconds. ${
            latestIncident?.status
              ? `Latest incident status: ${latestIncident.status}.`
              : "No matching incident was returned by the backend."
          } Check System Health and the backend terminal before retrying.`
        );
      }
    } catch (error) {
      setRecoveryPhase("error");
      setLastRecoveryResult("error");
      setRecoveryMessage(
        error.message || "Could not complete the self-healing test."
      );
    } finally {
      setRecoveryBusy(false);
    }
  }, [recoveryBusy, incidents, checkHealth, loadSystemInfo, notify]);

  // Display the candidate while the test runs and the stable version after recovery.
  const currentVersion = recoveryBusy
    ? CANDIDATE_VERSION
    : version?.status === "healthy"
      ? STABLE_VERSION
      : version?.currentVersion || STABLE_VERSION;

  const stableVersion = STABLE_VERSION;
  const systemStatus = version?.status || "Unknown";

  const pageTitle = {
    dashboard: "Dashboard",
    leads: "Customer Leads",
    followups: "Follow-ups",
    pipeline: "Sales Pipeline",
    health: "System Health",
    versions: "Version Manager",
    incidents: "Incidents",
  }[activePage];

  return (
    <div className={`app-shell ${recoveryBusy ? "update-in-progress" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">S</div>
          <div>
            <h2>SaleSphere</h2>
            <span>CRM & Self-Healing</span>
          </div>
        </div>

        <div className="sidebar-label">WORKSPACE</div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${activePage === item.id ? "active" : ""}`}
              onClick={() => setActivePage(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.id === "incidents" && incidents.length > 0 && (
                <span className="nav-count">{incidents.length}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-status">
            <span
              className={`status-dot ${
                health.app === "Healthy" ? "dot-green" : "dot-red"
              }`}
            />
            <div>
              <strong>System Monitor</strong>
              <span>{health.app}</span>
            </div>
          </div>
          <p>SaleSphere · Self-Healing Demo</p>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="breadcrumb">Workspace / </span>
            <strong>{pageTitle}</strong>
          </div>

          <div className="topbar-actions">
            <span className="topbar-version">Version {currentVersion}</span>
            <button
              className="btn btn-primary"
              type="button"
              onClick={openAddLead}
            >
              + Add Lead
            </button>
          </div>
        </header>

        <div className="page-content">
          {loading && (
            <div className="notice" role="status">
              Loading SaleSphere data...
            </div>
          )}

          {activePage === "dashboard" && (
            <>
              <PageHeader
                title="Welcome to SaleSphere"
                subtitle="Track your leads, manage customer relationships and monitor system reliability."
                action={
                  <button
                    className="btn btn-light"
                    onClick={() =>
                      refreshAll().then(() => notify("Dashboard refreshed."))
                    }
                  >
                    ↻ Refresh
                  </button>
                }
              />

              <div className="stats-grid">
                <StatCard
                  label="Total Leads"
                  value={totalLeads}
                  detail="All customer records"
                  icon="♙"
                />
                <StatCard
                  label="Active Leads"
                  value={activeLeads}
                  detail="Leads in progress"
                  icon="◎"
                  tone="purple"
                />
                <StatCard
                  label="Follow-ups Due"
                  value={dueFollowUps.length}
                  detail="Due today or earlier"
                  icon="◷"
                  tone="orange"
                />
                <StatCard
                  label="Deals Won"
                  value={wonLeads}
                  detail="Successfully converted"
                  icon="✓"
                  tone="green"
                />
              </div>

              <div className="dashboard-grid section-gap">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Recent Leads</h2>
                      <p>Your latest customer records</p>
                    </div>
                    <button
                      className="btn btn-light"
                      onClick={() => setActivePage("leads")}
                    >
                      View all
                    </button>
                  </div>

                  {leads.length === 0 ? (
                    <EmptyState
                      title="No leads yet"
                      description="Add your first customer lead to get started."
                    />
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Customer</th>
                            <th>Company</th>
                            <th>Interest</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...leads].slice(-5).reverse().map((lead) => (
                            <tr key={lead._id}>
                              <td>
                                <button
                                  className="table-link"
                                  onClick={() => openProfile(lead)}
                                >
                                  {lead.customerName}
                                </button>
                              </td>
                              <td>{lead.companyName || "—"}</td>
                              <td>{lead.interest || "—"}</td>
                              <td><StatusBadge value={lead.status} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>System Overview</h2>
                      <p>Current application status</p>
                    </div>
                    <StatusBadge value={systemStatus} />
                  </div>

                  <div className="system-overview-row">
                    <span>Application</span>
                    <StatusBadge value={health.app} />
                  </div>
                  <div className="system-overview-row">
                    <span>Database</span>
                    <StatusBadge value={health.database} />
                  </div>
                  <div className="system-overview-row">
                    <span>Current Version</span>
                    <strong>{currentVersion}</strong>
                  </div>
                  <div className="system-overview-row">
                    <span>Stable Version</span>
                    <strong>{stableVersion}</strong>
                  </div>

                  <button
                    className="btn btn-primary full-width section-gap"
                    onClick={() => setActivePage("versions")}
                  >
                    Open Self-Healing Monitor
                  </button>
                </section>
              </div>

              <section className="panel section-gap">
                <div className="panel-heading">
                  <div>
                    <h2>Reliability Monitor</h2>
                    <p>Controlled recovery test and incident tracking</p>
                  </div>
                  <StatusBadge value={health.app} />
                </div>
                <p className="muted-text">
                  SaleSphere can request a controlled release failure from the
                  backend and monitor whether the watchdog restores the configured
                  stable version.
                </p>
                <button
                  className="btn btn-primary"
                  onClick={() => setActivePage("versions")}
                >
                  Go to Version Manager →
                </button>
              </section>
            </>
          )}

          {activePage === "leads" && (
            <>
              <PageHeader
                title="Customer Leads"
                subtitle="Create, search, update and manage your customer records."
                action={
                  <button className="btn btn-primary" onClick={openAddLead}>
                    + Add New Lead
                  </button>
                }
              />

              <section className="panel">
                <div className="toolbar">
                  <input
                    className="search-input"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search customer, company, email..."
                  />
                  <select
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value)}
                  >
                    {[
                      "All",
                      "New",
                      "Contacted",
                      "Qualified",
                      "Proposal",
                      "Won",
                      "Lost",
                    ].map((status) => (
                      <option key={status}>{status}</option>
                    ))}
                  </select>
                  <span className="results-count">
                    {filteredLeads.length} results
                  </span>
                </div>

                {filteredLeads.length === 0 ? (
                  <EmptyState
                    title="No matching leads"
                    description="Try another search or add a new lead."
                  />
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Customer</th>
                          <th>Company</th>
                          <th>Contact</th>
                          <th>Interest</th>
                          <th>Status</th>
                          <th>Follow-up</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredLeads.map((lead) => (
                          <tr key={lead._id}>
                            <td>
                              <button
                                className="table-link"
                                onClick={() => openProfile(lead)}
                              >
                                {lead.customerName}
                              </button>
                            </td>
                            <td>{lead.companyName || "—"}</td>
                            <td>
                              <div>{lead.email || "—"}</div>
                              <small>{lead.phone || ""}</small>
                            </td>
                            <td>{lead.interest || "—"}</td>
                            <td><StatusBadge value={lead.status} /></td>
                            <td>
                              {lead.followUpDate
                                ? String(lead.followUpDate).slice(0, 10)
                                : "—"}
                            </td>
                            <td>
                              <div className="table-actions">
                                <button
                                  className="btn btn-small btn-light"
                                  onClick={() => openEditLead(lead)}
                                >
                                  Edit
                                </button>
                                <button
                                  className="btn btn-small btn-danger"
                                  onClick={() => deleteLead(lead)}
                                >
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}

          {activePage === "followups" && (
            <>
              <PageHeader
                title="Follow-ups"
                subtitle="Review customer follow-ups that are due or coming up."
                action={
                  <button className="btn btn-light" onClick={() => loadLeads()}>
                    ↻ Refresh
                  </button>
                }
              />

              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Due and Upcoming Follow-ups</h2>
                    <p>Sorted by follow-up date</p>
                  </div>
                  <span className="results-count">
                    {dueFollowUps.length} due
                  </span>
                </div>

                {dueFollowUps.length === 0 ? (
                  <EmptyState
                    title="You're all caught up"
                    description="There are no overdue or due follow-ups."
                  />
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Customer</th>
                          <th>Company</th>
                          <th>Phone</th>
                          <th>Follow-up Date</th>
                          <th>Status</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...dueFollowUps]
                          .sort((a, b) =>
                            String(a.followUpDate).localeCompare(
                              String(b.followUpDate)
                            )
                          )
                          .map((lead) => (
                            <tr key={lead._id}>
                              <td>{lead.customerName}</td>
                              <td>{lead.companyName || "—"}</td>
                              <td>{lead.phone || "—"}</td>
                              <td>{String(lead.followUpDate).slice(0, 10)}</td>
                              <td>
                                <StatusBadge
                                  value={
                                    String(lead.followUpDate).slice(0, 10) < today
                                      ? "Overdue"
                                      : "Due today"
                                  }
                                />
                              </td>
                              <td>
                                <button
                                  className="btn btn-small btn-light"
                                  onClick={() => openEditLead(lead)}
                                >
                                  Update
                                </button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}

          {activePage === "pipeline" && (
            <>
              <PageHeader
                title="Sales Pipeline"
                subtitle="Understand how customer leads move through the sales process."
              />

              <div className="pipeline-grid">
                {[
                  { status: "New", color: "blue" },
                  { status: "Contacted", color: "purple" },
                  { status: "Qualified", color: "orange" },
                  { status: "Proposal", color: "blue" },
                  { status: "Won", color: "green" },
                  { status: "Lost", color: "red" },
                ].map((stage) => {
                  const stageLeads = leads.filter(
                    (lead) => lead.status === stage.status
                  );

                  return (
                    <section className="pipeline-column" key={stage.status}>
                      <div className="pipeline-heading">
                        <span className={`pipeline-dot ${stage.color}`} />
                        <strong>{stage.status}</strong>
                        <span className="pipeline-count">
                          {stageLeads.length}
                        </span>
                      </div>

                      {stageLeads.length === 0 ? (
                        <p className="muted-text">No leads</p>
                      ) : (
                        stageLeads.map((lead) => (
                          <article className="pipeline-card" key={lead._id}>
                            <strong>{lead.customerName}</strong>
                            <p>{lead.companyName || "Individual customer"}</p>
                            <span>{lead.interest || "No interest specified"}</span>
                            <button
                              className="btn btn-small btn-light"
                              onClick={() => openEditLead(lead)}
                            >
                              Update lead
                            </button>
                          </article>
                        ))
                      )}
                    </section>
                  );
                })}
              </div>
            </>
          )}

          {activePage === "health" && (
            <>
              <PageHeader
                title="System Health"
                subtitle="Monitor application availability and database readiness."
                action={
                  <button
                    className="btn btn-light"
                    onClick={async () => {
                      await Promise.allSettled([checkHealth(), loadSystemInfo()]);
                      notify("Health status refreshed.");
                    }}
                  >
                    ↻ Refresh Health
                  </button>
                }
              />

              <div className="health-grid">
                <article className="health-card">
                  <div className="health-card-icon blue">⌘</div>
                  <h2>Application</h2>
                  <p>Checks the backend health endpoint.</p>
                  <StatusBadge value={health.app} />
                  <p className="muted-text">Endpoint: /healthz</p>
                </article>

                <article className="health-card">
                  <div className="health-card-icon green">▤</div>
                  <h2>Database</h2>
                  <p>Checks whether the backend is ready to serve requests.</p>
                  <StatusBadge value={health.database} />
                  <p className="muted-text">Endpoint: /readyz</p>
                </article>

                <article className="health-card">
                  <div className="health-card-icon purple">↻</div>
                  <h2>Release State</h2>
                  <p>Current state reported by the version manager.</p>
                  <StatusBadge value={systemStatus} />
                  <p className="muted-text">Current: {currentVersion}</p>
                </article>
              </div>

              <section className="panel section-gap">
                <div className="panel-heading">
                  <div>
                    <h2>Recovery Actions</h2>
                    <p>
                      Use the Version Manager to run a controlled self-healing test.
                    </p>
                  </div>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={() => setActivePage("versions")}
                >
                  Open Version Manager →
                </button>
              </section>
            </>
          )}

          {activePage === "versions" && (
            <>
              <PageHeader
                title="Version Manager"
                subtitle="Monitor the active release and safely test automatic recovery."
                action={
                  <button
                    className="btn btn-light"
                    type="button"
                    onClick={async () => {
                      await Promise.allSettled([loadSystemInfo(), checkHealth()]);
                      notify("System status refreshed.");
                    }}
                  >
                    ↻ Refresh
                  </button>
                }
              />

              <section className="panel version-hero">
                <div className="version-mark">S</div>
                <div className="version-hero-info">
                  <span className="eyebrow">ACTIVE RELEASE</span>
                  <h2>{currentVersion}</h2>
                  <p>Stable recovery target: {stableVersion}</p>
                </div>
                <StatusBadge value={systemStatus} />
              </section>

              <div className="version-summary-grid section-gap">
                <article className="version-summary-card">
                  <span className="version-summary-icon">◉</span>
                  <div>
                    <span className="version-summary-label">Release health</span>
                    <strong><StatusBadge value={systemStatus} /></strong>
                  </div>
                </article>
                <article className="version-summary-card">
                  <span className="version-summary-icon stable">✓</span>
                  <div>
                    <span className="version-summary-label">Stable version</span>
                    <strong>{STABLE_VERSION}</strong>
                  </div>
                </article>
                <article className="version-summary-card">
                  <span className="version-summary-icon update">↑</span>
                  <div>
                    <span className="version-summary-label">Available release</span>
                    <strong>v{CANDIDATE_VERSION}</strong>
                  </div>
                </article>
              </div>

              <section className="panel update-release-panel section-gap">
                <div className="update-release-copy">
                  <span className="eyebrow">RELEASE MANAGEMENT</span>
                  <h2>SaleSphere v{CANDIDATE_VERSION}</h2>
                  <p>
                    A candidate update is available. Install it to run the
                    controlled failure test and watch SaleSphere detect, diagnose,
                    roll back its version state and verify recovery.
                  </p>
                  <div className="release-meta">
                    <span><i className="release-dot" /> Update available</span>
                    <span>Recovery target: {STABLE_VERSION}</span>
                  </div>
                </div>
                <div className="update-release-action">
                  <button
                    className="btn btn-primary btn-install-update"
                    type="button"
                    onClick={() => setUpdateModal(true)}
                    disabled={recoveryBusy}
                  >
                    Install Update <span aria-hidden="true">→</span>
                  </button>
                  <small>Recovery steps begin after you confirm.</small>
                </div>
              </section>

              <div className="version-demo-note">
                <span className="version-demo-note-icon">i</span>
                <p>
                  <strong>Controlled demo:</strong> the backend simulates a failed
                  release and restores the configured stable version. It does not
                  replace deployed source code or restart a crashed Node.js process.
                </p>
              </div>
            </>
          )}

          {activePage === "incidents" && (
            <>
              <PageHeader
                title="Incidents"
                subtitle="Review recorded failures and their recovery outcomes."
                action={
                  <button
                    className="btn btn-light"
                    onClick={async () => {
                      await loadSystemInfo();
                      notify("Incident history refreshed.");
                    }}
                  >
                    ↻ Refresh Incidents
                  </button>
                }
              />

              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Incident History</h2>
                    <p>Failure records reported by the backend.</p>
                  </div>
                  <span className="results-count">{incidents.length} total</span>
                </div>

                {incidents.length === 0 ? (
                  <EmptyState
                    title="No incidents recorded"
                    description="Run the self-healing test from Version Manager."
                  />
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Incident</th>
                          <th>Type</th>
                          <th>Previous Version</th>
                          <th>Failed Version</th>
                          <th>Status</th>
                          <th>Detection</th>
                          <th>Recovery</th>
                        </tr>
                      </thead>
                      <tbody>
                        {incidents.map((incident, index) => (
                          <tr key={incident._id || incident.id || index}>
                            <td>
                              {incident.title ||
                                incident.name ||
                                incident.id ||
                                `Incident ${index + 1}`}
                            </td>
                            <td>{incident.type || "—"}</td>
                            <td>{incident.previousVersion || "—"}</td>
                            <td>{incident.failedVersion || "—"}</td>
                            <td>
                              <StatusBadge value={incident.status || "Recorded"} />
                            </td>
                            <td>
                              {typeof incident.detectionTimeMs === "number"
                                ? `${incident.detectionTimeMs} ms`
                                : "—"}
                            </td>
                            <td>
                              {typeof incident.recoveryTimeMs === "number"
                                ? `${incident.recoveryTimeMs} ms`
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="form-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => setActivePage("versions")}
                  >
                    Run Self-Healing Test →
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </main>

      {updateModal && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setUpdateModal(false);
            }
          }}
        >
          <section
            className="modal-card update-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-modal-title"
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">SALESSPHERE UPDATE</span>
                <h2 id="update-modal-title">
                  SaleSphere v{CANDIDATE_VERSION} is available
                </h2>
                <p>
                  Start a controlled release-failure test. SaleSphere will detect
                  the unhealthy version, restore the stable version state and
                  verify recovery.
                </p>
              </div>

              <button
                className="modal-close"
                type="button"
                onClick={() => setUpdateModal(false)}
                disabled={recoveryBusy}
                aria-label="Close update dialog"
              >
                ×
              </button>
            </div>

            <div className="recovery-version-flow">
              <div className="recovery-version">
                <span>CURRENT VERSION</span>
                <strong>{currentVersion}</strong>
                <StatusBadge value={health.app} />
              </div>

              <div className="recovery-flow-arrow">→</div>

              <div className="recovery-version">
                <span>AVAILABLE UPDATE</span>
                <strong>v{CANDIDATE_VERSION}</strong>
                <StatusBadge value="Update Available" />
              </div>
            </div>

            <div className="notice">
              <strong>What will happen?</strong>
              <p>
                The backend will simulate a bad release, record the incident,
                restore the configured stable version and run a health verification.
              </p>
            </div>

            <div className="form-actions">
              <button
                className="btn btn-light"
                type="button"
                onClick={() => setUpdateModal(false)}
                disabled={recoveryBusy}
              >
                Later
              </button>

              <button
                className="btn btn-primary"
                type="button"
                disabled={recoveryBusy}
                onClick={() => {
                  setUpdateModal(false);
                  runRecoveryTest();
                }}
              >
                {recoveryBusy ? "Installing..." : "Install Update"}
              </button>
            </div>
          </section>
        </div>
      )}

      {recoveryModal && (
        <div className="modal-backdrop recovery-backdrop">
          <section
            className="modal-card recovery-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recovery-title"
          >
            <div className="recovery-modal-top">
              <div className="recovery-symbol">
                {lastRecoveryResult === "success"
                  ? "✓"
                  : lastRecoveryResult === "installing"
                    ? "↓"
                    : "↻"}
              </div>

              {!recoveryBusy && (
                <button
                  className="modal-close"
                  type="button"
                  onClick={() => setRecoveryModal(false)}
                  aria-label="Close recovery dialog"
                >
                  ×
                </button>
              )}
            </div>

            <span className="eyebrow">SALESSPHERE RELIABILITY ENGINE</span>

            <h2 id="recovery-title">
              {lastRecoveryResult === "success"
                ? "System Recovered Successfully"
                : lastRecoveryResult === "error"
                  ? "Recovery Test Error"
                  : lastRecoveryResult === "warning"
                    ? "Recovery Not Confirmed"
                    : "Self-Healing in Progress"}
            </h2>

            <p className="recovery-description">{recoveryMessage}</p>

            <div className="recovery-version-flow">
              <div className="recovery-version">
                <span>FAILED RELEASE</span>
                <strong>{CANDIDATE_VERSION}</strong>
                <StatusBadge
                  value={
                    lastRecoveryResult === "success"
                      ? "Failure Recovered"
                      : recoveryBusy
                        ? "Unhealthy"
                        : lastRecoveryResult === "warning" ||
                            lastRecoveryResult === "error"
                          ? "Needs Attention"
                          : "Candidate Release"
                  }
                />
              </div>

              <div className="recovery-flow-arrow">→</div>

              <div className="recovery-version">
                <span>STABLE RELEASE</span>
                <strong>{STABLE_VERSION}</strong>
                <StatusBadge
                  value={
                    lastRecoveryResult === "success"
                      ? "Recovered"
                      : recoveryStep >= 3
                        ? "Restoring"
                        : "Standby"
                  }
                />
              </div>
            </div>

            <div className="recovery-progress-track">
              <div
                className={`recovery-progress-fill progress-${recoveryPhase}`}
                style={{ width: `${recoveryProgress}%` }}
              />
            </div>

            <div className="recovery-progress-label">
              <span>
                {recoveryPhase === "installing" && "Preparing update"}
                {recoveryPhase === "activating" && "Activating release"}
                {recoveryPhase === "failed" && "Failure detected"}
                {recoveryPhase === "diagnosing" && "Diagnosing failure"}
                {recoveryPhase === "rollback" && "Automatic rollback"}
                {recoveryPhase === "verifying" && "Verifying recovery"}
                {recoveryPhase === "recovered" && "Recovery complete"}
                {recoveryPhase === "error" && "Recovery error"}
                {recoveryPhase === "warning" && "Verification warning"}
                {recoveryPhase === "idle" && "Ready"}
              </span>
              <strong>{recoveryProgress}%</strong>
            </div>

            <div className="recovery-timeline">
              {[
                {
                  title: "Failure Injection",
                  detail: "Controlled bad release requested",
                },
                {
                  title: "Failure Detection",
                  detail: "Watchdog detects unhealthy release",
                },
                {
                  title: "Incident Diagnosis",
                  detail: "Identify the failure and recovery target",
                },
                {
                  title: "Automatic Rollback",
                  detail: "Restore the stable version",
                },
                {
                  title: "Health Verification",
                  detail: "Confirm recovery using backend status",
                },
              ].map((step, index) => {
                const complete =
                  lastRecoveryResult === "success" ||
                  index < recoveryStep;

                const current = recoveryBusy && index === recoveryStep;

                return (
                  <div
                    className={`recovery-timeline-step ${
                      complete ? "step-complete" : ""
                    } ${current ? "step-current" : ""}`}
                    key={step.title}
                  >
                    <div className="recovery-step-marker">
                      {complete ? "✓" : current ? "↻" : index + 1}
                    </div>

                    <div className="recovery-step-copy">
                      <strong>{step.title}</strong>
                      <p>{step.detail}</p>
                    </div>

                    <span className="recovery-step-status">
                      {complete
                        ? "Complete"
                        : current
                          ? "In progress"
                          : "Waiting"}
                    </span>
                  </div>
                );
              })}
            </div>

            {lastRecoveryResult === "success" && (
              <div className="recovery-success-note">
                <strong>✓ Recovery verified</strong>
                <p>
                  The backend confirmed the incident recovery. The stable
                  release is {STABLE_VERSION}, and incident history has been refreshed.
                </p>
              </div>
            )}

            {(lastRecoveryResult === "error" ||
              lastRecoveryResult === "warning") && (
              <div className="recovery-error-note">{recoveryMessage}</div>
            )}

            <div className="recovery-modal-actions">
              {lastRecoveryResult === "success" && (
                <button
                  className="btn btn-light"
                  type="button"
                  onClick={() => {
                    setRecoveryModal(false);
                    setActivePage("incidents");
                  }}
                >
                  View Incident History
                </button>
              )}

              {!recoveryBusy && (
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => setRecoveryModal(false)}
                >
                  {lastRecoveryResult === "success" ? "Done" : "Close"}
                </button>
              )}
            </div>
          </section>
        </div>
      )}

      {leadModal && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) {
              setLeadModal(null);
            }
          }}
        >
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lead-modal-title"
          >
            <div className="modal-heading">
              <div>
                <h2 id="lead-modal-title">
                  {leadModal.mode === "edit"
                    ? "Edit Customer Lead"
                    : "Add New Lead"}
                </h2>
                <p>Enter the customer information below.</p>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setLeadModal(null)}
                disabled={saving}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <LeadForm
              key={leadModal.lead?._id || "new-lead"}
              initialLead={leadModal.lead}
              onSave={saveLead}
              onCancel={() => setLeadModal(null)}
              busy={saving}
            />
          </section>
        </div>
      )}

      {profileLead && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setProfileLead(null);
            }
          }}
        >
          <section
            className="modal-card profile-modal"
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">CUSTOMER PROFILE</span>
                <h2>{profileLead.customerName}</h2>
                <p>{profileLead.companyName || "Individual customer"}</p>
              </div>
              <button
                className="modal-close"
                onClick={() => setProfileLead(null)}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="profile-details">
              <div>
                <span>Email</span>
                <strong>{profileLead.email || "—"}</strong>
              </div>
              <div>
                <span>Phone</span>
                <strong>{profileLead.phone || "—"}</strong>
              </div>
              <div>
                <span>Interest</span>
                <strong>{profileLead.interest || "—"}</strong>
              </div>
              <div>
                <span>Status</span>
                <StatusBadge value={profileLead.status} />
              </div>
              <div>
                <span>Follow-up</span>
                <strong>
                  {profileLead.followUpDate
                    ? String(profileLead.followUpDate).slice(0, 10)
                    : "—"}
                </strong>
              </div>
            </div>

            <div className="panel-heading section-gap">
              <div>
                <h3>Activity Timeline</h3>
                <p>Record a note about your customer interaction.</p>
              </div>
            </div>

            <form className="activity-form" onSubmit={addActivity}>
              <textarea
                value={activityText}
                onChange={(event) => setActivityText(event.target.value)}
                placeholder="Write a call summary, meeting note or next step..."
                rows={3}
                required
              />
              <button className="btn btn-primary" disabled={activityBusy}>
                {activityBusy ? "Saving..." : "Add Activity"}
              </button>
            </form>

            <div className="activity-list">
              {activities.length === 0 ? (
                <p className="muted-text">
                  No activities found for this customer yet.
                </p>
              ) : (
                activities.map((activity, index) => (
                  <article
                    className="activity-item"
                    key={activity._id || activity.id || index}
                  >
                    <span className="activity-timeline-dot" />
                    <div>
                      <p>
                        {activity.note ||
                          activity.text ||
                          activity.description ||
                          "Activity recorded"}
                      </p>
                      <small>
                        {activity.createdAt
                          ? new Date(activity.createdAt).toLocaleString()
                          : "Date not available"}
                      </small>
                    </div>
                  </article>
                ))
              )}
            </div>

            <div className="form-actions">
              <button
                className="btn btn-light"
                onClick={() => {
                  const lead = profileLead;
                  setProfileLead(null);
                  openEditLead(lead);
                }}
              >
                Edit Lead
              </button>
              <button
                className="btn btn-light"
                onClick={() => setProfileLead(null)}
              >
                Close
              </button>
            </div>
          </section>
        </div>
      )}

      {toast && (
        <div className="toast-message" role="status">
          <span>●</span> {toast}
        </div>
      )}
    </div>
  );
}

export default App;
