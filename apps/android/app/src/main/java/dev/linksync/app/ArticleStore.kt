package dev.linksync.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

interface ArticlePersistence { fun read(): String?; fun write(value: String): Boolean }
class InMemoryArticlePersistence(initial: String? = null) : ArticlePersistence { var value: String? = initial; override fun read() = value; override fun write(value: String): Boolean { this.value = value; return true } }

/** Local library with atomic article, tombstone, pending and revision state. */
class ArticleStore(private val persistence: ArticlePersistence) {
    constructor(context: Context) : this(object : ArticlePersistence {
        private val prefs = context.applicationContext.getSharedPreferences("article_library", Context.MODE_PRIVATE)
        override fun read() = prefs.getString(KEY, null)
        override fun write(value: String) = prefs.edit().putString(KEY, value).commit()
    })
    fun all(): List<ArticleRecord> = synchronized(LOCK) { state().articles.values.filterNot { it.deleted }.sortedByDescending { it.savedAt } }
    fun find(id: String): ArticleRecord? = synchronized(LOCK) { state().articles[id]?.takeUnless { it.deleted } }
    fun lists(): List<String> = all().map { it.list }.filter { it.isNotBlank() }.distinct().sorted()
    fun save(url: String, title: String = "", list: String = "Inbox", snippet: String = "", progress: Float = 0f, readAt: Long? = null, id: String = UUID.randomUUID().toString()): ArticleRecord {
        val article = ArticleRecord(id, validateSharedUrl(url), title.take(300), list.take(60).ifBlank { "Inbox" }, snippet.take(500), progress.coerceIn(0f, 1f), System.currentTimeMillis(), readAt)
        synchronized(LOCK) { mutate(article.id, article, false, null) }; return article
    }
    fun update(article: ArticleRecord, scope: String? = null): ArticleRecord = synchronized(LOCK) { mutate(article.id, article, false, scope); article }
    fun markRead(id: String, read: Boolean, scope: String? = null): ArticleRecord? = synchronized(LOCK) { state().articles[id]?.takeUnless { it.deleted }?.let { update(it.copy(readAt = if (read) System.currentTimeMillis() else null), scope) } }
    fun delete(id: String, scope: String? = null) = synchronized(LOCK) { mutate(id, null, true, scope) }
    fun pending(): List<PendingArticleMutation> = synchronized(LOCK) { state().pending.values.sortedBy { it.generation } }
    fun acknowledge(id: String, generation: Long, revision: Long? = null) = synchronized(LOCK) {
        val s = state(); val p = s.pending[id]
        if (p != null && p.generation == generation) {
            val rows = s.articles.toMutableMap(); val marks = s.watermarks.toMutableMap()
            val row = rows[id]
            if (revision != null) {
                val accepted = maxOf(marks[id] ?: Long.MIN_VALUE, revision)
                marks[id] = accepted
                if (row != null) rows[id] = row.copy(revision = maxOf(row.revision, revision))
            }
            persist(s.copy(articles = rows, pending = s.pending - id, watermarks = marks))
        }
    }
    fun applyRemote(snapshot: List<RemoteArticle>) = synchronized(LOCK) {
        val s = state(); val rows = s.articles.toMutableMap(); val watermarks = s.watermarks.toMutableMap()
        snapshot.forEach { incoming -> val local = rows[incoming.id]; val watermark = watermarks[incoming.id] ?: local?.revision ?: -1; if (incoming.revision <= watermark || incoming.id in s.pending) return@forEach; watermarks[incoming.id] = incoming.revision; if (incoming.deleted) rows.remove(incoming.id) else incoming.article?.let { rows[incoming.id] = it.copy(revision = incoming.revision, deleted = false) } }
        persist(s.copy(articles = rows, watermarks = watermarks))
    }
    fun replaceRemote(snapshot: List<ArticleRecord>) = applyRemote(snapshot.map { RemoteArticle(it, it.id, it.revision, false) })
    /** Makes the current enabled synchronization scope the default for future local mutations. */
    fun setActiveScope(scope: String?) = synchronized(LOCK) { val s = state(); if (s.activeScope != scope) persist(s.copy(activeScope = scope)) }
    fun activeScope(): String? = synchronized(LOCK) { state().activeScope }
    /** Explicitly seeds every current local article for a newly enabled account. */
    fun seed(scope: String) = synchronized(LOCK) {
        require(scope.isNotBlank()); val s = state(); var generation = s.generation; val pending = s.pending.toMutableMap()
        s.articles.values.filterNot { it.deleted }.forEach { article -> generation++; pending[article.id] = PendingArticleMutation(article, article.id, generation, false, scope) }
        persist(s.copy(pending = pending, generation = generation, activeScope = scope, watermarks = emptyMap()))
    }
    fun resetRemoteState(scope: String) = synchronized(LOCK) { val s = state(); persist(s.copy(activeScope = scope, watermarks = emptyMap())) }
    private fun mutate(id: String, article: ArticleRecord?, deleted: Boolean, scope: String?) { val s = state(); val generation = s.generation + 1; val rows = s.articles.toMutableMap(); if (deleted) rows.remove(id) else rows[id] = article!!; persist(s.copy(articles = rows, pending = s.pending + (id to PendingArticleMutation(article, id, generation, deleted, scope ?: s.activeScope.orEmpty())), generation = generation)) }
    private fun state(): State { val raw = persistence.read() ?: return State(); return try { val root = JSONObject(raw); val rows = mutableMapOf<String, ArticleRecord>(); val array = root.getJSONArray("articles"); for (i in 0 until array.length()) { val a = array.getJSONObject(i).toArticle(); rows[a.id] = a }; val pending = mutableMapOf<String, PendingArticleMutation>(); val pa = root.optJSONArray("pending") ?: JSONArray(); for (i in 0 until pa.length()) { val p = pa.getJSONObject(i).toPending(); pending[p.id] = p }; val wm = mutableMapOf<String, Long>(); val w = root.optJSONObject("watermarks"); if (w != null) w.keys().forEach { wm[it] = w.getLong(it) }; State(rows, pending, root.optLong("generation"), wm, root.optString("activeScope").takeIf { it.isNotBlank() }) } catch (error: Exception) { throw IllegalStateException("Saved library is damaged; data was preserved", error) } }
    private fun persist(s: State) { val rows = JSONArray(); s.articles.values.forEach { rows.put(it.toJson()) }; val pending = JSONArray(); s.pending.values.forEach { pending.put(it.toJson()) }; val wm = JSONObject(); s.watermarks.forEach { (k, v) -> wm.put(k, v) }; val value = JSONObject().put("articles", rows).put("pending", pending).put("generation", s.generation).put("watermarks", wm).apply { if (s.activeScope != null) put("activeScope", s.activeScope) }.toString(); check(persistence.write(value)) { "Could not persist article library" } }
    private data class State(val articles: Map<String, ArticleRecord> = emptyMap(), val pending: Map<String, PendingArticleMutation> = emptyMap(), val generation: Long = 0, val watermarks: Map<String, Long> = emptyMap(), val activeScope: String? = null)
    private fun JSONObject.toArticle() = ArticleRecord(getString("id"), getString("url"), optString("title"), optString("list", "Inbox"), optString("snippet"), getDouble("progress").toFloat(), getLong("savedAt"), if (has("readAt") && !isNull("readAt")) getLong("readAt") else null, optLong("revision"), optBoolean("deleted"))
    private fun ArticleRecord.toJson() = JSONObject().put("id", id).put("url", url).put("title", title).put("list", list).put("snippet", snippet).put("progress", progress).put("savedAt", savedAt).put("readAt", readAt).put("revision", revision).put("deleted", deleted)
    private fun JSONObject.toPending() = PendingArticleMutation(if (optBoolean("deleted")) null else getJSONObject("article").toArticle(), getString("id"), getLong("generation"), optBoolean("deleted"), optString("scope"))
    private fun PendingArticleMutation.toJson() = JSONObject().put("id", id).put("generation", generation).put("deleted", deleted).put("scope", scope).apply { if (article != null) put("article", article.toJson()) }
    private companion object { const val KEY = "state"; val LOCK = Any() }
}
