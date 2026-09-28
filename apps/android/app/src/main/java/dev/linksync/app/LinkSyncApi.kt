package dev.linksync.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class LinkSyncApi(private val transport: Transport? = null, private val requestGuard: RequestGuard? = null) {
    interface RequestGuard { fun beforeRequest(); fun afterResponse() }
    fun withRequestGuard(guard: RequestGuard): LinkSyncApi = LinkSyncApi(transport, guard)
    interface Transport {
        fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String
    }
    fun pair(payload: PairingPayload, deviceName: String): Credentials {
        var lastError: Exception? = null
        for (endpoint in payload.endpoints) {
            try {
                val body = JSONObject()
                    .put("code", payload.code)
                    .put("name", deviceName)
                    .put("deviceKind", "android")
                val response = (transport ?: HttpTransport).request(endpoint, "/api/v1/pair", "POST", body.toString(), null)
                val json = JSONObject(response)
                return Credentials(payload.endpoints, json.getString("token"), json.getString("deviceId"), deviceName)
            } catch (error: Exception) {
                lastError = error
            }
        }
        throw lastError ?: IOException("No CrossLinks endpoint was reachable")
    }

    fun devices(credentials: Credentials): List<BrowserDevice> {
        val json = JSONArray(authenticatedRequest(credentials, "/api/v1/devices", "GET"))
        return json.objects().map {
            BrowserDevice(
                id = it.getString("id"),
                name = it.getString("name"),
                online = it.getBoolean("online"),
                lastSeenAt = if (it.isNull("lastSeenAt")) null else it.getLong("lastSeenAt"),
            )
        }.toList()
    }

    fun send(credentials: Credentials, url: String, targetDeviceId: String, idempotencyKey: String): HistoryItem {
        require(idempotencyKey.isNotBlank()) { "A stable idempotency key is required" }
        val body = JSONObject()
            .put("url", validateSharedUrl(url))
            .put("targetDeviceId", targetDeviceId)
            .put("idempotencyKey", idempotencyKey)
        val json = JSONObject(authenticatedRequest(credentials, "/api/v1/deliveries", "POST", body.toString()))
        return HistoryItem(json.getString("id"), json.getString("url"), json.getString("status"), json.getLong("created_at"))
    }

    fun delivery(credentials: Credentials, deliveryId: String): DeliveryStatus {
        val it = JSONObject(authenticatedRequest(credentials, "/api/v1/deliveries/${pathSegment(deliveryId)}", "GET"))
        return DeliveryStatus(it.getString("id"), it.getString("url"), it.getString("status"), it.getLong("created_at"), it.optLong("delivered_at").takeIf { value -> value > 0 }, it.optString("failure_reason").takeIf { value -> value.isNotBlank() })
    }

    fun articles(credentials: Credentials): List<ArticleRecord> {
        val rows = JSONObject(authenticatedRequest(credentials, "/api/v1/articles", "GET")).getJSONArray("articles")
        return rows.objects().mapNotNull { row ->
            if (row.optBoolean("deleted")) null else ArticleRecord(row.getString("id"), row.getString("url"), row.getString("title"), row.getString("list"), row.getString("snippet"), row.getDouble("progress").toFloat(), row.getLong("savedAt"), if (row.has("readAt") && !row.isNull("readAt")) row.getLong("readAt") else null, row.getLong("revision"))
        }.toList()
    }

    fun articlesSnapshot(credentials: Credentials): List<RemoteArticle> {
        val rows = JSONObject(authenticatedRequest(credentials, "/api/v1/articles", "GET")).getJSONArray("articles")
        return rows.objects().map { row ->
            if (row.optBoolean("deleted")) RemoteArticle(id = row.getString("id"), revision = row.getLong("revision"), deleted = true)
            else RemoteArticle(ArticleRecord(row.getString("id"), row.getString("url"), row.getString("title"), row.getString("list"), row.getString("snippet"), row.getDouble("progress").toFloat(), row.getLong("savedAt"), if (row.has("readAt") && !row.isNull("readAt")) row.getLong("readAt") else null, row.getLong("revision")), row.getString("id"), row.getLong("revision"), false)
        }.toList()
    }

    fun putArticle(credentials: Credentials, article: ArticleRecord): ArticleRecord {
        val body = JSONObject().put("url", article.url).put("title", article.title).put("list", article.list).put("snippet", article.snippet).put("progress", article.progress).put("savedAt", article.savedAt).apply { if (article.readAt != null) put("readAt", article.readAt) }
        val row = JSONObject(authenticatedRequest(credentials, "/api/v1/articles/${pathSegment(article.id)}", "PUT", body.toString()))
        return ArticleRecord(row.getString("id"), row.getString("url"), row.getString("title"), row.getString("list"), row.getString("snippet"), row.getDouble("progress").toFloat(), row.getLong("savedAt"), if (row.has("readAt") && !row.isNull("readAt")) row.getLong("readAt") else null, row.getLong("revision"))
    }

    fun deleteArticle(credentials: Credentials, id: String): RemoteArticle {
        val row = JSONObject(authenticatedRequest(credentials, "/api/v1/articles/${pathSegment(id)}", "DELETE"))
        return RemoteArticle(id = row.getString("id"), revision = row.getLong("revision"), deleted = true)
    }

    fun history(credentials: Credentials): List<HistoryItem> {
        val json = JSONArray(authenticatedRequest(credentials, "/api/v1/history", "GET"))
        return json.objects().map {
            HistoryItem(it.getString("id"), it.getString("url"), it.getString("status"), it.getLong("created_at"))
        }.toList()
    }

    fun versions(credentials: Credentials): ReleaseVersions {
        val json = JSONObject(authenticatedRequest(credentials, "/api/v1/version", "GET"))
        return ReleaseVersions(json.getString("server"), json.getString("android"), json.getString("extension"))
    }

    private fun authenticatedRequest(
        credentials: Credentials,
        path: String,
        method: String,
        body: String? = null,
    ): String {
        var lastError: Exception? = null
        for (endpoint in credentials.endpoints) {
            try {
                requestGuard?.beforeRequest()
                val result = (transport ?: HttpTransport).request(endpoint, path, method, body, credentials.token)
                requestGuard?.afterResponse()
                return result
            } catch (error: Exception) {
                if (error is HttpFailure) throw error
                lastError = error
            }
        }
        throw lastError ?: IOException("No CrossLinks endpoint was reachable")
    }

    private fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String = HttpTransport.request(endpoint, path, method, body, token)

    private object HttpTransport : Transport {
      override fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String {
        val connection = URL(endpoint + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 4_000
            connection.readTimeout = 8_000
            connection.setRequestProperty("Accept", "application/json")
            if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.bufferedWriter().use { it.write(body) }
            }
            val status = connection.responseCode
            val response = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val message = runCatching { JSONObject(response).optString("message").ifBlank { JSONObject(response).optString("error") }.ifBlank { "Server returned $status" } }
                    .getOrDefault("Server returned $status")
                throw HttpFailure(status, message)
            }
            return response
        } finally {
            connection.disconnect()
        }
      }
    }

    private fun pathSegment(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8.toString()).replace("+", "%20")

    class HttpFailure(val status: Int, message: String) : IOException(message)
}
