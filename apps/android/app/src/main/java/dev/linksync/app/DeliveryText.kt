package dev.linksync.app

/** User-facing status for the durable send state machine. */
object DeliveryText {
    fun forOperation(operation: SendOperation, uncertain: Boolean = false): String = when {
        uncertain -> "Submission uncertain; retry"
        operation.state.equals("failed", true) -> "Failed"
        operation.state.equals("expired", true) -> "Expired"
        operation.state.equals("delivered", true) || operation.state.equals("opened", true) -> "Opened/delivered"
        else -> "Queued; waiting for browser"
    }
}
