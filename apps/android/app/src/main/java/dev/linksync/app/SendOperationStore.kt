package dev.linksync.app

import android.content.Context
import org.json.JSONObject
import java.util.UUID

interface SendOperationPersistence {
    fun create(url: String, target: String, scope: String = "", now: Long = System.currentTimeMillis()): SendOperation
    fun findPending(url: String, target: String, scope: String, now: Long = System.currentTimeMillis()): SendOperation?
    fun retryable(operation: SendOperation, now: Long = System.currentTimeMillis()): Boolean
    fun load(key: String): SendOperation?
    fun save(operation: SendOperation)
    fun accepted(operation: SendOperation, deliveryId: String, state: String = "queued")
    fun all(): List<SendOperation>
    fun bindAction(actionId: String, key: String) {}
    fun keyForAction(actionId: String): String? = null
    /** Atomically marks a durable operation as in-flight; null means another caller owns it. */
    fun begin(key: String, now: Long = System.currentTimeMillis()): SendOperation? = synchronized(this) {
        val operation = load(key) ?: return@synchronized null
        if (!retryable(operation, now) || operation.state == "sending") return@synchronized operation
        operation.copy(state = "sending").also(::save)
    }
}

class MemorySendOperationStore : SendOperationPersistence {
    private val values = linkedMapOf<String, SendOperation>()
    private val bindings = mutableMapOf<String, String>()
    override fun create(url: String, target: String, scope: String, now: Long) = SendOperation(UUID.randomUUID().toString(), url, target, scope = scope, createdAt = now).also(::save)
    override fun findPending(url: String, target: String, scope: String, now: Long) = all().firstOrNull { it.url == url && it.targetDeviceId == target && it.scope == scope && retryable(it, now) }
    override fun retryable(operation: SendOperation, now: Long) = operation.deliveryId == null && operation.state !in setOf("failed", "expired") && now - operation.createdAt <= 7L * 24 * 60 * 60 * 1000
    override fun load(key: String) = values[key]
    override fun save(operation: SendOperation) { values[operation.key] = operation }
    override fun accepted(operation: SendOperation, deliveryId: String, state: String) = save(operation.copy(deliveryId = deliveryId, state = state))
    override fun all() = values.values.toList()
    override fun bindAction(actionId: String, key: String) { bindings[actionId] = key }
    override fun keyForAction(actionId: String) = bindings[actionId]
}

class SendOperationStore(context: Context) : SendOperationPersistence {
    private val prefs = context.getSharedPreferences("send_operations", Context.MODE_PRIVATE)
    override fun create(url: String, target: String, scope: String, now: Long): SendOperation = SendOperation(UUID.randomUUID().toString(), url, target, scope = scope, createdAt = now).also(::save)
    override fun findPending(url: String, target: String, scope: String, now: Long): SendOperation? = all().firstOrNull { it.url == url && it.targetDeviceId == target && it.scope == scope && retryable(it, now) }
    override fun retryable(operation: SendOperation, now: Long): Boolean = operation.deliveryId == null && operation.state !in setOf("failed", "expired") && now - operation.createdAt <= 7L * 24 * 60 * 60 * 1000
    override fun load(key: String): SendOperation? = prefs.getString(key, null)?.let { JSONObject(it).toOperation() }
    override fun save(operation: SendOperation) { check(prefs.edit().putString(operation.key, operation.toJson().toString()).commit()) { "Could not persist send operation" } }
    override fun accepted(operation: SendOperation, deliveryId: String, state: String) = save(operation.copy(deliveryId = deliveryId, state = state))
    override fun all(): List<SendOperation> = prefs.all.filterKeys { !it.startsWith("action_") }.values.map { value -> JSONObject(value as String).toOperation() }
    override fun bindAction(actionId: String, key: String) { check(prefs.edit().putString("action_$actionId", key).commit()) { "Could not persist send action" } }
    override fun keyForAction(actionId: String): String? = prefs.getString("action_$actionId", null)
    private fun JSONObject.toOperation() = SendOperation(getString("key"), getString("url"), getString("target"), optString("deliveryId").takeIf { it.isNotEmpty() }, optString("state", "pending"), optLong("createdAt", System.currentTimeMillis()), optString("scope"))
    private fun SendOperation.toJson() = JSONObject().put("key", key).put("url", url).put("target", targetDeviceId).put("deliveryId", deliveryId).put("state", state).put("createdAt", createdAt).put("scope", scope)
}
