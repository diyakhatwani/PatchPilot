import React, { useCallback, useEffect, useMemo,   useRef,useState } from "react";
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
  { id: "offlineLeads", label: "Offline Leads", icon: "⇄" },
  { id: "incidents", label: "Incidents", icon: "⚠" },
];

function getErrorMessage(data, fallback) {
  return data?.message || data?.error || fallback;
}

async function readResponse(response) {
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      getErrorMessage(data, `Request failed (HTTP ${response.status}).`)
    );
  }

  return data;
}

function normaliseIncidents(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.incidents)) return data.incidents;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

/*
 * Offline endpoints may return an array, { leads: [] },
 * { pending: [] }, { operations: [] }, or wrapped lead objects.
 * Preserve queue metadata while unwrapping the actual lead.
 */
function normaliseLeads(data) {
  let items = [];

  if (Array.isArray(data)) {
    items = data;
  } else if (Array.isArray(data?.leads)) {
    items = data.leads;
  } else if (Array.isArray(data?.pending)) {
    items = data.pending;
  } else if (Array.isArray(data?.queued)) {
    items = data.queued;
  } else if (Array.isArray(data?.operations)) {
    items = data.operations;
  } else if (Array.isArray(data?.data)) {
    items = data.data;
  }

  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;

      const nestedLead =
        item.lead ||
        item.payload?.lead ||
        item.payload ||
        (item.operation && typeof item.operation === "object"
          ? item.operation.lead || item.operation.payload
          : null);

      if (nestedLead && typeof nestedLead === "object") {
        return {
          ...nestedLead,
          _id: nestedLead._id || nestedLead.id || item.leadId || undefined,
          localId:
            nestedLead.localId ||
            item.localId ||
            item.clientId ||
            item.operationId ||
            undefined,
          clientId: nestedLead.clientId || item.clientId || undefined,
          operationId: item.operationId || item._id || item.id || undefined,
          pendingSync: true,
          syncStatus:
            item.syncStatus ||
            item.syncState ||
            nestedLead.syncStatus ||
            "Pending Sync",
        };
      }

      return item;
    })
    .filter(Boolean);
}

function leadId(lead) {
  return String(
    lead?._id ??
      lead?.id ??
      lead?.localId ??
      lead?.clientId ??
      ""
  );
}

/*
 * Only synchronization flags are checked here.
 * A normal sales status such as "New" or "Qualified"
 * must not accidentally be treated as an offline status.
 */
function isPendingSyncLead(lead) {
  if (!lead || typeof lead !== "object") return false;

  if (
    lead.pendingSync === true ||
    lead.isOffline === true ||
    lead.offline === true ||
    lead.queued === true
  ) {
    return true;
  }

  const syncStatus = String(
    lead.syncStatus || lead.syncState || lead.queueStatus || ""
  )
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

  return [
    "pending",
    "pendingsync",
    "queued",
    "offline",
    "syncing",
    "waiting",
    "waitingforsync",
  ].includes(syncStatus);
}

function leadMatchKeys(lead) {
  if (!lead) return [];

  const keys = [];

  [
    lead._id,
    lead.id,
    lead.localId,
    lead.clientId,
    lead.leadId,
  ].forEach((value) => {
    if (value !== undefined && value !== null && String(value).trim()) {
      keys.push(`id:${String(value)}`);
    }
  });

  return [...new Set(keys)];
}

function sameLead(left, right) {
  const leftKeys = leadMatchKeys(left);
  const rightKeys = leadMatchKeys(right);

  if (
    leftKeys.some((key) => rightKeys.includes(key))
  ) {
    return true;
  }

  /*
   * Fallback for offline records without a shared ID.
   * Compare stable customer details only when both records
   * contain enough information to identify the same lead.
   */
  const leftEmail = String(left?.email || "").trim().toLowerCase();
  const rightEmail = String(right?.email || "").trim().toLowerCase();

  if (leftEmail && rightEmail && leftEmail === rightEmail) {
    const leftName = String(left?.customerName || "")
      .trim()
      .toLowerCase();
    const rightName = String(right?.customerName || "")
      .trim()
      .toLowerCase();

    if (leftName && rightName && leftName === rightName) {
      return true;
    }
  }

  const leftPhone = String(left?.phone || "").replace(/\D/g, "");
  const rightPhone = String(right?.phone || "").replace(/\D/g, "");

  if (leftPhone.length >= 7 && leftPhone === rightPhone) {
    const leftName = String(left?.customerName || "")
      .trim()
      .toLowerCase();
    const rightName = String(right?.customerName || "")
      .trim()
      .toLowerCase();

    if (leftName && rightName && leftName === rightName) {
      return true;
    }
  }

  return false;
}

function removePendingFromCustomerLeads(customerLeads, pendingLeads) {
  const pending = (pendingLeads || []).filter(Boolean);

  return (customerLeads || []).filter((lead) => {
    if (isPendingSyncLead(lead)) return false;

    return !pending.some((offlineLead) => sameLead(lead, offlineLead));
  });
}

function markAsPending(lead) {
  return {
    ...lead,
    pendingSync: true,
    syncStatus: lead.syncStatus || "Pending Sync",
  };
}

function mergeLeadLists(existing, incoming) {
  const byId = new Map();
  let withoutId = [];

  for (const lead of [...(existing || []), ...(incoming || [])]) {
    if (!lead) continue;

    const id = leadId(lead);

    if (id) {
      byId.set(id, {
        ...(byId.get(id) || {}),
        ...lead,
      });
    } else {
      const duplicateIndex = withoutId.findIndex((item) =>
        sameLead(item, lead)
      );

      if (duplicateIndex >= 0) {
        withoutId[duplicateIndex] = {
          ...withoutId[duplicateIndex],
          ...lead,
        };
      } else {
        withoutId.push(lead);
      }
    }
  }

  return [...byId.values(), ...withoutId].sort(
    (a, b) =>
      new Date(b.createdAt || 0).getTime() -
      new Date(a.createdAt || 0).getTime()
  );
}

function getLeadFromResponse(result) {
  if (!result || typeof result !== "object") return null;

  const candidate =
    result.lead ||
    result.data?.lead ||
    result.data ||
    result.savedLead ||
    null;

  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return null;
  }

  return candidate;
}

function responseMeansPendingSync(response, result, lead) {
  if (response.status === 202) return true;
  if (result?.pendingSync === true) return true;
  if (result?.queued === true) return true;
  if (result?.offline === true) return true;
  if (result?.isOffline === true) return true;
  if (result?.syncStatus) {
    const status = String(result.syncStatus).toLowerCase();

    if (
      status.includes("pending") ||
      status.includes("queued") ||
      status.includes("offline") ||
      status.includes("syncing")
    ) {
      return true;
    }
  }

  return isPendingSyncLead(lead);
}

