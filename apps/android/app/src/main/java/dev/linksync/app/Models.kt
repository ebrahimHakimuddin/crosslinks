package dev.linksync.app

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

data class Credentials(
    val endpoints: List<String>,
    val token: String,
    val deviceId: String,
    val deviceName: String,
)

data class BrowserDevice(
    val id: String,
    val name: String,
    val online: Boolean,
    val lastSeenAt: Long?,
)

data class HistoryItem(
    val id: String,
    val url: String,
    val status: String,
    val createdAt: Long,
)

data class DeliveryStatus(
    val id: String,
    val url: String,
    val status: String,
    val createdAt: Long,
    val deliveredAt: Long? = null,
    val error: String? = null,
)

data class ArticleRecord(
    val id: String,
    val url: String,
    val title: String,
    val list: String,
    val snippet: String,
    val progress: Float,
    val savedAt: Long,
    val readAt: Long? = null,
    val revision: Long = 0,
    val deleted: Boolean = false,
) {
    init {
        require(id.length in 1..128)
        validateSharedUrl(url)
        require(title.length <= 300 && list.length <= 60 && snippet.length <= 500)
        require(progress.isFinite() && progress in 0f..1f)
        require(savedAt >= 0 && (readAt == null || readAt >= 0))
    }
}

data class ArticleTombstone(val id: String, val revision: Long, val deleted: Boolean = true)

data class PendingArticleMutation(
    val article: ArticleRecord?, val id: String, val generation: Long, val deleted: Boolean,
    val scope: String = "",
)

data class SendOperationIdentity(val key: String, val scope: String)

data class SendOperation(
    val key: String,
    val url: String,
    val targetDeviceId: String,
    val deliveryId: String? = null,
    val state: String = "pending",
    val createdAt: Long = System.currentTimeMillis(),
    val scope: String = "",
)

data class RemoteArticle(val article: ArticleRecord? = null, val id: String, val revision: Long, val deleted: Boolean)

enum class DeliveryState { QUEUED, DELIVERED, FAILED, EXPIRED, UNKNOWN }

fun DeliveryStatus.state(): DeliveryState = when (status.lowercase()) {
    "queued", "pending", "sent" -> DeliveryState.QUEUED
    "delivered", "opened" -> DeliveryState.DELIVERED
    "failed", "error" -> DeliveryState.FAILED
    "expired" -> DeliveryState.EXPIRED
    else -> DeliveryState.UNKNOWN
}

data class ReleaseVersions(
    val server: String,
    val android: String,
    val extension: String,
)

data class PairingPayload(
    val code: String,
    val endpoints: List<String>,
) {
    companion object {
        fun parse(raw: String): PairingPayload {
            val json = JSONObject(raw)
            require(json.optInt("version") == 1) { "Unsupported pairing code version" }
            require(json.optString("deviceKind") == "android") { "This pairing code is not for Android" }
            val code = json.getString("code").trim().uppercase()
            require(code.matches(Regex("[A-Z2-9]{5}-[A-Z2-9]{5}"))) { "Invalid pairing code" }
            val endpointsJson = json.getJSONArray("endpoints")
            val endpoints = buildList {
                for (index in 0 until endpointsJson.length()) add(requireSecureEndpoint(endpointsJson.getString(index)))
            }.distinct()
            require(endpoints.isNotEmpty()) { "Pairing code has no server endpoints" }
            return PairingPayload(code, endpoints)
        }

        fun manual(code: String, serverUrl: String): PairingPayload {
            val normalizedCode = code.trim().uppercase()
            require(normalizedCode.matches(Regex("[A-Z2-9]{5}-[A-Z2-9]{5}"))) { "Enter the full pairing code" }
            return PairingPayload(normalizedCode, listOf(requireSecureEndpoint(serverUrl)))
        }

        private fun requireSecureEndpoint(raw: String): String {
            val uri = URI(raw.trim())
            require(uri.scheme == "https" && !uri.host.isNullOrBlank()) { "Server endpoints must use HTTPS" }
            require(uri.userInfo == null && uri.query == null && uri.fragment == null) { "Server endpoint must be an HTTPS origin" }
            val port = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
            return "https://${uri.host}$port"
        }
    }
}

fun validateSharedUrl(raw: String): String {
    val value = raw.trim()
    require(value.length in 1..16_384) { "Link is empty or too long" }
    val uri = URI(value)
    require(uri.scheme == "http" || uri.scheme == "https") { "Only HTTP and HTTPS links are supported" }
    require(!uri.host.isNullOrBlank()) { "Link must include a host" }
    require(uri.userInfo == null) { "Links containing usernames or passwords are not supported" }
    return value
}

fun JSONArray.objects(): Sequence<JSONObject> = sequence {
    for (index in 0 until length()) yield(getJSONObject(index))
}
