package dev.linksync.app

import android.content.Context
import java.security.MessageDigest

data class SyncConsentState(val enabled: Boolean, val scope: String?, val generation: Long)
interface SyncConsentStore { fun read(): SyncConsentState; fun enable(scope: String): SyncConsentState; fun disable(): SyncConsentState }
class AndroidSyncConsentStore(context: Context) : SyncConsentStore {
    private val prefs = context.applicationContext.getSharedPreferences("article_sync", Context.MODE_PRIVATE)
    override fun read() = SyncConsentState(prefs.getBoolean("enabled", false), prefs.getString("scope", null), prefs.getLong("generation", 0))
    override fun enable(scope: String): SyncConsentState { val next = read().generation + 1; check(prefs.edit().putBoolean("enabled", true).putString("scope", scope).putLong("generation", next).commit()); return read() }
    override fun disable(): SyncConsentState { val next = read().generation + 1; check(prefs.edit().putBoolean("enabled", false).remove("scope").putLong("generation", next).commit()); return read() }
}

data class EnableRequest internal constructor(val credentials: Credentials, val scope: String, val generation: Long)

/** Stable article-library scope; token material is represented only by its SHA-256 fingerprint. */
fun articleAccountScope(credentials: Credentials): String {
    val tokenFingerprint = MessageDigest.getInstance("SHA-256")
        .digest(credentials.token.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    return "${credentials.endpoints.joinToString(",")}::${credentials.deviceId}::$tokenFingerprint"
}

/** Serializes sync work across ArticleSync instances that share the application library. */
class SyncCoordinator {
    private data class Work(val run: () -> Unit, val continueIfValid: () -> Boolean)
    private val lock = Any()
    private var active = false
    private var pending: Work? = null

    fun execute(run: () -> Unit, continueIfValid: () -> Boolean) {
        synchronized(lock) {
            if (active) { pending = Work(run, continueIfValid); return }
            active = true
        }
        var current: Work? = Work(run, continueIfValid)
        try {
            while (current != null) {
                if (current.continueIfValid()) current.run()
                synchronized(lock) {
                    current = pending
                    pending = null
                    if (current == null) active = false
                }
            }
        } finally {
            synchronized(lock) { if (active && pending == null) active = false }
        }
    }

    companion object { val GLOBAL = SyncCoordinator() }
}

/** Explicit opt-in synchronization. Network requests never run while state is locked. */
class ArticleSync(private val api: LinkSyncApi, private val consent: SyncConsentStore, private val credentialIdentity: () -> Credentials?, private val store: ArticleStore, private val coordinator: SyncCoordinator = SyncCoordinator.GLOBAL) {
    constructor(context: Context, api: LinkSyncApi = LinkSyncApi(), consent: SyncConsentStore = AndroidSyncConsentStore(context), credentialIdentity: () -> Credentials? = { CredentialStore(context).currentIdentity() }, store: ArticleStore = ArticleStore(context), coordinator: SyncCoordinator = SyncCoordinator.GLOBAL) : this(api, consent, credentialIdentity, store, coordinator)

    @Volatile var lastError: String? = null; private set
    val enabled: Boolean get() = consent.read().enabled

    /** Reserves an enable synchronously. The returned ticket is invalidated by disable or another reservation. */
    fun reserveEnable(credentials: Credentials): EnableRequest = synchronized(STATE_LOCK) {
        val state = consent.disable()
        store.setActiveScope(null)
        EnableRequest(credentials, articleAccountScope(credentials), state.generation)
    }

    /** Completes a reserved enable, then performs its first sync. */
    fun completeEnable(request: EnableRequest): Boolean {
        synchronized(STATE_LOCK) {
            val current = consent.read()
            if (current.enabled || current.generation != request.generation || credentialIdentity() != request.credentials) return false
            store.resetRemoteState(request.scope)
            store.seed(request.scope)
            consent.enable(request.scope)
        }
        sync(request.credentials)
        return enabled && lastError == null
    }

    fun enable(credentials: Credentials): Boolean = completeEnable(reserveEnable(credentials))

    fun disable() { synchronized(STATE_LOCK) { consent.disable(); store.setActiveScope(null) } }

    fun sync(credentials: Credentials) {
        val captured = synchronized(STATE_LOCK) {
            val state = consent.read()
            val scope = articleAccountScope(credentials)
            if (!state.enabled || state.scope != scope || credentialIdentity() != credentials) return
            SyncIdentity(credentials, scope, state.generation)
        }
        coordinator.execute({ syncOnce(captured) }, { isConsentFor(captured) })
    }

    private fun syncOnce(captured: SyncIdentity) {
        if (!valid(captured)) { invalidateForCredentialChange(captured); return }
        if (!valid(captured)) return
        val guarded = api.withRequestGuard(object : LinkSyncApi.RequestGuard {
            override fun beforeRequest() { check(valid(captured)) { "Synchronization was invalidated" } }
            override fun afterResponse() { check(valid(captured)) { "Synchronization was invalidated" } }
        })
        try {
            store.pending().filter { it.scope == captured.scope }.forEach { pending ->
                if (!valid(captured)) return
                val response = if (pending.deleted) guarded.deleteArticle(captured.credentials, pending.id) else guarded.putArticle(captured.credentials, pending.article!!)
                synchronized(STATE_LOCK) { if (!validWithoutLock(captured)) return; store.acknowledge(pending.id, pending.generation, if (response is ArticleRecord) response.revision else (response as RemoteArticle).revision) }
            }
            if (!valid(captured)) return
            val remote = guarded.articlesSnapshot(captured.credentials)
            if (!valid(captured)) return
            synchronized(STATE_LOCK) { if (validWithoutLock(captured)) store.applyRemote(remote) else return }
            lastError = null
        } catch (error: Throwable) {
            if (valid(captured)) lastError = error.message ?: "Sync failed" else invalidateForCredentialChange(captured)
        }
    }

    private fun invalidateForCredentialChange(captured: SyncIdentity) = synchronized(STATE_LOCK) {
        val current = consent.read()
        if (current.enabled && current.scope == captured.scope && current.generation == captured.generation && credentialIdentity() != captured.credentials) {
            consent.disable()
            store.resetRemoteState(captured.scope)
            store.setActiveScope(null)
        }
    }
    private fun isConsentFor(captured: SyncIdentity): Boolean = synchronized(STATE_LOCK) { validWithoutLock(captured) }
    private fun valid(captured: SyncIdentity): Boolean = synchronized(STATE_LOCK) { validWithoutLock(captured) }
    private fun validWithoutLock(captured: SyncIdentity): Boolean { val current = consent.read(); return current.enabled && current.scope == captured.scope && current.generation == captured.generation && credentialIdentity() == captured.credentials }
    private data class SyncIdentity(val credentials: Credentials, val scope: String, val generation: Long)
    private companion object { val STATE_LOCK = Any() }
}
