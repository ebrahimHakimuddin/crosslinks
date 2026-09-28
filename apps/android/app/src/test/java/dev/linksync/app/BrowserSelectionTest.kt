package dev.linksync.app

import android.content.pm.ActivityInfo
import android.content.pm.ResolveInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class BrowserSelectionTest {
    @Test fun componentFilterExcludesOwnPackageAndKeepsOrder() {
        fun candidate(pkg: String, name: String): ResolveInfo = ResolveInfo().apply { activityInfo = ActivityInfo().apply { packageName = pkg; this.name = name } }
        val result = BrowserSelection.externalComponents("dev.linksync.app", listOf(candidate("dev.linksync.app", "Own"), candidate("com.chrome", "Chrome"), candidate("org.firefox", "Firefox")))
        assertEquals(listOf("com.chrome/Chrome", "org.firefox/Firefox"), result.map { "${it.packageName}/${it.className}" })
    }
}
