package dev.linksync.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ModelsTest {
    @Test
    fun parsesAndroidPairingPayload() {
        val payload = PairingPayload.parse(
            """{"version":1,"code":"ABCDE-FGHIJ","deviceKind":"android","endpoints":["https://lan.example.com","https://links.example.com"]}"""
        )
        assertEquals("ABCDE-FGHIJ", payload.code)
        assertEquals(listOf("https://lan.example.com", "https://links.example.com"), payload.endpoints)
    }

    @Test
    fun rejectsInsecurePairingEndpoint() {
        assertThrows(IllegalArgumentException::class.java) {
            PairingPayload.manual("ABCDE-FGHIJ", "http://192.168.1.4:8787")
        }
    }

    @Test
    fun preservesValidUrlAndRejectsCredentials() {
        val url = "https://example.com/path?q=1#fragment"
        assertEquals(url, validateSharedUrl(url))
        assertThrows(IllegalArgumentException::class.java) { validateSharedUrl("https://user:secret@example.com") }
        assertThrows(IllegalArgumentException::class.java) { validateSharedUrl("spotify:album:123") }
    }

    @Test
    fun articleBoundsAndProgressAreValidated() {
        val article = ArticleRecord("a", "https://example.com/read#p=3", "Title", "Inbox", "snippet", .5f, 10)
        assertEquals(.5f, article.progress)
        assertThrows(IllegalArgumentException::class.java) { article.copy(progress = 1.2f) }
        assertThrows(IllegalArgumentException::class.java) { ArticleRecord("a", "https://example.com", "x".repeat(301), "Inbox", "", 0f, 1) }
    }

    @Test
    fun acceptedDeliveryCannotBeRetried() {
        val operation = SendOperation("key", "https://example.com", "target", deliveryId = "delivery", createdAt = 0)
        assertEquals(false, operation.deliveryId == null)
    }
}
