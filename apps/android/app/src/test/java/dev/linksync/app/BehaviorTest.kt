package dev.linksync.app

import java.io.IOException
import org.junit.Assert.*
import org.junit.Test

class BehaviorTest {
    private val credentials = Credentials(listOf("https://server.example"), "token", "phone", "Phone")

    @Test fun tombstoneWatermarkBlocksOlderResurrection() {
        val store = ArticleStore(InMemoryArticlePersistence())
        store.applyRemote(listOf(RemoteArticle(ArticleRecord("a", "https://example.com", "A", "Inbox", "", 0f, 1, revision = 5), "a", 5, false)))
        store.applyRemote(listOf(RemoteArticle(id = "a", revision = 6, deleted = true)))
        store.applyRemote(listOf(RemoteArticle(ArticleRecord("a", "https://example.com", "old", "Inbox", "", 0f, 1, revision = 5), "a", 5, false)))
        assertTrue(store.all().isEmpty())
    }

    @Test fun corruptPersistenceIsSurfacedAndBytesRemain() {
        val persistence = InMemoryArticlePersistence("{broken")
        val store = ArticleStore(persistence)
        assertThrows(IllegalStateException::class.java) { store.all() }
        assertEquals("{broken", persistence.value)
    }

    @Test fun uncertainSendReloadsSameKeyAndNeverPostsAfterAcceptance() {
        var posts = 0
        val transport = object : LinkSyncApi.Transport {
            override fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String {
                if (method == "POST") { posts++; if (posts == 1) throw IOException("connection lost"); return "{\"id\":\"d1\",\"url\":\"https://example.com\",\"status\":\"queued\",\"created_at\":1}" }
                return "{\"id\":\"d1\",\"url\":\"https://example.com\",\"status\":\"queued\",\"created_at\":1}"
            }
        }
        val api = LinkSyncApi(transport); val persistence = MemorySendOperationStore(); val controller = SendController(persistence, api, { 1000 })
        assertThrows(IOException::class.java) { controller.submit(credentials, "https://example.com", "chrome") }
        val pending = persistence.all().single()
        val accepted = SendController(persistence, api, { 1000 }).submit(credentials, "https://example.com", "chrome")
        assertEquals(pending.key, accepted.key); assertEquals("d1", accepted.deliveryId); assertEquals(2, posts)
        controller.refresh(credentials, accepted.key)
        assertEquals(2, posts)
    }

    @Test fun pendingAcknowledgementRequiresExactGeneration() {
        val store = ArticleStore(InMemoryArticlePersistence()); val first = store.save("https://example.com", id = "a")
        val genA = store.pending().single().generation
        store.update(first.copy(title = "B")); val genB = store.pending().single().generation
        store.acknowledge("a", genA); assertEquals(genB, store.pending().single().generation)
    }

    @Test fun deliveryStatusParsesFailureReasonAndState() {
        val transport = object : LinkSyncApi.Transport { override fun request(e: String, p: String, m: String, b: String?, t: String?) = "{\"id\":\"d\",\"url\":\"https://example.com\",\"status\":\"failed\",\"created_at\":1,\"failure_reason\":\"offline\"}" }
        val status = LinkSyncApi(transport).delivery(credentials, "d")
        assertEquals("offline", status.error); assertEquals(DeliveryState.FAILED, status.state())
    }

    @Test fun activeAckAdvancesWatermarkAndKeepsNewerLocalRevision() {
        val store = ArticleStore(InMemoryArticlePersistence())
        store.applyRemote(listOf(RemoteArticle(ArticleRecord("a", "https://example.com", "A", "Inbox", "", 0f, 1, revision = 10), "a", 10, false)))
        store.update(store.find("a")!!.copy(title = "local"), "scope")
        val generation = store.pending().single().generation
        store.acknowledge("a", generation, 5)
        store.applyRemote(listOf(RemoteArticle(ArticleRecord("a", "https://example.com", "stale", "Inbox", "", 0f, 1, revision = 6), "a", 6, false)))
        assertEquals("local", store.find("a")!!.title)
    }

    @Test fun enablingNewScopeSeedsAllCurrentArticlesAfterPriorAck() {
        val store = ArticleStore(InMemoryArticlePersistence())
        store.save("https://one.example", id = "one"); store.save("https://two.example", id = "two")
        store.seed("old"); store.pending().forEach { store.acknowledge(it.id, it.generation, 1) }
        assertTrue(store.pending().isEmpty())
        store.seed("new")
        assertEquals(setOf("one", "two"), store.pending().map { it.id }.toSet())
        assertTrue(store.pending().all { it.scope == "new" })
    }

    @Test fun acceptedSubmissionCreatesNewOperationForDeliberateSecondAction() {
        val transport = object : LinkSyncApi.Transport {
            override fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String =
                "{\"id\":\"d1\",\"url\":\"https://example.com\",\"status\":\"queued\",\"created_at\":1}"
        }
        val store = MemorySendOperationStore(); val controller = SendController(store, LinkSyncApi(transport), { 1_000 })
        val first = controller.submit(credentials, "https://example.com", "chrome")
        val second = controller.prepareOperation(credentials, "https://example.com", "chrome")
        assertNotEquals(first.key, second.key)
    }

    @Test fun missingAcceptedDeliveryIsNeverPostedAgain() {
        var posts = 0
        val transport = object : LinkSyncApi.Transport {
            override fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String {
                if (method == "POST") { posts++; return "{\"id\":\"d1\",\"url\":\"https://example.com\",\"status\":\"queued\",\"created_at\":1}" }
                throw LinkSyncApi.HttpFailure(404, "missing")
            }
        }
        val store = MemorySendOperationStore(); val controller = SendController(store, LinkSyncApi(transport), { 1_000 })
        val sent = controller.submit(credentials, "https://example.com", "chrome")
        val refreshed = controller.refresh(credentials, sent.key)
        assertEquals("expired", refreshed.state); assertEquals(1, posts)
    }

    @Test fun sendActionReconstructsPersistedBindingAfterAcceptance() {
        var posts = 0
        val transport = object : LinkSyncApi.Transport {
            override fun request(e: String, p: String, m: String, b: String?, t: String?): String {
                if (m == "POST") posts++
                return "{\"id\":\"d1\",\"url\":\"https://example.com\",\"status\":\"queued\",\"created_at\":1}"
            }
        }
        val store = MemorySendOperationStore(); val api = LinkSyncApi(transport); val actionId = "action-1"
        val first = SendAction.bind(store, credentials, "https://example.com", "chrome", actionId = actionId, now = 1_000)
        SendAction.submit(SendController(store, api, { 1_000 }), credentials, first)
        val restored = SendAction.bind(store, credentials, "https://example.com", "chrome", actionId = actionId, now = 1_000)
        SendAction.submit(SendController(store, api, { 1_000 }), credentials, restored)
        assertEquals(first.key, restored.key); assertEquals(1, posts)
    }
}
