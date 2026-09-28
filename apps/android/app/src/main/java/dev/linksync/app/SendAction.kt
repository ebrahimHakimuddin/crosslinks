package dev.linksync.app

import java.util.UUID

/** The durable identity for one deliberate send action. */
data class SendActionBinding(
    val actionId: String,
    val key: String,
    val url: String,
    val target: String,
    val scope: String,
)

class SendActionTransportException(val binding: SendActionBinding, cause: Throwable) : RuntimeException(cause.message, cause)

/**
 * Resolves an action identity before transport starts. A bound key always wins;
 * otherwise an unaccepted matching operation is reused, and only then is a new
 * operation created. The persistence call happens in this same worker action as
 * the POST, so process death cannot lose the identity between those steps.
 */
object SendAction {
    fun bind(
        operations: SendOperationPersistence,
        credentials: Credentials,
        url: String,
        target: String,
        boundKey: String? = null,
        actionId: String = UUID.randomUUID().toString(),
        now: Long = System.currentTimeMillis(),
    ): SendActionBinding = synchronized(LOCK) {
        val normalized = validateSharedUrl(url)
        val scope = scope(credentials)
        val mappedKey = operations.keyForAction(actionId)
        val bound = (boundKey ?: mappedKey)?.let { operations.load(it) }
        val operation = when {
            bound != null -> {
                require(bound.url == normalized && bound.targetDeviceId == target && bound.scope == scope) { "Send action identity does not match this link or account" }
                bound
            }
            else -> operations.findPending(normalized, target, scope, now) ?: operations.create(normalized, target, scope, now)
        }
        operations.bindAction(actionId, operation.key)
        return SendActionBinding(actionId, operation.key, operation.url, operation.targetDeviceId, operation.scope)
    }

    fun submit(controller: SendController, credentials: Credentials, binding: SendActionBinding): SendOperation = try {
        controller.submitExisting(credentials, binding.key)
    } catch (error: Throwable) {
        throw SendActionTransportException(binding, error)
    }

    fun scope(credentials: Credentials): String = "${credentials.endpoints.joinToString(",")}::${credentials.deviceId}"

    private val LOCK = Any()
}
