package dev.linksync.app

import org.junit.Assert.assertEquals
import org.junit.Test

class ReadingPositionTest {
    @Test fun clampsPercentAtUiBoundary() {
        assertEquals(0f, ReadingPosition.fromPercent(-1))
        assertEquals(1f, ReadingPosition.fromPercent(120))
        assertEquals(42, ReadingPosition.toPercent(.42f))
    }

    @Test fun restoresAnchorAndEncodesHyphenAndUnicode() {
        assertEquals("https://example.test/a#part:~:text=hello%2Dworld%20%E2%9C%93", TextFragmentRestore.restore("https://example.test/a#part", "hello-world ✓"))
        val existing = "https://example.test/a#:~:text=old"
        assertEquals(existing, TextFragmentRestore.restore(existing, "new"))
    }

    @Test fun preservesLiteralBackslash() {
        assertEquals("https://example.test/a#part:~:text=one%5Ctwo%2D%E2%9C%93", TextFragmentRestore.restore("https://example.test/a#part", "one\\two-✓"))
    }
}
