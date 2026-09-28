package dev.linksync.app

import org.junit.Assert.assertEquals
import org.junit.Test

class DeliveryTextTest {
    @Test fun formatsDurableSendStates() {
        assertEquals("Queued; waiting for browser", DeliveryText.forOperation(SendOperation("q", "https://example.com", "t")))
        assertEquals("Opened/delivered", DeliveryText.forOperation(SendOperation("d", "https://example.com", "t", deliveryId = "delivery", state = "delivered")))
        assertEquals("Queued; waiting for browser", DeliveryText.forOperation(SendOperation("q2", "https://example.com", "t", deliveryId = "delivery", state = "queued")))
        assertEquals("Failed", DeliveryText.forOperation(SendOperation("f", "https://example.com", "t", state = "failed")))
        assertEquals("Expired", DeliveryText.forOperation(SendOperation("e", "https://example.com", "t", state = "expired")))
        assertEquals("Submission uncertain; retry", DeliveryText.forOperation(SendOperation("u", "https://example.com", "t"), uncertain = true))
    }
}
