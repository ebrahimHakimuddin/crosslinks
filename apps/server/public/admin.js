const $ = (selector) => document.querySelector(selector);
const loading = $("#loading");
const setup = $("#setup");
const login = $("#login");
const dashboard = $("#dashboard");
const status = $("#status");

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

async function json(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message || body?.error || `Request failed (${response.status})`);
  return body;
}

function show(section) {
  for (const candidate of [loading, setup, login, dashboard]) candidate.hidden = candidate !== section;
}

function time(value) {
  return value ? new Date(value).toLocaleString() : "never";
}

function empty(text) {
  const node = document.createElement("p");
  node.className = "empty";
  node.textContent = text;
  return node;
}

async function refreshDashboard() {
  const [devices, deliveries] = await Promise.all([json("/api/v1/admin/devices"), json("/api/v1/admin/deliveries")]);
  const deviceList = $("#devices");
  deviceList.replaceChildren();
  if (devices.length === 0) deviceList.append(empty("No devices paired yet."));
  for (const device of devices) {
    const row = document.createElement("div"); row.className = "row";
    const copy = document.createElement("div");
    const name = document.createElement("div"); name.className = "primary"; name.textContent = device.name;
    const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = device.kind; name.append(badge);
    const meta = document.createElement("div"); meta.className = "meta";
    meta.textContent = device.revoked_at ? `Revoked ${time(device.revoked_at)}` : `Last seen ${time(device.last_seen_at)}`;
    copy.append(name, meta); row.append(copy);
    const deviceActions = document.createElement("div"); deviceActions.className = "device-actions";
    const setPending = (pending) => { for (const action of deviceActions.querySelectorAll("button")) action.disabled = pending; };
    if (!device.revoked_at) {
      const revoke = document.createElement("button"); revoke.className = "quiet danger"; revoke.textContent = "Revoke";
      revoke.addEventListener("click", async () => {
        if (!confirm(`Revoke ${device.name}?`)) return;
        setPending(true);
        try {
          await json(`/api/v1/admin/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
          await refreshDashboard();
        } catch (error) { setPending(false); setStatus(error.message, true); }
      });
      deviceActions.append(revoke);
    }
    const remove = document.createElement("button"); remove.className = "quiet danger"; remove.textContent = "Remove";
    remove.title = "Disconnect and remove this device from the list; delivery history is retained";
    remove.addEventListener("click", async () => {
      if (!confirm(`Remove ${device.name}? It will be disconnected and disappear from the device list. Delivery history remains.`)) return;
      setPending(true);
      try {
        await json(`/api/v1/admin/devices/${encodeURIComponent(device.id)}/remove`, { method: "DELETE" });
        await refreshDashboard();
      } catch (error) { setPending(false); setStatus(error.message, true); }
    });
    deviceActions.append(remove); row.append(deviceActions);
    deviceList.append(row);
  }

  const history = $("#history"); history.replaceChildren();
  if (deliveries.length === 0) history.append(empty("No links have been sent."));
  for (const delivery of deliveries) {
    const row = document.createElement("div"); row.className = "row";
    const copy = document.createElement("div");
    const url = document.createElement("div"); url.className = "primary"; url.textContent = delivery.url; url.title = delivery.url;
    const meta = document.createElement("div"); meta.className = "meta";
    meta.textContent = `${delivery.status} · ${delivery.source_device_name} → ${delivery.target_device_name} · ${time(delivery.created_at)}`;
    copy.append(url, meta);
    const remove = document.createElement("button"); remove.className = "quiet"; remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      await json(`/api/v1/admin/deliveries/${encodeURIComponent(delivery.id)}`, { method: "DELETE" });
      await refreshDashboard();
    });
    row.append(copy, remove); history.append(row);
  }
}

async function boot() {
  try {
    const health = await json("/health");
    if (health.setupRequired) show(setup);
    else {
      try { await refreshDashboard(); show(dashboard); }
      catch { show(login); }
    }
  } catch (error) {
    show(loading); setStatus(error.message, true);
  }
}

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
    await json("/api/v1/setup", { method: "POST", body: JSON.stringify({ token, password: $("#setup-password").value }) });
    history.replaceState(null, "", "/admin"); show(login); setStatus("Owner created. Sign in to continue.");
  } catch (error) { setStatus(error.message, true); }
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await json("/api/v1/admin/login", { method: "POST", body: JSON.stringify({ password: $("#login-password").value }) });
    await refreshDashboard(); show(dashboard); setStatus("");
  } catch (error) { setStatus(error.message, true); }
});

for (const button of document.querySelectorAll("[data-pair]")) {
  button.addEventListener("click", async () => {
    try {
      const payload = await json("/api/v1/admin/pairings", { method: "POST", body: JSON.stringify({ deviceKind: button.dataset.pair }) });
      $("#pairing-qr").style.backgroundImage = `url("${payload.qrDataUrl}")`;
      $("#pairing-code").textContent = payload.code;
      $("#pairing-expiry").textContent = `Expires ${time(payload.expiresAt)}`;
      $("#pairing").hidden = false;
    } catch (error) { setStatus(error.message, true); }
  });
}

$("#refresh").addEventListener("click", () => refreshDashboard().catch((error) => setStatus(error.message, true)));
$("#clear-history").addEventListener("click", async () => {
  if (!confirm("Delete all completed and expired history? Queued links will remain.")) return;
  try { await json("/api/v1/admin/deliveries", { method: "DELETE" }); await refreshDashboard(); }
  catch (error) { setStatus(error.message, true); }
});
$("#logout").addEventListener("click", async () => { await json("/api/v1/admin/logout", { method: "POST" }); show(login); });

void boot();
