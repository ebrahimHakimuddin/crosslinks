package dev.linksync.app

import java.io.IOException

/** The single durable send state machine used by dashboard and share target. */
class SendController(
    private val operations: SendOperationPersistence,
    private val api: LinkSyncApi,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    fun submit(credentials: Credentials, url: String, target: String): SendOperation = synchronized(LOCK) {
        val normalized = validateSharedUrl(url); val current = operations.findPending(normalized, target, scope(credentials), now())
        val identity = current?.let { SendOperationIdentity(it.key, it.scope) } ?: prepare(credentials, normalized, target)
        return submitExisting(credentials, identity.key)
    }

    /** Durable prepare is called once per deliberate incoming action, before any POST. */
    fun prepare(credentials: Credentials, url: String, target: String): SendOperationIdentity = synchronized(LOCK) {
        val binding = SendAction.bind(operations, credentials, url, target, now = now())
        SendOperationIdentity(binding.key, binding.scope)
    }

    fun begin(credentials: Credentials, url: String, target: String): SendOperationIdentity = prepare(credentials, url, target)

    /** Source-compatible durable operation object for callers that need its key immediately. */
    fun prepareOperation(credentials: Credentials, url: String, target: String): SendOperation = synchronized(LOCK) {
        val identity = prepare(credentials, url, target)
        operations.load(identity.key) ?: error("Prepared operation was not persisted")
    }

    fun submitExisting(credentials: Credentials, key: String): SendOperation = synchronized(LOCK) {
        val operation = operations.load(key) ?: throw IllegalArgumentException("Send operation is missing")
        require(operation.scope == scope(credentials)) { "This operation belongs to another account" }
        postIfNeeded(credentials, operation)
    }

    fun retry(credentials: Credentials, key: String): SendOperation = synchronized(LOCK) {
        val operation = operations.load(key) ?: throw IllegalArgumentException("Send operation is missing")
        require(operation.scope == scope(credentials)) { "This operation belongs to another account" }
        require(operations.retryable(operation, now())) { "This send has expired or was accepted" }
        return postIfNeeded(credentials, operation)
    }

    fun refresh(credentials: Credentials, key: String): SendOperation = synchronized(LOCK) {
        val operation = operations.load(key) ?: throw IllegalArgumentException("Send operation is missing")
        require(operation.scope == scope(credentials)) { "This operation belongs to another account" }
        val delivery = operation.deliveryId ?: return operation
        val status = try { api.delivery(credentials, delivery) } catch (error: LinkSyncApi.HttpFailure) {
            if (error.status == 404) { val missing = operation.copy(state = "expired"); operations.save(missing); return missing }
            throw error
        }
        val updated = operation.copy(state = status.status)
        operations.save(updated)
        return updated
    }

    private fun postIfNeeded(credentials: Credentials, operation: SendOperation): SendOperation {
        if (operation.deliveryId != null) return operation
        if (!operations.retryable(operation, now())) return operation.copy(state = "expired")
        val claimed = operations.begin(operation.key, now()) ?: return operation
        return try {
            val accepted = api.send(credentials, claimed.url, claimed.targetDeviceId, claimed.key)
            claimed.copy(deliveryId = accepted.id, state = accepted.status).also { operations.accepted(claimed, accepted.id, accepted.status) }
        } catch (error: LinkSyncApi.HttpFailure) {
            if (error.status in 400..499) claimed.copy(state = "failed").also { operations.save(it) } else { operations.save(claimed.copy(state = "pending")); throw error }
        } catch (error: IOException) {
            // The request may have reached the server. Keep the operation pending for a same-key retry.
            operations.save(claimed.copy(state = "pending"))
            throw error
        }
    }

    private fun scope(credentials: Credentials) = "${credentials.endpoints.joinToString(",")}::${credentials.deviceId}"
    private companion object { val LOCK = Any() }
}