function StatusBadge({ value }) {
  const status = String(value || "Unknown");
  const normalised = status.toLowerCase().replace(/[\s_]+/g, "-");

  let tone = "info";

  if (
    [
      "healthy",
      "connected",
      "recovered",
      "success",
      "won",
      "active",
    ].includes(normalised)
  ) {
    tone = "success";
  } else if (
    [
      "failed",
      "failure",
      "unhealthy",
      "unavailable",
      "disconnected",
      "error",
      "critical",
      "lost",
      "recovery-failed",
      "verification-failed",
    ].includes(normalised)
  ) {
    tone = "danger";
  } else if (
    [
      "recovering",
      "pending",
      "pending-sync",
      "warning",
      "checking",
      "detected",
      "diagnosing",
      "verifying",
      "overdue",
      "update-available",
      "syncing",
    ].includes(normalised)
  ) {
    tone = "warning";
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

  return (
    <form
      className="lead-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(form);
      }}
    >
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
          Company Name *
          <input
            name="companyName"
            value={form.companyName}
            onChange={updateField}
            placeholder="Enter company name"
            required
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
          Product / Interest *
          <input
            name="interest"
            value={form.interest}
            onChange={updateField}
            placeholder="e.g. Laptop order"
            required
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
  const [offlineLeads, setOfflineLeads] = useState([]);
  const offlineLeadsRef = useRef([]);

useEffect(() => {
  offlineLeadsRef.current = offlineLeads;
}, [offlineLeads]);
  const [health, setHealth] = useState({
    app: "Checking",
    database: "Checking",
  });
  const [version, setVersion] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [dbStatus, setDbStatus] = useState(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [leadModal, setLeadModal] = useState(null);
  const [toast, setToast] = useState("");
  const [showFollowUpReminder, setShowFollowUpReminder] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");

  const [dbChaosBusy, setDbChaosBusy] = useState(false);
  const [dbRecoveryProgress, setDbRecoveryProgress] = useState(0);
  const [dbRecoveryPhase, setDbRecoveryPhase] = useState("idle");
  const [dbRecoveryResult, setDbRecoveryResult] = useState("");
  const [dbRecoverySteps, setDbRecoverySteps] = useState([
    false,
    false,
    false,
    false,
    false,
  ]);
  const [dbChaosMessage, setDbChaosMessage] = useState(
    "Ready to monitor database recovery."
  );
  const [emailRecovery, setEmailRecovery] = useState({
  status: "Healthy",
  stage: "idle",
  message: "Email service is ready.",
  incidentId: null,
  detectionTimeMs: null,
  recoveryTimeMs: null
});

  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState(
    "Ready to run a controlled self-healing test."
  );
  const [recoveryProgress, setRecoveryProgress] = useState(0);
  const [recoveryPhase, setRecoveryPhase] = useState("idle");
  const [recoveryResult, setRecoveryResult] = useState("");
  const [updateModal, setUpdateModal] = useState(false);

  const [profileLead, setProfileLead] = useState(null);
  const [activities, setActivities] = useState([]);
  const [activityText, setActivityText] = useState("");
  const [activityBusy, setActivityBusy] = useState(false);

  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3500);
  }, []);

  /*
   * Load the customer list and offline queue together.
   * A lead found in the pending queue must never be included
   * in Customer Leads, Dashboard counts, Follow-ups or Pipeline.
   */
  const loadLeads = useCallback(async () => {
    const [customerResult, offlineResult] = await Promise.allSettled([
      fetch(API, { cache: "no-store" }),
      fetch(`${API}/offline`, { cache: "no-store" }),
    ]);

    if (customerResult.status !== "fulfilled") {
      throw customerResult.reason || new Error("Could not load customer leads.");
    }

    const customerData = await readResponse(customerResult.value);
    const incoming = normaliseLeads(customerData);

    let pending = offlineLeadsRef.current;

    if (offlineResult.status === "fulfilled" && offlineResult.value.ok) {
      const offlineData = await offlineResult.value
        .json()
        .catch(() => []);
      pending = normaliseLeads(offlineData).map(markAsPending);
      setOfflineLeads(pending);
    }

    const customerOnly = removePendingFromCustomerLeads(incoming, pending);
    setLeads(customerOnly);

    return customerOnly;
  }, []);

  const loadOfflineLeads = useCallback(async () => {
    const response = await fetch(`${API}/offline`, { cache: "no-store" });
    const data = await readResponse(response);

    const pending = normaliseLeads(data).map(markAsPending);

    setOfflineLeads(pending);

    /*
     * Remove any lead that still appears in the customer response
     * but is also present in the offline queue.
     */
    setLeads((current) =>
      removePendingFromCustomerLeads(current, pending)
    );

    return pending;
  }, []);

  const checkHealth = useCallback(async () => {
    const [appResult, dbResult] = await Promise.allSettled([
      fetch("/healthz", { cache: "no-store" }),
      fetch("/readyz", { cache: "no-store" }),
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
    const [versionResult, incidentResult] = await Promise.allSettled([
      fetch("/api/system/version", { cache: "no-store" }),
      fetch("/api/system/incidents", { cache: "no-store" }),
    ]);

    if (versionResult.status === "fulfilled" && versionResult.value.ok) {
      const data = await versionResult.value.json().catch(() => null);

      if (data) {
        setVersion((previous) => ({
          ...(previous || {}),
          ...data,
          currentVersion: data.currentVersion || STABLE_VERSION,
          stableVersion: data.stableVersion || STABLE_VERSION,
        }));
      }
    }

    if (incidentResult.status === "fulfilled" && incidentResult.value.ok) {
      const data = await incidentResult.value.json().catch(() => []);
      setIncidents(normaliseIncidents(data));
    }
  }, []);

  const loadDatabaseStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/system/data-status", {
        cache: "no-store",
      });

      if (!response.ok) {
        setDbStatus((previous) => ({
          ...(previous || {}),
          databaseConnected: false,
          database: "Disconnected",
          recoveryMode: "Recovering",
        }));
        return;
      }

      setDbStatus(await response.json());
    } catch {
      setDbStatus((previous) => ({
        ...(previous || {}),
        databaseConnected: false,
        database: "Disconnected",
        recoveryMode: "Recovering",
      }));
    }
  }, []);

  const refreshAll = useCallback(async () => {
    return Promise.allSettled([
      loadLeads(),
      loadOfflineLeads(),
      checkHealth(),
      loadSystemInfo(),
      loadDatabaseStatus(),
    ]);
  }, [
    loadLeads,
    loadOfflineLeads,
    checkHealth,
    loadSystemInfo,
    loadDatabaseStatus,
  ]);

  useEffect(() => {
    let mounted = true;

    const initialise = async () => {
      setLoading(true);
      await refreshAll();
      if (mounted) setLoading(false);
    };

    initialise();

    const refreshTimer = window.setInterval(() => {
      refreshAll();
    }, 10000);

    const databaseTimer = window.setInterval(() => {
      loadDatabaseStatus();
    }, 2500);

    return () => {
      mounted = false;
      window.clearInterval(refreshTimer);
      window.clearInterval(databaseTimer);
    };
  }, [refreshAll, loadDatabaseStatus]);


    useEffect(() => {
  let active = true;

  const refreshEmailRecovery = async () => {
    try {
      const response = await fetch(
        "/api/system/email-recovery-status",
        { cache: "no-store" }
      );

      if (!response.ok) return;

      const data = await response.json();

      if (active) {
        setEmailRecovery(data);
      }
    } catch (error) {
      console.error(
        "Could not refresh email recovery status:",
        error
      );
    }
  };

  refreshEmailRecovery();

  const timer = window.setInterval(
    refreshEmailRecovery,
    1000
  );

  return () => {
    active = false;
    window.clearInterval(timer);
  };
}, []);

  const filteredLeads = useMemo(() => {
    const query = search.trim().toLowerCase();

    return leads.filter((lead) => {
      if (isPendingSyncLead(lead)) return false;

      const matchesSearch =
        !query ||
        [
          lead.customerName,
          lead.companyName,
          lead.email,
          lead.phone,
          lead.interest,
        ].some((value) => String(value || "").toLowerCase().includes(query));

      return (
        matchesSearch &&
        (statusFilter === "All" || lead.status === statusFilter)
      );
    });
  }, [leads, search, statusFilter]);

  const totalLeads = leads.length;
  const wonLeads = leads.filter(
    (lead) => !isPendingSyncLead(lead) && lead.status === "Won"
  ).length;
  const activeLeads = leads.filter(
    (lead) =>
      !isPendingSyncLead(lead) &&
      !["Won", "Lost"].includes(lead.status)
  ).length;

  const today = new Date().toISOString().slice(0, 10);

  const dueFollowUps = leads.filter((lead) => {
    if (
      isPendingSyncLead(lead) ||
      !lead.followUpDate ||
      ["Won", "Lost"].includes(lead.status)
    ) {
      return false;
    }

    return String(lead.followUpDate).slice(0, 10) <= today;
  });

  const currentVersion = recoveryBusy
    ? CANDIDATE_VERSION
    : version?.status === "healthy"
      ? STABLE_VERSION
      : version?.currentVersion || STABLE_VERSION;

  const systemStatus = version?.status || "Unknown";

  const pageTitle = {
    dashboard: "Dashboard",
    leads: "Customer Leads",
    followups: "Follow-ups",
    pipeline: "Sales Pipeline",
    health: "System Health",
    versions: "Version Manager",
    offlineLeads: "Offline Leads",
    incidents: "Incidents",
  }[activePage];

  const openAddLead = () => setLeadModal({ mode: "add", lead: null });

  const openEditLead = (lead) => {
    if (isPendingSyncLead(lead)) {
      notify("This lead is still waiting to sync. Edit it after synchronization.");
      return;
    }

    setLeadModal({ mode: "edit", lead });
  };

