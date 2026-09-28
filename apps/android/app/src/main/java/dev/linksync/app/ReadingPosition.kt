package dev.linksync.app

/** UI boundary for the percentage control; the store remains normalized to 0..1. */
object ReadingPosition {
    fun fromPercent(value: Int): Float = (value.coerceIn(0, 100) / 100f)
    fun toPercent(value: Float): Int = (value.coerceIn(0f, 1f) * 100f).toInt()
}
