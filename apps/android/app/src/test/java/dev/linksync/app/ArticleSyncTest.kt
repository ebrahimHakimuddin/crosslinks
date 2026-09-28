package dev.linksync.app

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ArticleSyncTest {
    private val credentials = Credentials(listOf("https://server.example"), "token", "phone", "Phone")

    @Test fun disabledByDefaultDoesNotTouchTransport() {
        val calls = CopyOnWriteArrayList<String>()
        val sync = sync(calls)
        sync.sync(credentials)
        assertTrue(calls.isEmpty())
    }

    @Test fun reservedEnableInvalidatedByDisableCannotActivateOrRequest() {
        val calls = CopyOnWriteArrayList<String>()
        val sync = sync(calls)
        val request = sync.reserveEnable(credentials)
        sync.disable()
        assertFalse(sync.completeEnable(request))
        assertFalse(sync.enabled)
        assertTrue(calls.isEmpty())
    }

    @Test fun completingEnableSeedsAllLocalArticlesBeforeFirstPut() {
        val calls = CopyOnWriteArrayList<String>()
        val store = ArticleStore(InMemoryArticlePersistence())
        store.save("https://one.example", id = "one")
        store.save("https://two.example", id = "two")
        val sync = sync(calls, store)
        assertTrue(sync.completeEnable(sync.reserveEnable(credentials)))
        assertEquals(setOf("one", "two"), calls.filter { it.startsWith("PUT ") }.map { it.substringAfter("PUT ") }.toSet())
        assertEquals(3, calls.size) // two seeded PUTs followed by the snapshot GET
    }

    @Test fun disableWhilePullIsBlockedDiscardsResponse() {
        val store = ArticleStore(InMemoryArticlePersistence())
        val entered = CountDownLatch(1); val release = CountDownLatch(1); var block = false
        var gets = 0
        val transport = object : LinkSyncApi.Transport {
            override fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String {
                if (method == "GET" && block) { entered.countDown(); release.await(2, TimeUnit.SECONDS) }
                return if (method == "PUT") articleResponse(path.substringAfterLast('/')) else if (gets++ == 0) "{\"articles\":[]}" else "{\"articles\":[{\"id\":\"remote\",\"url\":\"https://remote.example\",\"title\":\"remote\",\"list\":\"Inbox\",\"snippet\":\"\",\"progress\":0,\"savedAt\":1,\"revision\":2}]}"
            }
        }
        val sync = ArticleSync(LinkSyncApi(transport), MutableConsent(), { credentials }, store)
        assertTrue(sync.completeEnable(sync.reserveEnable(credentials))); block = true
        val worker = Thread { sync.sync(credentials) }.apply { start() }
        assertTrue(entered.await(2, TimeUnit.SECONDS)); sync.disable(); release.countDown(); worker.join(2_000)
        assertFalse(sync.enabled); assertNull(store.find("remote"))
    }

    @Test fun accountChangeWhilePutIsBlockedKeepsPendingAndSendsNoPull() {
        val store = ArticleStore(InMemoryArticlePersistence()); val article = store.save("https://local.example", id = "local")
        val entered = CountDownLatch(1); val release = CountDownLatch(1); var identity = credentials; var block = false
        val calls = CopyOnWriteArrayList<String>()
        val transport = object : LinkSyncApi.Transport {
            override fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String {
                calls += method; if (method == "PUT" && block) { entered.countDown(); release.await(2, TimeUnit.SECONDS) }
                return if (method == "PUT") articleResponse("local") else "{\"articles\":[]}"
            }
        }
        val sync = ArticleSync(LinkSyncApi(transport), MutableConsent(), { identity }, store)
        assertTrue(sync.completeEnable(sync.reserveEnable(credentials))); store.update(article.copy(title = "changed")); block = true
        val worker = Thread { sync.sync(credentials) }.apply { start() }
        assertTrue(entered.await(2, TimeUnit.SECONDS)); identity = credentials.copy(token = "new-token"); release.countDown(); worker.join(2_000)
        assertFalse(sync.enabled); assertEquals(1, store.pending().size); assertEquals(3, calls.size)
        sync.sync(credentials)
        assertFalse(sync.enabled); assertEquals(3, calls.size)
    }

    @Test fun staleSyncCannotTouchNewlyEnabledAccountState() {
        val accountA = credentials
        val accountB = credentials.copy(token = "token-b")
        val store = ArticleStore(InMemoryArticlePersistence())
        val consent = MutableConsent()
        var identity = accountB
        val calls = CopyOnWriteArrayList<String>()
        val api = LinkSyncApi(object : LinkSyncApi.Transport {
            override fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String {
                calls += "$method:$token"
                return if (method == "PUT") articleResponse(path.substringAfterLast('/')) else "{\"articles\":[]}"
            }
        })
        val coordinator = SyncCoordinator()
        val syncB = ArticleSync(api, consent, { identity }, store, coordinator)
        val syncA = ArticleSync(api, consent, { identity }, store, coordinator)
        assertTrue(syncB.completeEnable(syncB.reserveEnable(accountB)))
        val callsBefore = calls.toList()
        val pendingBefore = store.pending()
        syncA.sync(accountA)
        assertEquals(callsBefore, calls.toList())
        assertEquals(pendingBefore, store.pending())
        assertTrue(syncB.enabled)
    }

    @Test fun staleQueuedSyncCannotDisableSameDeviceTokenRenewal() {
        val accountA = credentials
        val accountB = credentials.copy(token = "token-b")
        val store = ArticleStore(InMemoryArticlePersistence())
        val consent = MutableConsent()
        var identity = accountA
        var blockA = false
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val calls = CopyOnWriteArrayList<String>()
        val api = LinkSyncApi(object : LinkSyncApi.Transport {
            override fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String {
                calls += "$method:$token"
                if (method == "PUT" && token == accountA.token && blockA) { entered.countDown(); release.await(2, TimeUnit.SECONDS) }
                return if (method == "PUT") articleResponse(path.substringAfterLast('/')) else "{\"articles\":[]}"
            }
        })
        val coordinator = SyncCoordinator()
        val syncA = ArticleSync(api, consent, { identity }, store, coordinator)
        val syncB = ArticleSync(api, consent, { identity }, store, coordinator)
        assertTrue(syncA.completeEnable(syncA.reserveEnable(accountA)))
        store.update(store.save("https://local.example", id = "local").copy(title = "changed"))
        blockA = true
        val worker = Thread { syncA.sync(accountA) }.apply { start() }
        assertTrue(entered.await(2, TimeUnit.SECONDS))
        identity = accountB
        assertTrue(syncB.completeEnable(syncB.reserveEnable(accountB)))
        release.countDown()
        worker.join(2_000)

        assertTrue(syncB.enabled)
        assertTrue(calls.any { it == "PUT:${accountB.token}" })
        assertEquals(1, calls.count { it == "PUT:${accountA.token}" })
        assertEquals(articleAccountScope(accountB), consent.read().scope)
    }

    @Test fun queuedStaleContinuationIsDroppedWhenSameDeviceTokenRotatesAndBIsEnabled() {
        val accountA = credentials
        val accountB = credentials.copy(token = "token-b")
        val store = ArticleStore(InMemoryArticlePersistence())
        val consent = MutableConsent()
        var identity = accountA
        var blockA = false
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val calls = CopyOnWriteArrayList<String>()
        val api = LinkSyncApi(object : LinkSyncApi.Transport {
            override fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String {
                calls += "$method:$token:${path.substringAfterLast('/')}"
                if (method == "PUT" && token == accountA.token && blockA) {
                    entered.countDown()
                    release.await(2, TimeUnit.SECONDS)
                }
                return if (method == "PUT") articleResponse(path.substringAfterLast('/')) else "{\"articles\":[]}"
            }
        })
        val coordinator = SyncCoordinator()
        val syncA = ArticleSync(api, consent, { identity }, store, coordinator)
        val syncB = ArticleSync(api, consent, { identity }, store, coordinator)
        store.save("https://one.example", id = "one")
        store.save("https://two.example", id = "two")
        assertTrue(syncA.completeEnable(syncA.reserveEnable(accountA)))
        calls.clear()

        store.update(store.find("one")!!.copy(title = "changed-one"))
        store.update(store.find("two")!!.copy(title = "changed-two"))
        blockA = true
        val activeA = Thread { syncA.sync(accountA) }.apply { start() }
        assertTrue(entered.await(2, TimeUnit.SECONDS))
        val queuedA = Thread { syncA.sync(accountA) }.apply { start() }
        queuedA.join(2_000)

        identity = accountB
        assertTrue(syncB.completeEnable(syncB.reserveEnable(accountB)))
        release.countDown()
        activeA.join(2_000)

        assertTrue(syncB.enabled)
        assertEquals(articleAccountScope(accountB), consent.read().scope)
        assertEquals(1, calls.count { it.startsWith("PUT:${accountA.token}:") })
        assertTrue(calls.any { it.startsWith("PUT:${accountB.token}:") })
        assertTrue(store.pending().isEmpty())
    }

    @Test fun persistedLegacyScopeDoesNotSyncUntilExplicitReenable() {
        val calls = CopyOnWriteArrayList<String>()
        val consent = MutableConsent(SyncConsentState(true, "https://server.example::phone", 7))
        val store = ArticleStore(InMemoryArticlePersistence())
        val api = LinkSyncApi(object : LinkSyncApi.Transport {
            override fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String {
                calls += "$method:$token"
                return "{\"articles\":[]}"
            }
        })
        val sync = ArticleSync(api, consent, { credentials }, store)

        sync.sync(credentials)
        assertTrue(calls.isEmpty())

        assertTrue(sync.completeEnable(sync.reserveEnable(credentials)))
        assertEquals(1, calls.size)
        assertEquals("GET:${credentials.token}", calls.single())
    }

    @Test fun tokenIdentityChangeWithoutExplicitEnableMakesNoRequest() {
        val accountB = credentials.copy(token = "token-b")
        val calls = CopyOnWriteArrayList<String>()
        val consent = MutableConsent()
        var identity = credentials
        val store = ArticleStore(InMemoryArticlePersistence())
        val api = LinkSyncApi(object : LinkSyncApi.Transport {
            override fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String {
                calls += "$method:$token"
                return "{\"articles\":[]}"
            }
        })
        val sync = ArticleSync(api, consent, { identity }, store)
        assertTrue(sync.completeEnable(sync.reserveEnable(credentials)))
        val callsBefore = calls.toList()
        identity = accountB
        sync.sync(accountB)
        assertEquals(callsBefore, calls.toList())
        assertNotEquals(articleAccountScope(accountB), consent.read().scope)
    }

    @Test fun articleScopeContainsNoRawTokenAndChangesWhenTokenChanges() {
        val changed = credentials.copy(token = "token-b")
        assertFalse(articleAccountScope(credentials).contains(credentials.token))
        assertNotEquals(articleAccountScope(credentials), articleAccountScope(changed))
    }

    @Test fun shareCallbacksRequireTheCapturedGeneration() {
        assertTrue(ShareActivity.isCurrentGeneration(4, 4, false))
        assertFalse(ShareActivity.isCurrentGeneration(4, 5, false))
        assertFalse(ShareActivity.isCurrentGeneration(4, 4, true))
    }

    private fun sync(calls: MutableList<String>, store: ArticleStore = ArticleStore(InMemoryArticlePersistence())): ArticleSync {
        val consent = MutableConsent()
        val api = LinkSyncApi(object : LinkSyncApi.Transport {
            override fun request(endpoint: String, path: String, method: String, body: String?, token: String?): String {
                calls += "$method ${path.substringAfterLast('/')}"
                return if (method == "PUT") body!!.let { "{\"id\":\"${path.substringAfterLast('/')}\",\"url\":\"https://example.com\",\"title\":\"\",\"list\":\"Inbox\",\"snippet\":\"\",\"progress\":0,\"savedAt\":1,\"revision\":1}" }
                else "{\"articles\":[]}"
            }
        })
        return ArticleSync(api, consent, { credentials }, store)
    }

    private class MutableConsent(initial: SyncConsentState = SyncConsentState(false, null, 0)) : SyncConsentStore {
        private var state = initial
        override fun read() = state
        override fun enable(scope: String): SyncConsentState { state = SyncConsentState(true, scope, state.generation + 1); return state }
        override fun disable(): SyncConsentState { state = SyncConsentState(false, null, state.generation + 1); return state }
    }

    private fun articleResponse(id: String): String = "{\"id\":\"$id\",\"url\":\"https://example.com\",\"title\":\"\",\"list\":\"Inbox\",\"snippet\":\"\",\"progress\":0,\"savedAt\":1,\"revision\":1}"
}