const sendFollowUpEmail = async (lead) => {
  const id = leadId(lead);

  if (!id) {
    notify("Could not identify this customer.");
    return;
  }

  if (!lead.email) {
    notify("This customer does not have an email address.");
    return;
  }

  const confirmed = window.confirm(
    `Send a follow-up email to ${lead.email}?`
  );

  if (!confirmed) return;

  setActivePage("health");

  try {
    const response = await fetch(
      `/api/followups/${encodeURIComponent(id)}/send-email`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        result.message || "Email could not be sent."
      );
    }

    notify(
      result.message ||
      `Email sent successfully to ${lead.email}`
    );
  } catch (error) {
    notify(error.message || "Email sending failed.");
  }
};


  const saveLead = async (formData) => {
    if (saving) return;

    setSaving(true);

    try {
      const editingLead =
        leadModal?.mode === "edit" ? leadModal.lead : null;

      const editingId = editingLead ? leadId(editingLead) : "";

      if (editingLead && !editingId) {
        throw new Error(
          "Could not identify this lead. Please refresh and retry."
        );
      }

      const url = editingLead ? `${API}/${editingId}` : API;

      const response = await fetch(url, {
        method: editingLead ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      const result = await readResponse(response);
      const savedLead = getLeadFromResponse(result);

      setLeadModal(null);

      const pendingSync = responseMeansPendingSync(
        response,
        result,
        savedLead
      );

      if (savedLead) {
        const savedId = leadId(savedLead);

        if (pendingSync) {
          const pendingLead = markAsPending({
            ...savedLead,
            syncStatus: result?.syncStatus || "Pending Sync",
          });

          setOfflineLeads((current) =>
            mergeLeadLists(current, [pendingLead])
          );

          setLeads((current) =>
            current.filter(
              (lead) =>
                !sameLead(lead, pendingLead) &&
                (!savedId || leadId(lead) !== savedId)
            )
          );
        } else {
          /*
           * Only a non-pending successful response can add the lead
           * optimistically to Customer Leads.
           */
          const confirmedLead = {
            ...savedLead,
            pendingSync: false,
            isOffline: false,
            offline: false,
            syncStatus: "Synced",
          };

          setLeads((current) => {
            const filtered = current.filter(
              (lead) =>
                !sameLead(lead, confirmedLead) &&
                (!savedId || leadId(lead) !== savedId)
            );

            return [confirmedLead, ...filtered];
          });

          setOfflineLeads((current) =>
            current.filter(
              (lead) =>
                !sameLead(lead, confirmedLead) &&
                (!savedId || leadId(lead) !== savedId)
            )
          );
        }
      }

      /*
       * The backend remains the source of truth. Reload both lists
       * so a lead only moves after the server reports it as synced.
       */
      await Promise.allSettled([
        loadLeads(),
        loadOfflineLeads(),
        checkHealth(),
        loadDatabaseStatus(),
      ]);

      notify(
        pendingSync
          ? "Lead saved to the offline queue. It will move to Customer Leads after MongoDB confirms synchronization."
          : editingLead
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

    const id = leadId(lead);

    if (!id) {
      notify("Could not identify this lead. Refresh the list and retry.");
      return;
    }

    try {
      const response = await fetch(`${API}/${id}`, {
        method: "DELETE",
      });

      const result = await readResponse(response);

      setLeads((current) =>
        current.filter((item) => leadId(item) !== id)
      );

      setOfflineLeads((current) =>
        current.filter((item) => leadId(item) !== id)
      );

      if (profileLead && leadId(profileLead) === id) {
        setProfileLead(null);
      }

      await Promise.allSettled([loadLeads(), loadOfflineLeads()]);

      notify(
        result?.pendingSync
          ? "Lead removed locally. Deletion will sync when MongoDB reconnects."
          : "Lead deleted successfully."
      );
    } catch (error) {
      notify(error.message || "Could not delete lead.");
    }
  };

  const openProfile = async (lead) => {
    if (isPendingSyncLead(lead)) {
      notify("This lead is still offline and has not synced to MongoDB yet.");
      return;
    }

    setProfileLead(lead);
    setActivities([]);
    setActivityText("");

    const id = leadId(lead);

    if (!id) {
      notify("Could not identify this customer's record.");
      return;
    }

    try {
      const response = await fetch(`${API}/${id}/activities`, {
        cache: "no-store",
      });

      if (response.ok) {
        const data = await response.json().catch(() => []);
        setActivities(Array.isArray(data) ? data : data?.activities || []);
      }
    } catch {
      // Keep the profile open if activity history is unavailable.
    }
  };

  const addActivity = async (event) => {
    event.preventDefault();

    if (!profileLead || !activityText.trim()) return;

    const id = leadId(profileLead);

    if (!id) {
      notify("Could not identify this customer.");
      return;
    }

    setActivityBusy(true);

    try {
      const response = await fetch(`${API}/${id}/activities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "Note",
          description: activityText.trim(),
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

  const runDatabaseChaosTest = async () => {
    if (dbChaosBusy) return;

    const confirmed = window.confirm(
      "Start a controlled database failure test? Existing leads will not be intentionally deleted."
    );

    if (!confirmed) return;

    setDbChaosBusy(true);
    setDbRecoveryProgress(5);
    setDbRecoveryPhase("injecting");
    setDbRecoveryResult("");
    setDbRecoverySteps([false, false, false, false, false]);
    setDbChaosMessage("Starting controlled database failure test...");

    try {
      const response = await fetch("/api/system/database/chaos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          result.error ||
            result.message ||
            `Database test failed (HTTP ${response.status}).`
        );
      }

      setDbRecoverySteps([true, false, false, false, false]);
      setDbRecoveryProgress(20);
      setDbRecoveryPhase("detecting");
      setDbChaosMessage(
        "Fault request accepted. Monitoring the actual database connection..."
      );

      let recovered = false;
      let observedFailure = false;

      for (let attempt = 0; attempt < 45; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));

        try {
          const statusResponse = await fetch("/api/system/data-status", {
            cache: "no-store",
          });

          if (!statusResponse.ok) continue;

          const status = await statusResponse.json();
          setDbStatus(status);

          const connected = status.databaseConnected === true;
          const pending = Number(status.pendingSyncCount ?? 0);
          const healthy =
            connected &&
            pending === 0 &&
            status.recoveryMode === "Healthy";

          if (!connected) {
            observedFailure = true;
            setDbRecoverySteps([true, true, false, false, false]);
            setDbRecoveryProgress(35);
            setDbRecoveryPhase("recovering");
            setDbChaosMessage(
              "Database failure detected. Waiting for automatic reconnection..."
            );
          } else if (pending > 0) {
            setDbRecoverySteps([
              true,
              observedFailure,
              true,
              false,
              false,
            ]);
            setDbRecoveryProgress(70);
            setDbRecoveryPhase("syncing");
            setDbChaosMessage(
              `Database connected. Syncing ${pending} pending operation(s)...`
            );
          } else if (healthy && observedFailure) {
            recovered = true;
            setDbRecoverySteps([true, true, true, true, true]);
            setDbRecoveryProgress(100);
            setDbRecoveryPhase("recovered");
            setDbRecoveryResult("success");
            setDbChaosMessage(
              "Self-healing verified: the connection recovered and the pending queue is empty."
            );
            break;
          }
        } catch {
          setDbRecoveryPhase("recovering");
          setDbChaosMessage(
            "Health check temporarily unavailable. Continuing recovery monitoring..."
          );
        }
      }

      await Promise.allSettled([
        loadLeads(),
        loadOfflineLeads(),
        checkHealth(),
        loadSystemInfo(),
        loadDatabaseStatus(),
      ]);

      if (!recovered) {
        setDbRecoveryPhase("error");
        setDbRecoveryResult("error");
        setDbChaosMessage(
          "Recovery could not be verified within 45 seconds. Check the live status and backend logs."
        );
      } else {
        notify("Database recovery verified successfully.");
      }
    } catch (error) {
      setDbRecoveryPhase("error");
      setDbRecoveryResult("error");
      setDbChaosMessage(error.message || "Database recovery test failed.");
    } finally {
      setDbChaosBusy(false);
    }
  };

  const runRecoveryTest = async () => {
    if (recoveryBusy) return;

    setRecoveryBusy(true);
    setRecoveryProgress(5);
    setRecoveryPhase("activating");
    setRecoveryResult("");
    setRecoveryMessage(
      "Activating candidate release and monitoring health..."
    );

    try {
      const response = await fetch("/api/system/version/chaos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          result.error ||
            result.message ||
            `Update could not start (HTTP ${response.status}).`
        );
      }

      let recovered = false;
      let latestIncident = null;

      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 600));

        const [versionResponse, incidentResponse] = await Promise.allSettled([
          fetch("/api/system/version", { cache: "no-store" }),
          fetch("/api/system/incidents", { cache: "no-store" }),
        ]);

        if (
          versionResponse.status === "fulfilled" &&
          versionResponse.value.ok
        ) {
          const data = await versionResponse.value.json().catch(() => null);

          if (data) {
            setVersion((previous) => ({ ...(previous || {}), ...data }));

            const status = String(data.status || "").toLowerCase();

            if (status === "failed") {
              setRecoveryPhase("failed");
              setRecoveryProgress(35);
              setRecoveryMessage(
                "Failure detected. Diagnosing release health..."
              );
            } else if (status === "detected") {
              setRecoveryPhase("diagnosing");
              setRecoveryProgress(50);
              setRecoveryMessage(
                "Watchdog detected the failure and is diagnosing it..."
              );
            } else if (status === "recovering") {
              setRecoveryPhase("rollback");
              setRecoveryProgress(70);
              setRecoveryMessage(
                "Automatic recovery is restoring the stable release..."
              );
            } else if (status === "verifying") {
              setRecoveryPhase("verifying");
              setRecoveryProgress(90);
              setRecoveryMessage(
                "Stable release restored. Verifying application health..."
              );
            }
          }
        }

        if (
          incidentResponse.status === "fulfilled" &&
          incidentResponse.value.ok
        ) {
          const data = await incidentResponse.value.json().catch(() => []);
          const list = normaliseIncidents(data);
          setIncidents(list);

          latestIncident = result.incidentId
            ? list.find(
                (item) =>
                  String(item.id || item._id) ===
                  String(result.incidentId)
              ) || null
            : null;

          if (
            latestIncident &&
            String(latestIncident.status).toLowerCase() === "recovered"
          ) {
            recovered = true;
            break;
          }

          if (
            latestIncident &&
            [
              "failed",
              "error",
              "recovery failed",
              "verification failed",
            ].includes(String(latestIncident.status).toLowerCase())
          ) {
            throw new Error(
              latestIncident.error ||
                "The watchdog reported a recovery failure."
            );
          }
        }

        setRecoveryProgress((current) => Math.min(current + 3, 90));
      }

      await Promise.allSettled([checkHealth(), loadSystemInfo()]);

      if (!recovered) {
        throw new Error(
          `Recovery was not confirmed before timeout. ${
            latestIncident?.status
              ? `Latest test incident status: ${latestIncident.status}.`
              : "The backend did not confirm this test's incident as recovered."
          } Check Incidents and the backend terminal.`
        );
      }

      const verifyResponse = await fetch("/api/system/version/health", {
        cache: "no-store",
      });

      const verifyData = await verifyResponse.json().catch(() => ({}));

      if (!verifyResponse.ok || verifyData.healthy !== true) {
        throw new Error(
          "The incident was marked recovered, but final health verification did not pass."
        );
      }

      setRecoveryProgress(100);
      setRecoveryPhase("recovered");
      setRecoveryResult("success");
      setRecoveryMessage(
        `Recovery verified. Stable version ${STABLE_VERSION} is healthy.`
      );

      notify("Self-healing recovery verified.");
    } catch (error) {
      setRecoveryPhase("error");
      setRecoveryResult("error");
      setRecoveryMessage(error.message || "Recovery test failed.");
    } finally {
      setRecoveryBusy(false);
    }
  };

  const databaseConnected = dbStatus?.databaseConnected === true;
  const pendingCount = Number(dbStatus?.pendingSyncCount ?? 0);
  const recoveryMode = dbStatus?.recoveryMode || "Checking";

  const incidentForTimeline =
    dbStatus?.activeIncident || dbStatus?.lastIncident || null;

  const timelineEvents = Array.isArray(incidentForTimeline?.events)
    ? [...incidentForTimeline.events].reverse()
    : [];

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
          {showFollowUpReminder &&
  !loading &&
  activePage === "dashboard" &&
  dueFollowUps.length > 0 && (
    <div
      className="notice"
      role="alert"
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "12px",
        marginBottom: "16px",
      }}
    >
      <div>
        <strong>⏰ Follow-up Reminder</strong>
        <p style={{ margin: "6px 0 0" }}>
          You have {dueFollowUps.length} customer follow-up
          {dueFollowUps.length === 1 ? "" : "s"} due today or overdue.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => setActivePage("followups")}
        >
          View Follow-ups
        </button>

        <button
          className="btn btn-light"
          type="button"
          onClick={() => setShowFollowUpReminder(false)}
          aria-label="Dismiss follow-up reminder"
        >
          ✕
        </button>
      </div>
    </div>
  )}
          {loading && (
            <div className="notice" role="status">
              Loading SaleSphere data...
            </div>
          )}

          {activePage === "dashboard" && (
            <>
              <PageHeader
                title="Welcome to SaleSphere"
                subtitle="Manage customer relationships and monitor system reliability."
                action={
                  <button
                    className="btn btn-light"
                    onClick={refreshAll}
                    type="button"
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
                      type="button"
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
                          {leads
                            .filter((lead) => !isPendingSyncLead(lead))
                            .slice(0, 5)
                            .map((lead, index) => (
                              <tr key={leadId(lead) || index}>
                                <td>
                                  <button
                                    className="table-link"
                                    onClick={() => openProfile(lead)}
                                    type="button"
                                  >
                                    {lead.customerName}
                                  </button>
                                </td>
                                <td>{lead.companyName || "—"}</td>
                                <td>{lead.interest || "—"}</td>
                                <td>
                                  <StatusBadge value={lead.status} />
                                </td>
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
                    <strong>{STABLE_VERSION}</strong>
                  </div>

                  <button
                    className="btn btn-primary full-width section-gap"
                    onClick={() => setActivePage("versions")}
                    type="button"
                  >
                    Open Version Manager
                  </button>
                  <button
                    className="btn btn-light full-width section-gap"
                    onClick={() => setActivePage("offlineLeads")}
                    type="button"
                  >
                    Open Database Self-Healing
                  </button>
                </section>
              </div>
            </>
          )}

          {activePage === "leads" && (
            <>
              <PageHeader
                title="Customer Leads"
                subtitle="Create, search, update and manage customer records."
                action={
                  <button
                    className="btn btn-primary"
                    onClick={openAddLead}
                    type="button"
                  >
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
                      <option key={status} value={status}>
                        {status}
                      </option>
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
                        {filteredLeads.map((lead, index) => (
                          <tr key={leadId(lead) || index}>
                            <td>
                              <button
                                className="table-link"
                                onClick={() => openProfile(lead)}
                                type="button"
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
                            <td>
                              <StatusBadge value={lead.status} />
                            </td>
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
                                  type="button"
                                >
                                  Edit
                                </button>
                                <button
                                  className="btn btn-small btn-danger"
                                  onClick={() => deleteLead(lead)}
                                  type="button"
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
                subtitle="Review customer follow-ups that are due or overdue."
                action={
                  <button
                    className="btn btn-light"
                    onClick={loadLeads}
                    type="button"
                  >
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
                          <th>Email</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...dueFollowUps]
                          .sort((a, b) =>
                            String(a.followUpDate).localeCompare(
                              String(b.followUpDate)
                            )
                          )
                          .map((lead, index) => (
                            <tr key={leadId(lead) || index}>
                              <td>{lead.customerName}</td>
                              <td>{lead.companyName || "—"}</td>
                              <td>{lead.phone || "—"}</td>
                              <td>{String(lead.followUpDate).slice(0, 10)}</td>
                              <td>
                                <StatusBadge
                                  value={
                                    String(lead.followUpDate).slice(0, 10) <
                                    today
                                      ? "Overdue"
                                      : "Due today"
                                  }
                                />
                              </td>
                               <td>
                                <button
                                  className="btn btn-small btn-light"
                                  onClick={() => openEditLead(lead)}
                                  type="button"
                                >
                                  Update
                                </button>
                              </td>


<td>
  <button
    className="btn btn-small btn-light"
    onClick={() => sendFollowUpEmail(lead)}
    type="button"
    disabled={!lead.email}
    title={
      lead.email
        ? `Send email to ${lead.email}`
        : "Add an email address to this customer first"
    }
  >
    Send Email
  </button>
</td>

<td>
  <button
    className="btn btn-small btn-light"
    onClick={() => openEditLead(lead)}
    type="button"
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
                subtitle="Track leads through each stage of your sales process."
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
                    (lead) =>
                      !isPendingSyncLead(lead) &&
                      lead.status === stage.status
                  );

                  return (
                    <section
                      className="pipeline-column"
                      key={stage.status}
                    >
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
                        stageLeads.map((lead, index) => (
                          <article
                            className="pipeline-card"
                            key={leadId(lead) || index}
                          >
                            <strong>{lead.customerName}</strong>
                            <p>{lead.companyName || "Individual customer"}</p>
                            <span>
                              {lead.interest || "No interest specified"}
                            </span>
                            <button
                              className="btn btn-small btn-light"
                              onClick={() => openEditLead(lead)}
                              type="button"
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
                subtitle="Monitor application availability, database readiness and recovery status."
                action={
                  <button
                    className="btn btn-light"
                    onClick={refreshAll}
                    type="button"
                  >
                    ↻ Refresh Health
                  </button>
                }
              />

              <div className="health-grid">

                <article
                  className={`health-card email-mini-card ${
                    emailRecovery.stage === "detected" ||
                    emailRecovery.stage === "failed"
                      ? "email-mini-failed"
                      : emailRecovery.stage === "diagnosed" ||
                          emailRecovery.stage === "recovering"
                        ? "email-mini-recovering"
                        : emailRecovery.stage === "recovered"
                          ? "email-mini-recovered"
                          : ""
                  }`}
                >
                  <div className="email-mini-top">
                    <div className="health-card-icon blue">✉</div>
                    <StatusBadge
                      value={
                        emailRecovery.stage === "detected" ||
                        emailRecovery.stage === "failed"
                          ? "Failed"
                          : emailRecovery.stage === "diagnosed" ||
                              emailRecovery.stage === "recovering"
                            ? "Recovering"
                            : "Healthy"
                      }
                    />
                  </div>

                  <h2>Email Service</h2>
                  <p>PatchPilot live recovery</p>

                  <div className="email-mini-animation">
                    <span className="email-mini-pulse" />
                    <span>
                      {emailRecovery.stage === "detected"
                        ? "Failure detected"
                        : emailRecovery.stage === "diagnosed"
                          ? "Failure diagnosed"
                          : emailRecovery.stage === "recovering"
                            ? "Auto-recovery in progress..."
                            : emailRecovery.stage === "recovered"
                              ? "Service recovered"
                              : emailRecovery.stage === "failed"
                                ? "Recovery failed"
                                : "Email service operational"}
                    </span>
                  </div>

                  <p className="muted-text">
                    {emailRecovery.incidentId
                      ? `Incident: ${emailRecovery.incidentId}`
                      : "Waiting for a failure test"}
                  </p>

                  {emailRecovery.recoveryTimeMs != null && (
                    <p className="muted-text">
                      Recovery: {(emailRecovery.recoveryTimeMs / 1000).toFixed(1)} sec
                    </p>
                  )}
                </article>


                <article
                  className={`health-card database-health-card ${
                    !databaseConnected
                      ? "db-disconnected"
                      : recoveryMode !== "Healthy"
                        ? "db-recovering"
                        : "db-connected"
                  }`}
                >
                  <div className="database-health-top">
                    <div className="health-card-icon green">▤</div>
                    <span className="db-live-indicator">
                      <span className="db-live-dot" />
                      {!databaseConnected
                        ? "DISCONNECTED"
                        : recoveryMode !== "Healthy"
                          ? "RECOVERING"
                          : "CONNECTED"}
                    </span>
                  </div>

                  <h2>Database</h2>
                  <p>Backend database readiness</p>
                  <StatusBadge
                    value={
                      !databaseConnected
                        ? "Disconnected"
                        : recoveryMode !== "Healthy"
                          ? "Recovering"
                          : "Healthy"
                    }
                  />

                  <div className="db-connection-visual">
                    <div className="db-node">APP</div>
                    <div className="db-connection-line">
                      <span className="db-flow-particle" />
                      <span className="db-flow-particle" />
                      <span className="db-flow-particle" />
                    </div>
                    <div
                      className={`db-node db-node-database ${
                        !databaseConnected
                          ? "db-node-offline"
                          : "db-node-online"
                      }`}
                    >
                      DB
                      {!databaseConnected && (
                        <span className="db-reconnect-spinner" />
                      )}
                    </div>
                  </div>

                  <p className="db-connection-message">
                    {!databaseConnected
                      ? "Connection lost. Waiting for database recovery..."
                      : recoveryMode !== "Healthy"
                        ? "Self-healing active. Restoring connection..."
                        : "Connection stable. Database is healthy."}
                  </p>
                  <p className="muted-text">Endpoint: /readyz</p>
                </article>


<article
  className={`health-card release-health-card ${
    String(systemStatus).toLowerCase().includes("recover") ||
    String(systemStatus).toLowerCase().includes("rollback")
      ? "release-recovering"
      : String(systemStatus).toLowerCase().includes("fail") ||
          String(systemStatus).toLowerCase().includes("bad")
        ? "release-failed"
        : "release-healthy"
  }`}
>
  <div className="release-health-top">
    <div className="health-card-icon purple">↻</div>
    <span className="release-live-dot" />
  </div>

  <h2>Release State</h2>
  <p>Version monitoring and automatic rollback</p>
  <StatusBadge value={systemStatus} />

  <div className="release-animation-track">
    <span className="release-animation-line" />
  </div>

  <p className="muted-text">
    Current: {currentVersion}
  </p>

  <p className="release-animation-message">
    {String(systemStatus).toLowerCase().includes("recover") ||
    String(systemStatus).toLowerCase().includes("rollback")
      ? "PatchPilot is restoring the stable version..."
      : String(systemStatus).toLowerCase().includes("fail") ||
          String(systemStatus).toLowerCase().includes("bad")
        ? "Failed release detected"
        : "Release is stable and healthy"}
  </p>
</article>

              </div>

              <section className="panel section-gap">
                <div className="panel-heading">
                  <div>
                    <h2>Database Recovery Monitor</h2>
                    <p>Observe the connection and pending operations.</p>
                  </div>
                  <StatusBadge value={recoveryMode} />
                </div>

                <div className="system-overview-row">
                  <span>Database</span>
                  <StatusBadge
                    value={
                      databaseConnected
                        ? "Connected"
                        : dbStatus
                          ? "Disconnected"
                          : "Checking"
                    }
                  />
                </div>
                <div className="system-overview-row">
                  <span>Pending operations</span>
                  <strong>{pendingCount}</strong>
                </div>

                <button
                  className="btn btn-primary"
                  onClick={() => setActivePage("offlineLeads")}
                  type="button"
                >
                  Open Database Self-Healing →
                </button>
                            </section>

              {/* EMAIL SERVICE RECOVERY MONITOR */}
              <section className="panel section-gap email-recovery-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Email Service Recovery Monitor</h2>
                    <p>
                      PatchPilot email failure detection and automatic recovery.
                    </p>
                  </div>
                  <StatusBadge value={emailRecovery.status} />
                </div>

                <div
                  className={`email-recovery-status ${
                    emailRecovery.stage === "failed" ||
                    emailRecovery.stage === "detected"
                      ? "is-failed"
                      : emailRecovery.stage === "recovering" ||
                          emailRecovery.stage === "diagnosed"
                        ? "is-recovering"
                        : emailRecovery.stage === "recovered"
                          ? "is-recovered"
                          : "is-healthy"
                  }`}
                >
                  <h3>
                    {emailRecovery.stage === "idle" && "Email Service Ready"}
                    {emailRecovery.stage === "detected" && "Email Failure Detected"}
                    {emailRecovery.stage === "diagnosed" && "PatchPilot Diagnosed the Failure"}
                    {emailRecovery.stage === "recovering" && "Automatic Recovery in Progress"}
                    {emailRecovery.stage === "recovered" && "Email Service Recovered"}
                    {emailRecovery.stage === "failed" && "Automatic Recovery Failed"}
                  </h3>

                  <p>{emailRecovery.message}</p>

                  <div className="email-recovery-details">
                    <div className="email-recovery-detail">
                      <span>Incident ID</span>
                      <strong>{emailRecovery.incidentId || "No incident yet"}</strong>
                    </div>

                    <div className="email-recovery-detail">
                      <span>Detection Time</span>
                      <strong>
                        {emailRecovery.detectionTimeMs == null
                          ? "—"
                          : `${emailRecovery.detectionTimeMs} ms`}
                      </strong>
                    </div>

                    <div className="email-recovery-detail">
                      <span>Recovery Time</span>
                      <strong>
                        {emailRecovery.recoveryTimeMs == null
                          ? "—"
                          : `${(emailRecovery.recoveryTimeMs / 1000).toFixed(1)} sec`}
                      </strong>
                    </div>
                  </div>
                </div>

                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={async () => {
                    try {
                      const response = await fetch(
                        "/api/system/email-failure",
                        { method: "POST" }
                      );
                      const result = await response.json();

                      if (!response.ok) {
                        throw new Error(
                          result.message || "Could not inject email failure."
                        );
                      }

                      notify(
                        "Email failure armed. Now open Follow-ups and send an email to test recovery."
                      );
                    } catch (error) {
                      notify(error.message || "Could not inject email failure.");
                    }
                  }}
                >
                  Inject Email Failure
                </button>
              </section>

            </>
          )}



          {activePage === "versions" && (
            <>
              <PageHeader
                title="Version Manager"
                subtitle="Monitor the active release and test automatic rollback."
                action={
                  <button
                    className="btn btn-light"
                    onClick={refreshAll}
                    type="button"
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
                  <p>Stable recovery target: {STABLE_VERSION}</p>
                </div>
                <StatusBadge value={systemStatus} />
              </section>

              <div className="version-summary-grid section-gap">
                <article className="version-summary-card">
                  <span className="version-summary-icon">◉</span>
                  <div>
                    <span className="version-summary-label">Release health</span>
                    <strong>
                      <StatusBadge value={systemStatus} />
                    </strong>
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
                    <span className="version-summary-label">
                      Available release
                    </span>
                    <strong>v{CANDIDATE_VERSION}</strong>
                  </div>
                </article>
              </div>

              <section className="panel update-release-panel section-gap">
                <div className="update-release-copy">
                  <span className="eyebrow">RELEASE MANAGEMENT</span>
                  <h2>SaleSphere v{CANDIDATE_VERSION}</h2>
                  <p>
                    Run a controlled release failure test. The backend
                    watchdog should detect the failure, restore the stable
                    version state and verify recovery.
                  </p>
                  <div className="release-meta">
                    <span>
                      <i className="release-dot" /> Update available
                    </span>
                    <span>Recovery target: {STABLE_VERSION}</span>
                  </div>
                </div>

                <div className="update-release-action">
                  <button
                    className="btn btn-primary btn-install-update"
                    onClick={() => setUpdateModal(true)}
                    disabled={recoveryBusy}
                    type="button"
                  >
                    Install Update →
                  </button>
                  <small>Confirm before starting the test.</small>
                </div>
              </section>

              <section className="panel update-release-panel section-gap database-release-panel">
                <div className="update-release-copy">
                  <span className="eyebrow">DATABASE RELIABILITY</span>
                  <h2>Offline Leads & Database Self-Healing</h2>
                  <p>
                    Monitor locally queued operations and database
                    reconnection. Pending leads should sync automatically when
                    the backend supports offline queuing.
                  </p>
                  <div className="release-meta">
                    <span>
                      <i className="release-dot" /> Pending operations:{" "}
                      {pendingCount}
                    </span>
                    <span>
                      Database: {databaseConnected ? "Connected" : "Not connected"}
                    </span>
                  </div>
                </div>

                <div className="update-release-action">
                  <button
                    className="btn btn-primary btn-install-update"
                    onClick={() => setActivePage("offlineLeads")}
                    type="button"
                  >
                    Open Offline Leads →
                  </button>
                  <small>Open the live recovery monitor.</small>
                </div>
              </section>

              <div className="version-demo-note">
                <span className="version-demo-note-icon">i</span>
                <p>
                  <strong>Controlled demo:</strong> the version test depends on
                  backend incident tracking and health verification. Changing
                  a version label alone does not roll back source code or
                  restart a crashed Node.js process.
                </p>
              </div>
            </>
          )}

          {activePage === "offlineLeads" && (
            <>
              <PageHeader
                title="Offline Leads & Database Self-Healing"
                subtitle="Monitor database failures, queued operations and automatic recovery."
                action={
                  <button
                    className="btn btn-light"
                    onClick={() => setActivePage("versions")}
                    type="button"
                  >
                    ← Version Manager
                  </button>
                }
              />

              <div className="stats-grid offline-status-grid">
                <StatCard
                  label="Database Connection"
                  value={
                    databaseConnected
                      ? "Connected"
                      : dbStatus
                        ? "Disconnected"
                        : "Checking"
                  }
                  detail="Live backend status"
                  icon="▤"
                  tone={databaseConnected ? "green" : "orange"}
                />
                <StatCard
                  label="Pending Operations"
                  value={pendingCount}
                  detail="Waiting to sync"
                  icon="⇄"
                  tone="purple"
                />
                <StatCard
                  label="Recovery Mode"
                  value={recoveryMode}
                  detail="Backend recovery state"
                  icon="↻"
                  tone="blue"
                />
                <StatCard
                  label="Offline Leads"
                  value={offlineLeads.length}
                  detail="Waiting for database sync"
                  icon="⇄"
                  tone="purple"
                />
              </div>

              <div className="offline-page-grid">
                <section className="panel offline-lead-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Add Customer Lead</h2>
                      <p>
                        Submit a customer record. The backend decides whether
                        it is saved online or queued locally.
                      </p>
                    </div>
                  </div>

                  <LeadForm
                    key="offline-lead-form"
                    initialLead={null}
                    onSave={saveLead}
                    onCancel={() => setActivePage("leads")}
                    busy={saving}
                  />

                  <p className="muted-text offline-help">
                    During a database outage, a lead can be saved locally only
                    when the backend offline queue is available.
                  </p>
                </section>

                <section className="panel offline-monitor-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Database Recovery Monitor</h2>
                      <p>
                        Inject a controlled fault and watch for verified
                        recovery.
                      </p>
                    </div>
                    <StatusBadge value={recoveryMode} />
                  </div>

                  <div className="offline-recovery-summary">
                    <div className="offline-recovery-row">
                      <span>Database connection</span>
                      <strong>
                        <StatusBadge
                          value={
                            databaseConnected
                              ? "Connected"
                              : dbStatus
                                ? "Disconnected"
                                : "Checking"
                          }
                        />
                      </strong>
                    </div>
                    <div className="offline-recovery-row">
                      <span>Pending operations</span>
                      <strong>{pendingCount}</strong>
                    </div>
                    <div className="offline-recovery-row">
                      <span>Recovery mode</span>
                      <strong>{recoveryMode}</strong>
                    </div>
                    <div className="offline-recovery-row">
                      <span>Last incident</span>
                      <strong>
                        {incidentForTimeline?.title ||
                          incidentForTimeline?.id ||
                          "No incident reported"}
                      </strong>
                    </div>
                  </div>

                  <button
                    className="btn btn-primary full-width section-gap"
                    onClick={runDatabaseChaosTest}
                    disabled={dbChaosBusy}
                    type="button"
                  >
                    {dbChaosBusy
                      ? "Monitoring Recovery..."
                      : "Inject Database Failure"}
                  </button>

                  {dbChaosBusy && (
                    <div className="db-recovery-workflow">
                      <div className="db-recovery-heading">
                        <span className="db-recovery-pulse" />
                        <div>
                          <h3>Self-Healing in Progress</h3>
                          <p>{dbChaosMessage}</p>
                        </div>
                        <strong className="db-recovery-percent">
                          {dbRecoveryProgress}%
                        </strong>
                      </div>

                      <div className="db-recovery-track">
                        <div
                          className="db-recovery-fill"
                          style={{ width: `${dbRecoveryProgress}%` }}
                        />
                      </div>

                      <div className="db-recovery-steps">
                        {[
                          [
                            "Failure Detection",
                            "Monitoring database connection",
                          ],
                          [
                            "Automatic Reconnection",
                            "Attempting to restore connectivity",
                          ],
                          [
                            "Data Synchronization",
                            "Checking queued operations",
                          ],
                          [
                            "Health Verification",
                            "Waiting for the healthy status",
                          ],
                        ].map(([title, description], index) => (
                          <div
                            className={`db-recovery-step ${
                              dbRecoverySteps[index] ? "active" : ""
                            }`}
                            key={title}
                          >
                            <span>{index + 1}</span>
                            <div>
                              <strong>{title}</strong>
                              <p>{description}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <button
                    className="btn btn-light full-width section-gap"
                    onClick={async () => {
                      await Promise.allSettled([
                        loadDatabaseStatus(),
                        loadLeads(),
                        loadOfflineLeads(),
                        checkHealth(),
                      ]);
                      notify("Database status refreshed.");
                    }}
                    type="button"
                  >
                    ↻ Refresh Database Status
                  </button>

                  {dbChaosBusy && (
                    <div className="offline-progress">
                      <div className="offline-progress-track">
                        <div
                          className="offline-progress-fill"
                          style={{ width: `${dbRecoveryProgress}%` }}
                        />
                      </div>
                      <p>
                        Monitoring connection and pending operations. Please
                        wait...
                      </p>
                    </div>
                  )}

                  {dbChaosMessage && (
                    <p className="offline-test-message">{dbChaosMessage}</p>
                  )}

                  <div className="offline-timeline">
                    <h3>Recovery Timeline</h3>

                    {timelineEvents.length > 0 ? (
                      timelineEvents.map((event, index) => (
                        <div
                          className="offline-timeline-item"
                          key={event.id || event.timestamp || index}
                        >
                          <span className="offline-timeline-dot" />
                          <div>
                            <strong>
                              {event.title ||
                                event.type ||
                                event.status ||
                                "Recovery event"}
                            </strong>
                            <p>
                              {event.message ||
                                event.description ||
                                event.detail ||
                                "Backend reported a recovery event."}
                            </p>
                            <small>
                              {event.timestamp
                                ? new Date(event.timestamp).toLocaleString()
                                : event.createdAt
                                  ? new Date(event.createdAt).toLocaleString()
                                  : ""}
                            </small>
                          </div>
                        </div>
                      ))
                    ) : (
                      <EmptyState
                        title="No recovery events yet"
                        description="Run the controlled database test to request a backend incident and monitor its events."
                      />
                    )}
                  </div>
                </section>
              </div>

              <section className="panel section-gap">
                <div className="panel-heading">
                  <div>
                    <h2>Offline Leads — Pending Sync</h2>
                    <p>
                      These leads should move to Customer Leads after
                      successful database synchronization.
                    </p>
                  </div>

                  <button
                    className="btn btn-light"
                    onClick={loadOfflineLeads}
                    type="button"
                  >
                    ↻ Refresh Offline Leads
                  </button>
                </div>

                {offlineLeads.length === 0 ? (
                  <EmptyState
                    title="No pending offline leads"
                    description="New offline leads will appear here until the database confirms synchronization."
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
                          <th>Sync Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {offlineLeads.map((lead, index) => (
                          <tr key={leadId(lead) || index}>
                            <td>{lead.customerName || "—"}</td>
                            <td>{lead.companyName || "—"}</td>
                            <td>{lead.interest || "—"}</td>
                            <td>
                              <StatusBadge value={lead.status || "New"} />
                            </td>
                            <td>
                              <StatusBadge
                                value={lead.syncStatus || "Pending Sync"}
                              />
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

          {activePage === "incidents" && (
            <>
              <PageHeader
                title="Incidents"
                subtitle="Review recorded failures and recovery outcomes."
                action={
                  <button
                    className="btn btn-light"
                    onClick={loadSystemInfo}
                    type="button"
                  >
                    ↻ Refresh Incidents
                  </button>
                }
              />

              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Incident History</h2>
                    <p>Failures reported by the backend.</p>
                  </div>
                  <span className="results-count">
                    {incidents.length} total
                  </span>
                </div>

                {incidents.length === 0 ? (
                  <EmptyState
                    title="No incidents recorded"
                    description="Run a controlled recovery test from Version Manager or Offline Leads."
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
                              <StatusBadge
                                value={incident.status || "Recorded"}
                              />
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
                    type="button"
                  >
                    Run Release Self-Healing Test →
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
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">SALESSPHERE UPDATE</span>
                <h2>SaleSphere v{CANDIDATE_VERSION} is available</h2>
                <p>Start the controlled release failure and recovery test.</p>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setUpdateModal(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="recovery-version-flow">
              <div className="recovery-version">
                <span>STABLE RELEASE</span>
                <strong>{STABLE_VERSION}</strong>
                <StatusBadge value="Recovery Target" />
              </div>
              <div className="recovery-flow-arrow">→</div>
              <div className="recovery-version">
                <span>CANDIDATE RELEASE</span>
                <strong>{CANDIDATE_VERSION}</strong>
                <StatusBadge value="Test Candidate" />
              </div>
            </div>

            <div className="notice">
              <strong>What will happen?</strong>
              <p>
                The backend should create an incident, detect the failure,
                restore the stable version state and verify application health.
              </p>
            </div>

            <div className="form-actions">
              <button
                className="btn btn-light"
                onClick={() => setUpdateModal(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={recoveryBusy}
                onClick={() => {
                  setUpdateModal(false);
                  runRecoveryTest();
                }}
                type="button"
              >
                {recoveryBusy ? "Testing..." : "Start Self-Healing Test"}
              </button>
            </div>
          </section>
        </div>
      )}

      {(recoveryBusy || recoveryResult) && (
        <div className="modal-backdrop recovery-backdrop">
          <section
            className="modal-card recovery-modal"
            role="dialog"
            aria-modal="true"
          >
            <div className="recovery-modal-top">
              <div className="recovery-symbol">
                {recoveryResult === "success" ? "✓" : "↻"}
              </div>
            </div>

            <span className="eyebrow">SALESSPHERE RELIABILITY ENGINE</span>

            <h2>
              {recoveryResult === "success"
                ? "Recovery Verified"
                : recoveryResult === "error"
                  ? "Recovery Needs Attention"
                  : "Self-Healing in Progress"}
            </h2>

            <p className="recovery-description">{recoveryMessage}</p>

            <div className="recovery-progress-track">
              <div
                className={`recovery-progress-fill progress-${recoveryPhase}`}
                style={{ width: `${recoveryProgress}%` }}
              />
            </div>

            <div className="recovery-progress-label">
              <span>{recoveryPhase}</span>
              <strong>{recoveryProgress}%</strong>
            </div>

            <div className="recovery-timeline">
              {[
                "Failure injection",
                "Failure detection",
                "Root-cause diagnosis",
                "Automatic recovery",
                "Health verification",
              ].map((step, index) => (
                <div
                  className={`recovery-timeline-step ${
                    recoveryProgress >= (index + 1) * 20
                      ? "step-complete"
                      : ""
                  }`}
                  key={step}
                >
                  <div className="recovery-step-marker">
                    {recoveryProgress >= (index + 1) * 20 ? "✓" : index + 1}
                  </div>
                  <div className="recovery-step-copy">
                    <strong>{step}</strong>
                    <p>
                      {
                        [
                          "Request controlled failure",
                          "Watchdog identifies failure",
                          "Backend diagnoses incident",
                          "Restore stable release",
                          "Verify system health",
                        ][index]
                      }
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {!recoveryBusy && (
              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setRecoveryResult("");
                    setRecoveryProgress(0);
                    setRecoveryPhase("idle");
                    setActivePage("incidents");
                  }}
                  type="button"
                >
                  View Incidents
                </button>
                <button
                  className="btn btn-light"
                  onClick={() => {
                    setRecoveryResult("");
                    setRecoveryProgress(0);
                    setRecoveryPhase("idle");
                  }}
                  type="button"
                >
                  Close
                </button>
              </div>
            )}
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
          <section className="modal-card" role="dialog" aria-modal="true">
            <div className="modal-heading">
              <div>
                <h2>
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
              key={leadId(leadModal.lead) || "new-lead"}
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
                type="button"
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
                <p>Record a customer interaction.</p>
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
              <button
                className="btn btn-primary"
                disabled={activityBusy}
                type="submit"
              >
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
                type="button"
              >
                Edit Lead
              </button>
              <button
                className="btn btn-light"
                onClick={() => setProfileLead(null)}
                type="button"
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