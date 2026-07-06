const API_BASE = import.meta.env.VITE_API_BASE ?? "/api"

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    ...options,
  })

  if (response.status === 204) {
    return null
  }

  const text = await response.text()
  let payload = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = {}
  }
  if (!response.ok) {
    const detail = payload.detail
    if (typeof detail === "string") {
      throw new Error(detail)
    }
    if (Array.isArray(detail)) {
      throw new Error(detail.map((item) => item.msg ?? JSON.stringify(item)).join("; "))
    }
    if (detail && typeof detail === "object") {
      throw new Error(JSON.stringify(detail))
    }
    throw new Error(text || `Request failed (${response.status})`)
  }
  return payload
}

async function download(path) {
  const response = await fetch(`${API_BASE}${path}`, { credentials: "include" })
  if (!response.ok) {
    throw new Error(await response.text())
  }
  return response
}

export const api = {
  setupStatus: () => request("/auth/setup-status"),
  setup: (payload) => request("/auth/setup", { method: "POST", body: JSON.stringify(payload) }),
  login: (payload) => request("/auth/login", { method: "POST", body: JSON.stringify(payload) }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request("/auth/me"),
  listDevices: () => request("/devices"),
  createDevice: (payload) => request("/devices", { method: "POST", body: JSON.stringify(payload) }),
  reorderDevices: (deviceIds) => request("/devices/reorder", { method: "POST", body: JSON.stringify({ device_ids: deviceIds }) }),
  updateDevice: (id, payload) => request(`/devices/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteDevice: (id) => request(`/devices/${id}`, { method: "DELETE" }),
  testDevice: (id) => request(`/devices/${id}/test`, { method: "POST" }),
  getDeviceStats: (id) => request(`/devices/${id}/stats`),
  runDeviceAction: (id, action) => request(`/devices/${id}/actions/${action}`, { method: "POST" }),
  listShares: (deviceId) => request(`/devices/${deviceId}/shares`),
  createShare: (deviceId, payload) => request(`/devices/${deviceId}/shares`, { method: "POST", body: JSON.stringify(payload) }),
  updateShare: (id, payload) => request(`/devices/shares/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteShare: (id) => request(`/devices/shares/${id}`, { method: "DELETE" }),
  testShare: (id) => request(`/devices/shares/${id}/test`, { method: "POST" }),
  listFiles: (targetType, id, path = ".") => request(`/files/${targetType === "share" ? "shares/" : ""}${id}/list?path=${encodeURIComponent(path)}`),
  mkdir: (targetType, id, path) => request(`/files/${targetType === "share" ? "shares/" : ""}${id}/mkdir`, { method: "POST", body: JSON.stringify({ path }) }),
  renamePath: (targetType, id, source, destination) => request(`/files/${targetType === "share" ? "shares/" : ""}${id}/rename`, { method: "POST", body: JSON.stringify({ source, destination }) }),
  deletePath: (targetType, id, path) => request(`/files/${targetType === "share" ? "shares/" : ""}${id}/delete`, { method: "POST", body: JSON.stringify({ path }) }),
  downloadUrl: (targetType, id, path) => `/api/files/${targetType === "share" ? "shares/" : ""}${id}/download?path=${encodeURIComponent(path)}`,
  transferFiles: (payload) => request("/transfers/files", { method: "POST", body: JSON.stringify(payload) }),
  createTransferJob: (payload) => request("/transfers/jobs", { method: "POST", body: JSON.stringify(payload) }),
  listTransferJobs: () => request("/transfers/jobs"),
  getTransferReport: (id) => request(`/transfers/jobs/${id}/report`),
  cancelTransferJob: (id) => request(`/transfers/jobs/${id}/cancel`, { method: "POST" }),
  dismissTransferJob: (id) => request(`/transfers/jobs/${id}/dismiss`, { method: "POST" }),
  getUpsConfig: () => request("/ups/config"),
  saveUpsConfig: (payload) => request("/ups/config", { method: "PUT", body: JSON.stringify(payload) }),
  testUps: () => request("/ups/test", { method: "POST" }),
  getUpsStatus: () => request("/ups/status"),
  exportBackup: () => download("/backups/export"),
  restoreBackup: (backup, replaceExisting = true) => request("/backups/restore", { method: "POST", body: JSON.stringify({ backup, replace_existing: replaceExisting }) }),
  listAuditEvents: () => request("/audit/events"),
  scanNetwork: (network) => request(`/discovery/scan?network=${encodeURIComponent(network)}`),
}
